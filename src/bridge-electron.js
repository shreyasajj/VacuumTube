const {BridgeControl, listen} = require('./bridge-control')
const {ControlError, trustedFrame, sanitizeState} = require('./bridge-protocol')

function setup({electron, getWindow, runtime}) {
    let owner = null
    let transport = null
    const pending = new Map()
    const control = new BridgeControl({
        focus: async () => {
            const win = getWindow()
            if (!win || win.isDestroyed()) throw new ControlError('not_ready', 'No application window')
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
        },
        dispatch: (request) => new Promise((resolve, reject) => {
            if (!owner) { reject(new ControlError('not_ready', 'Leanback frame is unavailable')); return }
            const frame = owner
            const timer = setTimeout(() => {
                pending.delete(request.id)
                reject(new ControlError('command_timeout', 'Leanback did not acknowledge the command'))
            }, 20000)
            pending.set(request.id, {frame, resolve, reject, timer})
            try {
                frame.send('bigscreen-command', request)
            } catch {
                clearTimeout(timer)
                pending.delete(request.id)
                reject(new ControlError('not_ready', 'Leanback frame is unavailable'))
            }
        })
    })

    function invalidate() {
        owner = null
        control.invalidate()
        for (const item of pending.values()) {
            clearTimeout(item.timer)
            item.reject(new ControlError('not_ready', 'Leanback frame became unavailable'))
        }
        pending.clear()
    }

    electron.ipcMain.on('bigscreen-state', (event, payload) => {
        if (!trustedFrame(event, getWindow())) return
        const state = sanitizeState(payload)
        // Prefer the frame with the player when Leanback is embedded in a subframe.
        if (!owner || event.senderFrame === owner || state.media.video_id || !control.snapshot().media.video_id) {
            owner = event.senderFrame
            control.publish(state)
        }
    })
    electron.ipcMain.on('bigscreen-complete', (event, payload) => {
        if (!trustedFrame(event, getWindow()) || typeof payload?.id !== 'string') return
        const item = pending.get(payload.id)
        if (!item || event.senderFrame !== item.frame) return
        clearTimeout(item.timer)
        pending.delete(payload.id)
        if (payload.ok === true && ['video_selected', 'playlist_selected', 'search_opened', 'player_called'].includes(payload.result?.delivery)) {
            item.resolve({delivery: payload.result.delivery})
        } else {
            const code = ['unsupported', 'invalid_request', 'not_ready', 'navigation_failed'].includes(payload.error?.code) ? payload.error.code : 'command_failed'
            item.reject(new ControlError(code, 'Leanback command failed'))
        }
    })
    electron.ipcMain.on('bigscreen-gone', (event) => {
        if (trustedFrame(event, getWindow()) && event.senderFrame === owner) invalidate()
    })
    if (process.platform === 'linux') {
        listen(control, runtime).then((server) => { transport = server })
            .catch(() => console.error('Bigscreen local control is unavailable'))
    }
    electron.app.on('before-quit', () => { invalidate(); transport?.close() })
    return {watchWindow: (win) => {
        win.webContents.on('did-start-navigation', (event, url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate() })
        win.webContents.on('render-process-gone', invalidate)
        win.on('closed', invalidate)
    }}
}

module.exports = {setup}
