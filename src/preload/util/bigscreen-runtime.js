const {ipcRenderer} = require('electron')
const {navigationUrl} = require('../../bridge-protocol')
const playerControl = require('./bigscreen-player')
const resolveCommands = require('./resolveCommandModifiers')
const {MetadataCache} = require('./bigscreen-metadata')
const metadata = new MetadataCache()
const {confirmNavigation} = require('./bigscreen-navigation')

let volumeController = null
let navigate = null
let started = false

function setVolumeController(controller) {
    volumeController = controller
    publish()
}

function setNavigation(handler) {
    navigate = handler
    publish()
}

function view() {
    const route = new URL(location.hash.substring(1), location.href)
    const kind = ({'/watch': 'watch', '/playlist': 'playlist', '/results': 'search', '/search': 'search', '/tv': 'home'})[route.pathname]
    return {kind, query: route.searchParams.get('search_query') || route.searchParams.get('query') || (kind === 'search' ? metadata.searchQuery : null),
        playlist_id: route.searchParams.get('list'), video_id: route.searchParams.get('v')}
}

function contentTypes() {
    if (!navigate) return []
    return resolveCommands.canResolveCommand() ? ['video', 'playlist', 'search'] : ['video', 'playlist']
}

function publish() {
    try {
        const player = document.querySelector('.html5-video-player')
        const state = playerControl.snapshot(player)
        if (volumeController) {
            const volume = volumeController.snapshot()
            state.media.volume = volume.level
            state.media.muted = volume.muted
            state.capabilities.push('volume_set', 'volume_mute')
            const output = player?.getVolume?.()
            if (Number.isFinite(output)) state.media.output_volume = output / 100
        }
        if (state.media.video_id && !state.media.title) state.media.title = metadata.get(state.media.video_id)
        ipcRenderer.send('bigscreen-state', {...state, view: view(), ready: !!navigate,
            content_types: contentTypes()})
    } catch {
        ipcRenderer.send('bigscreen-state', {ready: !!navigate, content_types: contentTypes()})
    }
}

function deliverNavigation(request) {
    if (!navigate) throw Object.assign(new Error('Leanback listener is not ready'), {code: 'not_ready'})
    if (request.content_type === 'search') {
        if (!resolveCommands.tryResolveCommand({searchEndpoint: {query: request.content_id}})) {
            throw Object.assign(new Error('Search resolver is unavailable'), {code: 'not_ready'})
        }
    } else if (!navigate(navigationUrl(request.content_type, request.content_id))) {
        throw Object.assign(new Error('Leanback did not accept delivery'), {code: 'not_ready'})
    }
}


function start() {
    if (started) return
    started = true
    require('./jsonModifiers').addModifier((json) => { metadata.observe(json); return json })
    require('./xhrModifiers').addRequestModifier((url, body) => { metadata.observeRequest(url, body); return body })
    ipcRenderer.on('bigscreen-command', async (event, request) => {
        try {
            let result
            if (request.command === 'open') {
                result = {delivery: await confirmNavigation(request, {deliver: deliverNavigation,
                    read: () => ({view: view(), media: playerControl.snapshot(document.querySelector('.html5-video-player')).media})})}
            } else if (request.command === 'volume_set' || request.command === 'volume_mute') {
                if (!volumeController) throw Object.assign(new Error('Volume controller is unavailable'), {code: 'unsupported'})
                if (request.command === 'volume_set') volumeController.setLevel(request.volume_level)
                else volumeController.setMuted(request.muted)
                result = {delivery: 'player_called'}
            } else {
                result = playerControl.execute(document.querySelector('.html5-video-player'), request)
            }
            publish()
            ipcRenderer.send('bigscreen-complete', {id: request.id, ok: true, result})
        } catch (error) {
            ipcRenderer.send('bigscreen-complete', {id: request.id, ok: false,
                error: {code: ['unsupported', 'invalid_request', 'not_ready', 'navigation_failed'].includes(error.code) ? error.code : 'command_failed',
                    message: 'Leanback command could not be delivered'}})
        }
    })
    const timer = setInterval(publish, 1000)
    window.addEventListener('pagehide', () => { clearInterval(timer); ipcRenderer.send('bigscreen-gone') }, {once: true})
    publish()
}

module.exports = {start, setNavigation, setVolumeController}
