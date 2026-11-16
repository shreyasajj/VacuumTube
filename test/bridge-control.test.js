const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const {BridgeControl, listen} = require('../src/bridge-control')
const {validate, navigationUrl, sanitizeState, trustedFrame, ControlError} = require('../src/bridge-protocol')
const player = require('../src/preload/util/bigscreen-player')

const VIDEO = 'M7lc1UVf-VE'
const ready = {ready: true, content_types: ['video'], capabilities: ['pause', 'seek'],
    media: {video_id: VIDEO, title: 'Test', state: 'playing', duration: 120, position: 10}}

function makeControl(extra = {}) {
    return new BridgeControl({now: () => 10000, focus: async () => {}, dispatch: async () => ({delivery: 'player_called'}), ...extra})
}

test('validates typed IDs and builds only fixed YouTube URLs', () => {
    assert.equal(navigationUrl('video', VIDEO), `https://www.youtube.com/watch?v=${VIDEO}`)
    assert.equal(navigationUrl('search', 'cats & dogs'), 'https://www.youtube.com/results?search_query=cats%20%26%20dogs')
    for (const request of [null, [], {}, {id: 'a', command: 'eval'}, {id: 'a', command: 'focus', url: 'https://example.org'},
        {id: 'a', command: 'open', content_type: 'video', content_id: 'https://youtube.com/watch'},
        {id: 'a', command: 'seek', position: true}, {id: 'a', command: 'seek', position: Infinity},
        {id: 'a', command: 'open', content_type: 'search', content_id: '\nunsafe'}]) {
        assert.throws(() => validate(request), ControlError)
    }
})

test('sanitizes metadata and never trusts arbitrary artwork URLs or commands', () => {
    assert.deepEqual(sanitizeState(null).capabilities, [])
    assert.deepEqual(sanitizeState({content_types: {}, capabilities: 'seek'}).capabilities, [])
    const state = sanitizeState({...ready, media: {...ready.media, thumbnail: 'file:///private', extra: 'secret'},
        capabilities: ['eval', 'pause', 'seek', 'volume']})
    assert.deepEqual(state.capabilities, ['pause', 'seek'])
    assert.equal(state.media.thumbnail, `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`)
    assert.equal(state.media.extra, undefined)
    assert.deepEqual(sanitizeState({...ready, media: {video_id: 'invalid'}}).capabilities, [])
})

test('retries share an in-flight dispatch and replay an acknowledgement exactly once', async () => {
    let resolve
    let calls = 0
    const control = makeControl({dispatch: () => { calls++; return new Promise((done) => { resolve = done }) }})
    control.publish(ready)
    const request = {id: 'pause', command: 'pause'}
    const first = control.execute(request)
    const duplicate = control.execute(request)
    resolve({delivery: 'player_called'})
    assert.deepEqual(await first, await duplicate)
    assert.deepEqual(await control.execute(request), await first)
    assert.equal(calls, 1)
    assert.equal((await control.execute({id: 'pause', command: 'focus'})).error.code, 'invalid_request')
})

test('readiness failures can be retried, stale state drops control and seek is bounded', async () => {
    let now = 10000
    const control = makeControl({now: () => now})
    const request = {id: 'open', command: 'open', content_type: 'video', content_id: VIDEO}
    assert.equal((await control.execute(request)).error.code, 'not_ready')
    control.publish(ready)
    assert.equal((await control.execute(request)).ok, true)
    assert.equal((await control.execute({id: 'seek', command: 'seek', position: 121})).error.code, 'invalid_request')
    now += 5001
    assert.equal(control.snapshot().ready, false)
    assert.deepEqual(control.snapshot().capabilities, [])
    control.invalidate()
    assert.equal(control.snapshot().media.state, 'idle')
})

test('renderer state is accepted only from the current window and HTTPS Leanback frame', () => {
    const win = {isDestroyed: () => false, webContents: {}}
    const event = {sender: win.webContents, senderFrame: {url: 'https://www.youtube.com/tv'}}
    assert.equal(trustedFrame(event, win), true)
    assert.equal(trustedFrame({...event, sender: {}}, win), false)
    for (const url of ['http://www.youtube.com/tv', 'https://evil.example/tv', 'file:///tv', 'https://www.youtube.com/watch?v=x']) {
        assert.equal(trustedFrame({...event, senderFrame: {url}}, win), false)
    }
})

test('player commands use existing Leanback APIs and advertise only callable features', () => {
    const calls = []
    const current = {getVideoData: () => ({video_id: VIDEO, title: 'Example'}), getPlayerState: () => 1,
        getDuration: () => 100, getCurrentTime: () => 5, pauseVideo: () => calls.push('pause'),
        seekTo: (...args) => calls.push(args)}
    assert.deepEqual(player.snapshot(current).capabilities, ['pause', 'seek'])
    player.execute(current, {command: 'pause'})
    player.execute(current, {command: 'seek', position: 20})
    assert.deepEqual(calls, ['pause', [20, true]])
    assert.throws(() => player.execute(current, {command: 'seek', position: 101}), ControlError)
    assert.throws(() => player.execute(current, {command: 'play'}), ControlError)
})

function exchange(socketPath, text) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath)
        let response = ''
        socket.on('error', reject)
        socket.on('data', (data) => { response += data })
        socket.on('end', () => resolve(response ? JSON.parse(response) : null))
        socket.on('connect', () => socket.write(text))
    })
}

test('Unix transport is private, bounded and refuses an already-running endpoint', {skip: process.platform === 'win32'}, async (t) => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-control-'))
    t.after(() => fs.rmSync(runtime, {recursive: true, force: true}))
    const server = await listen(makeControl(), runtime)
    try {
        assert.equal(fs.statSync(path.dirname(server.socketPath)).mode & 0o777, 0o700)
        assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600)
        const response = await exchange(server.socketPath, JSON.stringify({id: 'state', command: 'get_state'}) + '\n')
        assert.equal(response.id, 'state')
        assert.equal(response.result.protocol, 1)
        assert.equal((await exchange(server.socketPath, '[]\n')).ok, false)
        assert.equal((await exchange(server.socketPath, '{}\n{}\n')).error.code, 'invalid_request')
        await assert.rejects(listen(makeControl(), runtime), /already in use/)
        assert.equal(await exchange(server.socketPath, 'x'.repeat(17000) + '\n'), null)
    } finally {
        await server.close()
    }
})

test('Unix transport rejects a symlink directory and a non-socket path', {skip: process.platform === 'win32'}, async (t) => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-unsafe-'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-target-'))
    t.after(() => { fs.rmSync(runtime, {recursive: true, force: true}); fs.rmSync(target, {recursive: true, force: true}) })
    fs.symlinkSync(target, path.join(runtime, 'bigscreen-bridge'))
    await assert.rejects(listen(makeControl(), runtime), /Unsafe runtime/)
    fs.unlinkSync(path.join(runtime, 'bigscreen-bridge'))
    fs.mkdirSync(path.join(runtime, 'bigscreen-bridge'))
    fs.writeFileSync(path.join(runtime, 'bigscreen-bridge/vacuumtube.sock'), 'do not replace')
    await assert.rejects(listen(makeControl(), runtime), /Unsafe socket/)
})

test('title cache matches IDs and observes public fields without mutating responses', () => {
    const {MetadataCache} = require('../src/preload/util/bigscreen-metadata')
    const cache = new MetadataCache()
    const response = {videoDetails: {videoId: VIDEO, title: 'Actual title'}, streamingData: {secret: 'never retained'}}
    const before = JSON.stringify(response)
    cache.observe(response)
    assert.equal(cache.get(VIDEO), 'Actual title')
    assert.equal(JSON.stringify(response), before)
    assert.equal(cache.get('other-video'), '')
    cache.observe({currentVideoEndpoint: {watchEndpoint: {videoId: VIDEO}},
        contents: {singleColumnWatchNextResults: {results: {results: {contents: [{itemSectionRenderer: {
            contents: [{videoMetadataRenderer: {title: {runs: [{text: 'Updated '}, {text: 'title'}]}}}]}}]}}}}})
    assert.equal(cache.get(VIDEO), 'Updated title')
    assert.equal(JSON.stringify([...cache.titles]).includes('secret'), false)
})

test('search query verification observes only the public query of actual search requests', () => {
    const {MetadataCache} = require('../src/preload/util/bigscreen-metadata')
    const cache = new MetadataCache()
    cache.observeRequest('/youtubei/v1/player', '{"query":"ignored"}')
    assert.equal(cache.searchQuery, null)
    const body = '{"query":"KDE Bigscreen","private":"not retained"}'
    cache.observeRequest('/youtubei/v1/search?key=unused', body)
    assert.equal(cache.searchQuery, 'KDE Bigscreen')
    assert.equal(JSON.stringify(cache).includes('not retained'), false)
})

test('cold navigation retries a discarded startup link until the requested view exists', async () => {
    const {confirmNavigation} = require('../src/preload/util/bigscreen-navigation')
    let now = 0
    let deliveries = 0
    const result = await confirmNavigation({content_type: 'video', content_id: VIDEO}, {
        now: () => now, delay: async (ms) => { now += ms }, deliver: () => deliveries++,
        read: () => ({view: deliveries >= 2 ? {kind: 'watch', video_id: VIDEO} : {kind: 'home'}, media: {}})
    })
    assert.equal(result, 'video_selected')
    assert.equal(deliveries, 2)
})

test('old player metadata alone cannot acknowledge navigation and failed links time out', async () => {
    const {confirmNavigation} = require('../src/preload/util/bigscreen-navigation')
    let now = 0
    await assert.rejects(confirmNavigation({content_type: 'video', content_id: VIDEO}, {
        now: () => now, delay: async (ms) => { now += ms }, deliver: () => {},
        read: () => ({view: {kind: 'search'}, media: {video_id: VIDEO}})
    }), (error) => error.code === 'navigation_failed')
})

test('search acknowledgement requires the actual query and catalogue commands serialize', async () => {
    const {confirmNavigation} = require('../src/preload/util/bigscreen-navigation')
    let now = 0
    const result = await confirmNavigation({content_type: 'search', content_id: 'KDE'}, {
        now: () => now, delay: async (ms) => { now += ms }, deliver: () => {},
        read: () => ({view: {kind: 'search', query: now < 600 ? 'old query' : 'KDE'}, media: {}})
    })
    assert.equal(result, 'search_opened')
    let finish
    const control = makeControl({dispatch: () => new Promise((resolve) => { finish = resolve })})
    control.publish(ready)
    const first = control.execute({id: 'pause-1', command: 'pause'})
    assert.equal((await control.execute({id: 'pause-2', command: 'pause'})).error.code, 'busy')
    assert.equal((await control.execute({id: 'state', command: 'get_state'})).ok, true)
    finish({delivery: 'player_called'})
    assert.equal((await first).ok, true)
})

test('volume schema preserves mute separately and permits idle app volume only with a controller', () => {
    assert.doesNotThrow(() => validate({id: 'level', command: 'volume_set', volume_level: 0.25}))
    assert.doesNotThrow(() => validate({id: 'mute', command: 'volume_mute', muted: true}))
    for (const volume_level of [-1, 2, NaN, Infinity, true, '0.5']) {
        assert.throws(() => validate({id: 'level', command: 'volume_set', volume_level}), ControlError)
    }
    assert.throws(() => validate({id: 'mute', command: 'volume_mute', muted: 1}), ControlError)
    const idle = sanitizeState({ready: true, capabilities: ['pause', 'volume_set', 'volume_mute'],
        media: {state: 'idle', volume: 0.5, muted: true, output_volume: 0}})
    assert.deepEqual(idle.capabilities, ['volume_set', 'volume_mute'])
    assert.equal(idle.media.volume, 0.5)
    assert.equal(idle.media.muted, true)
    assert.equal(idle.media.output_volume, 0)
})
