const {ControlError} = require('../../bridge-protocol')

// Retry only the fixed content request while Leanback completes its startup route.
async function confirmNavigation(request, {deliver, read, now = Date.now,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
    const startedAt = now()
    let lastDelivery = startedAt
    deliver(request)
    while (now() - startedAt < 18000) {
        const {view, media} = read()
        if (request.content_type === 'video' && view.kind === 'watch'
            && (view.video_id === request.content_id || media.video_id === request.content_id)) return 'video_selected'
        if (request.content_type === 'playlist' && (view.playlist_id === request.content_id || media.playlist_id === request.content_id)) return 'playlist_selected'
        if (request.content_type === 'search' && view.kind === 'search' && view.query === request.content_id) return 'search_opened'
        // A listener may exist while the first navigation transition still discards links.
        if (now() - lastDelivery >= 3000) {
            deliver(request)
            lastDelivery = now()
        }
        await delay(200)
    }
    throw new ControlError('navigation_failed', 'Leanback did not reach the requested content')
}

module.exports = {confirmNavigation}
