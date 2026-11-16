const {VIDEO_ID, ControlError} = require('../../bridge-protocol')

function snapshot(player) {
    const result = {media: {state: 'idle'}, capabilities: []}
    if (!player || typeof player.getVideoData !== 'function') return result
    const data = player.getVideoData()
    const videoId = data?.video_id
    if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return result
    const state = player.getPlayerState?.()
    result.media = {video_id: videoId, title: data.title,
        state: ({1: 'playing', 2: 'paused', 3: 'buffering'})[state] || 'idle',
        position: player.getCurrentTime?.(), duration: player.getDuration?.(), playlist_id: player.getPlaylistId?.()}
    if (state === 1 && typeof player.pauseVideo === 'function') result.capabilities.push('pause')
    if (state === 2 && typeof player.playVideo === 'function') result.capabilities.push('play')
    if (typeof player.stopVideo === 'function') result.capabilities.push('stop')
    if ([1, 2].includes(state) && Number.isFinite(result.media.duration) && result.media.duration > 0
        && typeof player.seekTo === 'function') result.capabilities.push('seek')
    return result
}

function execute(player, request) {
    const state = snapshot(player)
    if (!state.capabilities.includes(request.command)) throw new ControlError('unsupported', 'Player command is unavailable')
    if (request.command === 'seek') {
        if (typeof request.position !== 'number' || !Number.isFinite(request.position)
            || request.position < 0 || request.position > state.media.duration) throw new ControlError('invalid_request', 'Invalid seek position')
        player.seekTo(request.position, true)
    } else {
        player[{play: 'playVideo', pause: 'pauseVideo', stop: 'stopVideo'}[request.command]]()
    }
    return {delivery: 'player_called'}
}

module.exports = {snapshot, execute}
