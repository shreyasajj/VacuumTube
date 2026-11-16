const fs = require('fs')
const path = require('path')
const net = require('net')
const {ControlError, validate, sanitizeState} = require('./bridge-protocol')

const MAX_BYTES = 16384
const CACHE_SIZE = 128

function canonical(request) {
    return JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))
}

class BridgeControl {
    constructor({focus, dispatch, now = Date.now}) {
        this.focus = focus
        this.dispatch = dispatch
        this.now = now
        this.state = sanitizeState()
        this.updatedAt = 0
        this.cache = new Map()
        this.pending = new Map()
    }

    publish(state) {
        this.state = sanitizeState(state)
        this.updatedAt = this.now()
    }

    invalidate() {
        this.state = sanitizeState()
        this.updatedAt = 0
    }

    snapshot() {
        const fresh = this.updatedAt > 0 && this.now() - this.updatedAt < 5000
        return {...this.state, ready: fresh && this.state.ready,
            capabilities: fresh ? this.state.capabilities : [],
            media: fresh ? {...this.state.media, updated_at: new Date(this.updatedAt).toISOString()} : {state: 'idle'}}
    }

    async run(request) {
        if (request.command === 'get_state') return this.snapshot()
        if (request.command === 'focus') {
            await this.focus()
            return {delivery: 'focus_requested'}
        }
        const state = this.snapshot()
        if (!state.ready) throw new ControlError('not_ready', 'Leanback control is not ready')
        if (request.command === 'open') {
            if (!state.content_types.includes(request.content_type)) throw new ControlError('unsupported', 'Navigation type is unavailable')
        } else if (!state.capabilities.includes(request.command)) {
            throw new ControlError('unsupported', 'Player command is unavailable')
        }
        if (request.command === 'seek' && request.position > state.media.duration) throw new ControlError('invalid_request', 'Seek exceeds duration')
        return await this.dispatch(request)
    }

    async execute(request) {
        let id = typeof request?.id === 'string' ? request.id : null
        try {
            validate(request)
            const key = canonical(request)
            for (const entries of [this.cache, this.pending]) {
                if (!entries.has(id)) continue
                const previous = entries.get(id)
                if (previous.key !== key) throw new ControlError('invalid_request', 'Request ID reused with different data')
                return await previous.response
            }
            const mutating = !['get_state', 'focus'].includes(request.command)
            if (mutating && [...this.pending.values()].some((item) => item.mutating)) throw new ControlError('busy', 'Another player command is in progress')
            if (this.pending.size >= 16) throw new ControlError('busy', 'Too many pending commands')
            const response = this.run(request).then((result) => ({id, ok: true, result}))
                .catch((error) => ({id, ok: false, error: {code: error.code || 'command_failed',
                    message: error instanceof ControlError ? error.message : 'Application command failed'}}))
            this.pending.set(id, {key, response, mutating})
            const result = await response
            this.pending.delete(id)
            if (result.ok || !['not_ready', 'busy'].includes(result.error.code)) {
                this.cache.set(id, {key, response: result})
                while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value)
            }
            return result
        } catch (error) {
            return {id, ok: false, error: {code: error.code || 'invalid_request', message: error.message}}
        }
    }
}

async function listen(control, runtime = process.env.XDG_RUNTIME_DIR) {
    if (!runtime || !path.isAbsolute(runtime)) throw new Error('No private runtime directory')
    const directory = path.join(runtime, 'bigscreen-bridge')
    fs.mkdirSync(directory, {mode: 0o700, recursive: true})
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Unsafe runtime directory')
    fs.chmodSync(directory, 0o700)
    const socketPath = path.join(directory, 'vacuumtube.sock')
    if (fs.existsSync(socketPath)) {
        const previous = fs.lstatSync(socketPath)
        if (!previous.isSocket() || previous.uid !== process.getuid()) throw new Error('Unsafe socket path')
        const alive = await new Promise((resolve) => {
            const probe = net.createConnection(socketPath)
            probe.once('connect', () => { probe.destroy(); resolve(true) })
            probe.once('error', () => resolve(false))
            probe.setTimeout(1000, () => { probe.destroy(); resolve(true) })
        })
        if (alive) throw new Error('Control socket is already in use')
        fs.unlinkSync(socketPath)
    }
    const sockets = new Set()
    const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        socket.setTimeout(30000, () => socket.destroy())
        let buffer = Buffer.alloc(0)
        let received = false
        socket.on('data', async (chunk) => {
            if (received) return
            buffer = Buffer.concat([buffer, chunk])
            if (buffer.length > MAX_BYTES) { socket.destroy(); return }
            const newline = buffer.indexOf(10)
            if (newline < 0) return
            received = true
            socket.pause()
            try {
                if (buffer.subarray(newline + 1).toString().trim()) throw new Error('Only one request per connection')
                const request = JSON.parse(buffer.subarray(0, newline).toString())
                socket.end(JSON.stringify(await control.execute(request)) + '\n')
            } catch {
                socket.end(JSON.stringify({id: null, ok: false, error: {code: 'invalid_request', message: 'Expected one bounded JSON line'}}) + '\n')
            }
        })
    })
    server.maxConnections = 16
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    fs.chmodSync(socketPath, 0o600)
    const inode = fs.lstatSync(socketPath).ino
    return {socketPath, close: async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
        try {
            if (fs.lstatSync(socketPath).ino === inode) fs.unlinkSync(socketPath)
        } catch {}
    }}
}

module.exports = {BridgeControl, listen}
