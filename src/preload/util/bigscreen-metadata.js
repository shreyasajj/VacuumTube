const {VIDEO_ID} = require('../../bridge-protocol')

function text(value) {
    if (typeof value === 'string') return value
    if (typeof value?.simpleText === 'string') return value.simpleText
    return Array.isArray(value?.runs) ? value.runs.map((run) => typeof run.text === 'string' ? run.text : '').join('') : ''
}

// Observe only public title/ID fields from responses Leanback already requested.
class MetadataCache {
    constructor() { this.titles = new Map(); this.searchQuery = null }

    remember(id, title) {
        if (typeof id !== 'string' || !VIDEO_ID.test(id) || typeof title !== 'string' || !title.trim()) return
        this.titles.delete(id)
        this.titles.set(id, title.slice(0, 2048))
        while (this.titles.size > 64) this.titles.delete(this.titles.keys().next().value)
    }

    observe(json) {
        for (const candidate of [json, json?.playerResponse]) {
            this.remember(candidate?.videoDetails?.videoId, candidate?.videoDetails?.title)
        }
        const id = json?.currentVideoEndpoint?.watchEndpoint?.videoId
        const contents = json?.contents?.singleColumnWatchNextResults?.results?.results?.contents
        if (!Array.isArray(contents)) return
        for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents
            if (!Array.isArray(items)) continue
            for (const item of items) {
                const renderer = item?.videoMetadataRenderer || item?.musicWatchMetadataRenderer
                if (renderer) this.remember(id, text(renderer.title))
            }
        }
    }

    observeRequest(url, body) {
        if (typeof body !== 'string' || body.length > 1048576) return
        try {
            if (new URL(url, 'https://www.youtube.com').pathname !== '/youtubei/v1/search') return
            const query = JSON.parse(body).query
            if (typeof query === 'string' && query.length <= 200) this.searchQuery = query
        } catch {}
    }

    get(id) { return this.titles.get(id) || '' }
}

module.exports = {MetadataCache}
