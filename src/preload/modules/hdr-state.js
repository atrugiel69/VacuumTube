const { ipcRenderer } = require('electron')
const configManager = require('../config')
const jsonMod = require('../util/jsonModifiers')
const rcMod = require('../util/resolveCommandModifiers')

const STANDARD_RATES = [ 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120 ]
const itagFpsMap = new Map()
const knownShortIds = new Set()
let pendingShortId = null

function canonicalFps(raw) {
    const val = Number(raw)
    if (!Number.isFinite(val) || val < 10 || val > 240) return null;

    let best = STANDARD_RATES[0]
    let bestDiff = Math.abs(best - val)
    for (const rate of STANDARD_RATES) {
        const diff = Math.abs(rate - val)
        if (diff < bestDiff) {
            best = rate;
            bestDiff = diff;
        }
    }

    if (bestDiff <= 0.12) return best;
    return Number(val.toFixed(3));
}

function recordAdaptiveFormats(json) {
    const responses = [ json, json?.playerResponse ].filter(Boolean)
    for (const resp of responses) {
        const vid = resp?.videoDetails?.videoId || '';
        const formats = resp?.streamingData?.adaptiveFormats;
        if (!Array.isArray(formats)) continue;
        for (const f of formats) {
            const itag = Number(f?.itag)
            const fps = canonicalFps(f?.fps)
            if (itag > 0 && fps !== null) {
                itagFpsMap.set(`${vid}:${itag}`, fps)
            }
        }
    }
}

function isHdrCodec(codec) {
    let parts = codec.split('.')
    let transfer = parts[0] === 'vp09' ? parts[6] : (parts[0] === 'av01' ? parts[7] : undefined)
    return transfer === '16' || transfer === '18';
}

function isHdrMimeType(type) {
    let match = type.match(/codecs="([^"]+)"/i)
    if (!match) return false;
    for (let codec of match[1].split(',')) {
        if (isHdrCodec(codec.trim())) return true;
    }
    return false;
}

function isShortsPlayback() {
    try {
        if (document.body?.classList?.contains('WEB_PAGE_TYPE_SHORTS')) return true;
        if (document.querySelector('ytlr-shorts-page')?.classList?.contains('zylon-focus')) return true;
        const url = new URL(location.hash.substring(1), location.href)
        if (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/')) return true;
    } catch {}
    return false;
}

function getPlaybackContext() {
    const domIsShort = isShortsPlayback()
    try {
        const url = new URL(location.hash.substring(1), location.href)
        if (url.pathname === '/watch') {
            const vid = url.searchParams.get('v') || '';
            const isShort = domIsShort || (vid ? knownShortIds.has(vid) : pendingShortId !== null);
            return { videoId: vid || '__watch__', isShort };
        }
        if (domIsShort) {
            const parts = url.pathname.split('/').filter(Boolean)
            const shortId = parts[0] === 'shorts' && parts[1] ? parts[1] : '__shorts__';
            return { videoId: shortId, isShort: true };
        }
    } catch {}
    if (domIsShort) {
        return { videoId: '__shorts__', isShort: true };
    }
    return null;
}

function toUint8Array(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

function fourCC(view, offset) {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
}

// Parse ISO-BMFF (MP4) boxes for timescale (mdhd) and sample duration (trex/tfhd/trun)
function parseMp4Timing(bytes, state) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const containers = new Set([ 'moov', 'trak', 'mdia', 'mvex', 'moof', 'traf' ])

    function walk(start, end) {
        let off = start;
        while (off + 8 <= end) {
            let size = view.getUint32(off)
            const type = fourCC(view, off + 4)
            let headerSize = 8;

            if (size === 1) {
                if (off + 16 > end) break;
                const hi = view.getUint32(off + 8)
                const lo = view.getUint32(off + 12)
                size = hi * 4294967296 + lo;
                headerSize = 16;
            } else if (size === 0) {
                size = end - off;
            }

            if (size < headerSize || off + size > end) break;
            const body = off + headerSize;
            const boxEnd = off + size;

            if (containers.has(type)) {
                walk(body, boxEnd)
            } else if (type === 'mdhd' && body + 16 <= boxEnd) {
                const version = view.getUint8(body)
                if (version === 0 && body + 16 <= boxEnd) {
                    const ts = view.getUint32(body + 12)
                    if (ts > 0) state.timescale = ts;
                } else if (version === 1 && body + 24 <= boxEnd) {
                    const ts = view.getUint32(body + 20)
                    if (ts > 0) state.timescale = ts;
                }
            } else if (type === 'trex' && body + 16 <= boxEnd) {
                // FullBox (4) + track_ID (4) + default_sample_description_index (4) + default_sample_duration (4)
                const dur = view.getUint32(body + 12)
                if (dur > 0) state.sampleDuration = dur;
            } else if (type === 'tfhd' && body + 8 <= boxEnd) {
                const flags = (view.getUint8(body + 1) << 16) | (view.getUint8(body + 2) << 8) | view.getUint8(body + 3)
                let p = body + 8;
                if (flags & 0x000001) p += 8;
                if (flags & 0x000002) p += 4;
                if ((flags & 0x000008) && p + 4 <= boxEnd) {
                    const dur = view.getUint32(p)
                    if (dur > 0) state.sampleDuration = dur;
                }
            } else if (type === 'trun' && body + 8 <= boxEnd) {
                const flags = (view.getUint8(body + 1) << 16) | (view.getUint8(body + 2) << 8) | view.getUint8(body + 3)
                const count = view.getUint32(body + 4)
                let p = body + 8;
                if (flags & 0x000001) p += 4;
                if (flags & 0x000004) p += 4;
                if (count > 0 && (flags & 0x000100) && p + 4 <= boxEnd) {
                    const dur = view.getUint32(p)
                    if (dur > 0) state.sampleDuration = dur;
                }
            }

            off = boxEnd;
        }
    }

    walk(0, bytes.byteLength)
    if (state.timescale > 0 && state.sampleDuration > 0) {
        return canonicalFps(state.timescale / state.sampleDuration);
    }
    return null;
}

// Parse WebM EBML header for DefaultDuration (nanoseconds per frame)
function parseWebmFps(bytes) {
    function readId(pos) {
        if (pos >= bytes.length) return null;
        const first = bytes[pos]
        if (first === 0) return null;
        let len = 1;
        let mask = 0x80;
        while (len <= 4 && !(first & mask)) {
            mask >>= 1;
            len++;
        }
        if (len > 4 || pos + len > bytes.length) return null;
        let val = 0;
        for (let i = 0; i < len; i++) val = (val * 256) + bytes[pos + i]
        return { val, len };
    }

    function readSize(pos) {
        if (pos >= bytes.length) return null;
        const first = bytes[pos]
        if (first === 0) return null;
        let len = 1;
        let mask = 0x80;
        while (len <= 8 && !(first & mask)) {
            mask >>= 1;
            len++;
        }
        if (len > 8 || pos + len > bytes.length) return null;
        let val = first & (mask - 1)
        for (let i = 1; i < len; i++) val = (val * 256) + bytes[pos + i]
        return { val, len };
    }

    function readUint(pos, len) {
        let val = 0;
        for (let i = 0; i < len; i++) val = (val * 256) + bytes[pos + i]
        return val;
    }

    const containers = new Set([ 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE ])
    let defaultDurationNs = 0;

    function walk(start, end) {
        let p = start;
        while (p < end) {
            const id = readId(p)
            if (!id) break;
            const sz = readSize(p + id.len)
            if (!sz) break;
            const dataStart = p + id.len + sz.len;
            const elemEnd = Math.min(end, dataStart + sz.val)

            if (containers.has(id.val)) {
                walk(dataStart, elemEnd)
            } else if (id.val === 0x23E383 && sz.val > 0 && sz.val <= 8) {
                defaultDurationNs = readUint(dataStart, sz.val)
            }

            if (defaultDurationNs > 0) return;
            p = elemEnd;
        }
    }

    walk(0, Math.min(bytes.length, 65536))
    if (defaultDurationNs > 0) {
        return canonicalFps(1e9 / defaultDurationNs);
    }
    return null;
}

function getMetadataFps(player, videoId) {
    try {
        const stats = player?.getVideoStats?.()
        const fmt = Number(stats?.fmt)
        const resp = player?.getPlayerResponse?.()
        const respVid = resp?.videoDetails?.videoId || videoId || '';
        if (fmt > 0) {
            if (respVid && itagFpsMap.has(`${respVid}:${fmt}`)) {
                return itagFpsMap.get(`${respVid}:${fmt}`);
            }
            if (videoId && itagFpsMap.has(`${videoId}:${fmt}`)) {
                return itagFpsMap.get(`${videoId}:${fmt}`);
            }
            const formats = resp?.streamingData?.adaptiveFormats;
            if (Array.isArray(formats)) {
                const match = formats.find((f) => Number(f.itag) === fmt && Number(f.fps) > 0)
                if (match) return canonicalFps(Number(match.fps));
            }
            if (itagFpsMap.has(`:${fmt}`)) {
                return itagFpsMap.get(`:${fmt}`);
            }
        }
    } catch {}
    return null;
}

function isAdPlaying(player) {
    if (!player) return false;
    try {
        if (player.getAdState?.() === 1) return true;
    } catch {}
    return player.classList?.contains('ad-showing') || player.classList?.contains('ad-interrupting') || false;
}

module.exports = () => {
    rcMod.addInputModifier((c) => {
        if (c?.reelWatchEndpoint?.videoId) {
            const sid = String(c.reelWatchEndpoint.videoId)
            knownShortIds.add(sid)
            pendingShortId = sid;
        } else if (c?.watchEndpoint?.videoId) {
            knownShortIds.delete(String(c.watchEndpoint.videoId))
            pendingShortId = null;
        }
        return c;
    })

    jsonMod.addModifier((json) => {
        recordAdaptiveFormats(json)
        return json;
    })

    let streamIsHdr = false;
    let containerFps = null;
    let lastPayloadKey = null;

    let appliedFpsForSession = null;
    let appliedVideoId = null;
    let holdActive = false;
    let holdVideo = null;
    let holdTimer = null;
    let userPausedDuringHold = false;

    function clearHold(resume) {
        if (holdTimer) {
            clearTimeout(holdTimer)
            holdTimer = null;
        }
        const v = holdVideo;
        const shouldResume = resume && holdActive && !userPausedDuringHold && v && !v.ended;
        holdActive = false;
        holdVideo = null;
        userPausedDuringHold = false;

        if (shouldResume) {
            try {
                const p = v.play()
                if (p && typeof p.catch === 'function') p.catch(() => {})
            } catch {}
        }
    }

    function startHold(video, delaySec) {
        clearHold(false)
        if (!video || !(delaySec > 0)) return;

        holdActive = true;
        holdVideo = video;
        userPausedDuringHold = false;

        try {
            if (!video.paused) video.pause()
        } catch {}

        holdTimer = setTimeout(() => {
            clearHold(true)
        }, Math.round(delaySec * 1000))
    }

    document.addEventListener('play', (e) => {
        if (!holdActive || e.target !== holdVideo) return;
        userPausedDuringHold = false;
        try {
            e.target.pause()
        } catch {}
    }, true)

    document.addEventListener('keydown', (e) => {
        if (!holdActive) return;
        if (e.key === ' ' || e.key === 'MediaPlayPause' || e.key === 'MediaStop' || e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === 32769) {
            userPausedDuringHold = true;
        }
    }, true)

    function report(hdr, fps) {
        const cfg = configManager.get()
        const adjustFps = !!cfg.wayland_refresh_rate;
        const normalizedFps = adjustFps ? (fps ?? null) : null;
        const key = `${hdr ? 'hdr' : 'srgb'}|${adjustFps ? 1 : 0}|${normalizedFps ?? 'auto'}`;

        if (key === lastPayloadKey) return;
        lastPayloadKey = key;
        ipcRenderer.send('hdr-state', { hdr: !!hdr, fps: normalizedFps, adjustFps })
    }

    function evaluate() {
        const cfg = configManager.get()
        const playback = getPlaybackContext()
        const videoId = playback?.videoId ?? null;
        const isShort = !!playback?.isShort;
        const skipShorts = cfg.wayland_refresh_rate_skip_shorts !== false;
        const adjustFps = !!cfg.wayland_refresh_rate && !(isShort && skipShorts);

        if (!videoId) {
            clearHold(false)
            streamIsHdr = false;
            containerFps = null;
            appliedVideoId = null;
            appliedFpsForSession = null;
            report(false, null)
            return;
        }

        const player = document.querySelector('.html5-video-player')
        const video = player?.querySelector('video') || document.querySelector('video')

        if (!video || !video.currentSrc || video.ended) {
            clearHold(false)
            report(false, null)
            return;
        }

        if (isAdPlaying(player)) {
            report(false, null)
            return;
        }

        const stats = player?.getVideoStats?.()
        if (stats) {
            const colorInfo = String(stats.color || '')
            if (/smpte2084|arib-std-b67|bt2020/i.test(colorInfo)) {
                streamIsHdr = true;
            }
        }

        const effectiveFps = containerFps ?? getMetadataFps(player, videoId);

        if (adjustFps && effectiveFps !== null) {
            const needsModeSwitch = effectiveFps !== appliedFpsForSession;
            const isNewVideo = videoId !== appliedVideoId;

            if (needsModeSwitch || isNewVideo) {
                appliedVideoId = videoId;
                if (needsModeSwitch) {
                    appliedFpsForSession = effectiveFps;
                    const delaySec = Math.max(0, Math.min(10, Number(cfg.wayland_refresh_rate_delay) || 0))
                    if (delaySec > 0) {
                        startHold(video, delaySec)
                    }
                }
            }
        } else if (!adjustFps) {
            clearHold(true)
            if (isShort && skipShorts && cfg.wayland_refresh_rate) {
                const restoreDesktop = appliedFpsForSession !== null;
                appliedFpsForSession = null;
                appliedVideoId = null;
                if (restoreDesktop) {
                    const key = `${streamIsHdr ? 'hdr' : 'srgb'}|1|auto`;
                    if (key !== lastPayloadKey) {
                        lastPayloadKey = key;
                        ipcRenderer.send('hdr-state', { hdr: !!streamIsHdr, fps: null, adjustFps: true })
                    }
                    return;
                }
            } else {
                appliedFpsForSession = null;
                appliedVideoId = null;
            }
        }

        report(streamIsHdr, adjustFps ? effectiveFps : null)
    }

    function hookSourceBuffer() {
        if (!window.SourceBuffer || !SourceBuffer.prototype.appendBuffer || SourceBuffer.prototype.appendBuffer.vtHooked) return;

        const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
        SourceBuffer.prototype.appendBuffer = function (data) {
            if (this._vtIsVideo && !this._vtFps) {
                const bytes = toUint8Array(data)
                if (bytes && bytes.byteLength >= 16) {
                    let detected = null;
                    if (this._vtIsWebm) {
                        detected = parseWebmFps(bytes)
                    } else {
                        if (!this._vtMp4State) this._vtMp4State = { timescale: 0, sampleDuration: 0 }
                        detected = parseMp4Timing(bytes, this._vtMp4State)
                    }
                    if (detected !== null) {
                        this._vtFps = detected;
                        containerFps = detected;
                        queueMicrotask(evaluate)
                    }
                }
            }
            return origAppendBuffer.call(this, data);
        }
        SourceBuffer.prototype.appendBuffer.vtHooked = true;

        if (SourceBuffer.prototype.changeType) {
            const origChangeType = SourceBuffer.prototype.changeType;
            SourceBuffer.prototype.changeType = function (type) {
                const mime = String(type).trim().toLowerCase()
                if (mime.startsWith('video/')) {
                    this._vtIsVideo = true;
                    this._vtIsWebm = mime.includes('webm')
                    this._vtFps = null;
                    this._vtMp4State = null;
                    streamIsHdr = isHdrMimeType(type)
                    containerFps = null;
                    queueMicrotask(evaluate)
                }
                return origChangeType.call(this, type);
            }
        }
    }

    function hookMediaSource(ctor) {
        if (!ctor || !ctor.prototype || !ctor.prototype.addSourceBuffer) return;
        const origAddSourceBuffer = ctor.prototype.addSourceBuffer;
        ctor.prototype.addSourceBuffer = function (type) {
            const sb = origAddSourceBuffer.call(this, type)
            const mime = String(type).trim().toLowerCase()
            if (mime.startsWith('video/')) {
                sb._vtIsVideo = true;
                sb._vtIsWebm = mime.includes('webm')
                sb._vtFps = null;
                sb._vtMp4State = null;
                streamIsHdr = isHdrMimeType(type)
                containerFps = null;
                queueMicrotask(evaluate)
            }
            return sb;
        }
    }

    hookSourceBuffer()
    hookMediaSource(window.MediaSource)
    hookMediaSource(window.ManagedMediaSource)

    window.addEventListener('hashchange', () => {
        containerFps = null;
        evaluate()
    }, true)

    window.addEventListener('emptied', () => {
        clearHold(false)
        streamIsHdr = false;
        containerFps = null;
        evaluate()
    }, true)

    window.addEventListener('ended', () => {
        clearHold(false)
        evaluate()
    }, true)

    window.addEventListener('loadedmetadata', evaluate, true)
    window.addEventListener('playing', evaluate, true)

    ipcRenderer.on('config-update', () => {
        evaluate()
    })

    setInterval(evaluate, 500)
    report(false, null)
}
