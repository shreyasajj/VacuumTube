const { ipcRenderer } = require('electron')
const bigscreen = require('../../util/bigscreen-runtime')
const http = require('./dial/http')
const DialServer = require('./dial/server')
const discover = require('./dial/discover')
const configManager = require('../../config')
const config = configManager.get()

function getMaxResolution() {
    let resolutions = [ '256x144', '426x240', '640x360', '854x480', '1280x720', '1920x1080', '2560x1440', '3840x2160', '7680x4320' ]
    let screenWidth = Math.max(window.screen.width, window.screen.height)
    let screenHeight = Math.min(window.screen.width, window.screen.height)

    for (let i = 0; i < resolutions.length; i++) {
        let [ width, height ] = resolutions[i].split('x').map(Number)
        if (screenWidth <= width && screenHeight <= height) return resolutions[i];
    }

    return `${window.screen.width}x${window.screen.height}`;
}

async function waitForDeviceId() {
    let start = Date.now()
    while ((Date.now() - start) < 10000) {
        try {
            let json = localStorage.getItem('yt.leanback.default::mdx-device-id')
            let id = JSON.parse(json)?.data;
            if (id && typeof id === 'string') return;
        } catch {}

        await new Promise((resolve) => setTimeout(resolve, 50))
    }

    console.warn('[h5vcc] DIAL: Device ID not available after waiting, using fallback UUID')
}

async function startDial() {
    if (!config.device_discoverability) return;

    try {
        await waitForDeviceId()
        await http.listen()
        discover.start()

        console.log('[h5vcc] DIAL: Server started')
    } catch (err) {
        console.error('[h5vcc] DIAL: Failed to start server', err)
    }
}

function createOnDeepLink() {
    let listeners = []
    let pending = [] //deeplinks that arrived before leanback called addListener

    function callListener(listener, deeplink) {
        try {
            listener(deeplink)
            return true
        } catch (err) {
            console.error('[h5vcc] Deeplink listener failed', err)
            return false
        }
    }

    ipcRenderer.on('deeplink', (event, deeplink) => {
        if (listeners.length === 0) {
            pending.push(deeplink)
            return;
        }

        for (let listener of listeners) {
            callListener(listener, deeplink)
        }
    })

    return {
        addListener: (listener) => {
            if (typeof listener !== 'function') return
            listeners.push(listener)
            bigscreen.setNavigation((deeplink) => {
                let delivered = false
                for (const target of listeners) delivered = callListener(target, deeplink) || delivered
                return delivered
            })
            while (pending.length > 0) {
                callListener(listener, pending.shift())
            }
        }
    };
}

module.exports = async () => {
    const initialDeepLink = await ipcRenderer.invoke('get-deeplink')
    const maxResolution = getMaxResolution()

    window.h5vcc = {
        dial: { DialServer },
        runtime: {
            initialDeepLink,
            onDeepLink: createOnDeepLink()
        },
        system: {
            getVideoContainerSizeOverride: () => { //unlock high res
                return config.unlock_resolution ? '7680x4320' : maxResolution;
            }
        }
    }

    startDial()
}