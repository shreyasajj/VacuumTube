// Fixed-schema local commands. Never accept renderer code, filesystem paths or URLs.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,128}$/
const COMMANDS = ['get_state', 'focus', 'open', 'play', 'pause', 'stop', 'seek', 'volume_set', 'volume_mute']
const PLAYER_COMMANDS = ['play', 'pause', 'stop', 'seek', 'volume_set', 'volume_mute']
const CONTENT_TYPES = ['video', 'playlist', 'search']

class ControlError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

function validate(request) {
    const invalid = (message) => { throw new ControlError('invalid_request', message) }
    if (!request || typeof request !== 'object' || Array.isArray(request)) invalid('Expected a JSON object')
    if (typeof request.id !== 'string' || !request.id.length || request.id.length > 128) invalid('A bounded string request ID is required')
    if (!COMMANDS.includes(request.command)) throw new ControlError('unsupported', 'Unsupported command')
    const allowed = ['id', 'command']
    if (request.command === 'open') allowed.push('content_type', 'content_id')
    if (request.command === 'seek') allowed.push('position')
    if (request.command === 'volume_set') allowed.push('volume_level')
    if (request.command === 'volume_mute') allowed.push('muted')
    if (Object.keys(request).some((key) => !allowed.includes(key))) invalid('Unknown request fields')
    if (request.command === 'seek' && (typeof request.position !== 'number' || !Number.isFinite(request.position) || request.position < 0)) invalid('Invalid seek position')
    if (request.command === 'volume_set' && (typeof request.volume_level !== 'number' || !Number.isFinite(request.volume_level) || request.volume_level < 0 || request.volume_level > 1)) invalid('Volume must be between zero and one')
    if (request.command === 'volume_mute' && typeof request.muted !== 'boolean') invalid('Muted must be boolean')
    if (request.command === 'open') {
        const value = request.content_id
        if (!CONTENT_TYPES.includes(request.content_type)) throw new ControlError('unsupported', 'Unsupported content type')
        if (typeof value !== 'string') invalid('Content ID must be a string')
        if (request.content_type === 'video' && !VIDEO_ID.test(value)) invalid('Invalid YouTube video ID')
        if (request.content_type === 'playlist' && !PLAYLIST_ID.test(value)) invalid('Invalid YouTube playlist ID')
        if (request.content_type === 'search' && (!value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) invalid('Invalid search text')
    }
    return request
}

function navigationUrl(type, value) {
    validate({id: 'url', command: 'open', content_type: type, content_id: value})
    if (type === 'video') return 'https://www.youtube.com/watch?v=' + encodeURIComponent(value)
    if (type === 'playlist') return 'https://www.youtube.com/playlist?list=' + encodeURIComponent(value)
    return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(value)
}

function sanitizeState(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}
    const contentTypes = Array.isArray(input.content_types) ? input.content_types : []
    const capabilities = Array.isArray(input.capabilities) ? input.capabilities : []
    const state = {protocol: 1, ready: input.ready === true, content_types: [], capabilities: [], media: {state: 'idle'}}
    state.content_types = CONTENT_TYPES.filter((type) => contentTypes.includes(type))
    const view = input.view || {}
    if (['watch', 'playlist', 'search', 'home'].includes(view.kind)) {
        state.view = {kind: view.kind}
        if (typeof view.video_id === 'string' && VIDEO_ID.test(view.video_id)) state.view.video_id = view.video_id
        if (typeof view.query === 'string' && view.query.length <= 200) state.view.query = view.query
        if (typeof view.playlist_id === 'string' && PLAYLIST_ID.test(view.playlist_id)) state.view.playlist_id = view.playlist_id
    }
    const media = input.media || {}
    if (typeof media.video_id === 'string' && VIDEO_ID.test(media.video_id)) {
        if (typeof media.playlist_id === 'string' && PLAYLIST_ID.test(media.playlist_id)) state.media.playlist_id = media.playlist_id
        state.media.video_id = media.video_id
        state.media.title = typeof media.title === 'string' ? media.title.slice(0, 2048) : ''
        state.media.thumbnail = `https://i.ytimg.com/vi/${media.video_id}/hqdefault.jpg`
        state.media.state = ['playing', 'paused', 'buffering'].includes(media.state) ? media.state : 'idle'
        for (const key of ['position', 'duration']) {
            if (typeof media[key] === 'number' && Number.isFinite(media[key]) && media[key] >= 0) state.media[key] = media[key]
        }
    }
    for (const key of ['volume', 'output_volume']) {
        if (typeof media[key] === 'number' && Number.isFinite(media[key]) && media[key] >= 0 && media[key] <= 1) state.media[key] = media[key]
    }
    if (typeof media.muted === 'boolean') state.media.muted = media.muted
    state.capabilities = PLAYER_COMMANDS.filter((command) => {
        if (!capabilities.includes(command)) return false
        if (command === 'volume_set') return state.media.volume !== undefined
        if (command === 'volume_mute') return state.media.volume !== undefined && state.media.muted !== undefined
        return !!state.media.video_id && (command !== 'seek' || state.media.duration > 0)
    })
    return state
}

function trustedFrame(event, win) {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
    try {
        const url = new URL(event.senderFrame.url)
        return url.protocol === 'https:' && url.hostname === 'www.youtube.com' && !url.port && url.pathname === '/tv'
    } catch {
        return false
    }
}

module.exports = {ControlError, validate, navigationUrl, sanitizeState, trustedFrame, VIDEO_ID}
