const { ipcRenderer } = require('electron')

function isHdrCodec(codec) {
    let parts = codec.split('.')
    let transfer = parts[0] === 'vp09' ? parts[6] : (parts[0] === 'av01' ? parts[7] : undefined)
    return transfer === '16' || transfer === '18';
}

function isHdrMimeType(type) {
    let params = String(type).split(';').slice(1)
    for (let param of params) {
        let [ key, ...rest ] = param.split('=')
        if (key.trim().toLowerCase() === 'codecs') {
            let value = rest.join('=').trim().replace(/^"|"$/g, '')
            return value.split(',').some(c => isHdrCodec(c.trim()));
        }
    }
    return false;
}

function isWatchPage() {
    try {
        return new URL(location.hash.substring(1), location.href).pathname === '/watch';
    } catch {
        return false;
    }
}

module.exports = () => {
    let streamIsHdr = false;
    let lastReported = null;

    function report(hdr) {
        if (hdr === lastReported) return;
        lastReported = hdr;
        ipcRenderer.send('hdr-state', hdr)
    }

    function evaluate() {
        if (!isWatchPage()) {
            streamIsHdr = false;
            report(false)
            return;
        }

        let video = document.querySelector('.html5-video-player video')
        if (!video || !video.currentSrc || video.ended) {
            report(false)
            return;
        }

        let player = document.querySelector('.html5-video-player')
        let stats = player?.getVideoStats?.()
        if (stats) {
            let colorInfo = String(stats.color || '')
            if (/smpte2084|arib-std-b67|bt2020/i.test(colorInfo)) {
                streamIsHdr = true;
            }
        }

        report(streamIsHdr)
    }

    function hookMediaSource(ctor) {
        if (!ctor || !ctor.prototype || !ctor.prototype.addSourceBuffer) return;
        const origAddSourceBuffer = ctor.prototype.addSourceBuffer;
        ctor.prototype.addSourceBuffer = function (type) {
            let mime = String(type).trim().toLowerCase()
            if (mime.startsWith('video/')) {
                streamIsHdr = isHdrMimeType(type);
                queueMicrotask(evaluate)
            }
            return origAddSourceBuffer.call(this, type);
        }
    }

    hookMediaSource(window.MediaSource)
    hookMediaSource(window.ManagedMediaSource)

    if (window.SourceBuffer && SourceBuffer.prototype.changeType) {
        const origChangeType = SourceBuffer.prototype.changeType;
        SourceBuffer.prototype.changeType = function (type) {
            let mime = String(type).trim().toLowerCase()
            if (mime.startsWith('video/')) {
                streamIsHdr = isHdrMimeType(type);
                queueMicrotask(evaluate)
            }
            return origChangeType.call(this, type);
        }
    }

    window.addEventListener('hashchange', evaluate, true)
    window.addEventListener('emptied', () => {
        streamIsHdr = false;
        evaluate()
    }, true)
    window.addEventListener('ended', evaluate, true)
    window.addEventListener('loadedmetadata', evaluate, true)
    window.addEventListener('playing', evaluate, true)

    setInterval(evaluate, 500)
    report(false)
}
