const RoonApi = require("node-roon-api");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiSettings = require("node-roon-api-settings");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiImage = require("node-roon-api-image");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");

// --- Extension Metadata ---
const EXT_VERSION = 'v1.10.0';
const EXT_ID = 'com.colseverinus.tuneshine.roon';
const EXT_NAME = 'Tuneshine Roon Controller';
const EXT_PUBLISHER = 'Matt Philpot';
const EXT_EMAIL = 'col.severinus@gmail.com';
const EXT_WEBSITE = 'https://everydayaudiophile.com';

// --- Networking ---
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 3000 });

const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
process.chdir(configDir);

/**
 * Startup Purge: Destroys stale transition frames from previous crashed sessions.
 */
function purgeTempFiles() {
    fs.readdirSync(configDir).forEach(file => {
        if (file.endsWith('.jpg') && file.startsWith('trans_')) {
            try { fs.unlinkSync(path.join(configDir, file)); } catch (e) {}
        }
    });
}
purgeTempFiles();

function log(msg) {
    const now = new Date();
    const ts = `${now.toISOString().replace('T', ' ').substring(0, 19)}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    console.log(`[${ts}] ${msg}`);
}

function errLog(msg) {
    const now = new Date();
    const ts = `${now.toISOString().replace('T', ' ').substring(0, 19)}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    console.error(`[${ts}] ${msg}`);
}

/**
 * Resolves the host-accessible IP address for the proxy server.
 * Prefers the HOST_IP env var (for Docker), then the first non-internal IPv4
 * address, skipping virtual Docker/bridge/veth interfaces.
 * @returns {string} IPv4 address or '127.0.0.1' as a last resort.
 */
function getLocalIp() {
    if (process.env.HOST_IP) return process.env.HOST_IP;
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth')) continue;
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

let core = null;
let proxyPort = process.env.PORT || 8090;
let zones = {};
let lastImageKey = null;
let preDimmedBackgroundJimp = null; 
let font16 = null; 
let font8 = null; 

// RAM Pre-Heating
Jimp.loadFont(Jimp.FONT_SANS_16_WHITE).then(f => font16 = f).catch(e => errLog(`[Boot] Font16 load failed: ${e.message}`));
Jimp.loadFont(Jimp.FONT_SANS_8_WHITE).then(f => font8 = f).catch(e => errLog(`[Boot] Font8 load failed: ${e.message}`));

let displayState = 'PLAYING';
let stateTimer = null;
let clockSyncTimer = null;
let integrityInterval = null;
let currentTrackName = "";
let currentArtistName = "";

let transitionTimers = []; 
let activeTransitionId = null; 
let activeTransitionState = null; 
let transitionWatchdog = null;

/**
 * Immediately kills all in-flight transition activity: pending stage timers,
 * the hardware watchdog, and the global transition ID/state. Called on track
 * change, pause, stop, and unpair to prevent stale async branches from
 * corrupting the display.
 */
function clearTransitions() {
    transitionTimers.forEach(t => clearTimeout(t));
    transitionTimers = [];
    if (transitionWatchdog) clearTimeout(transitionWatchdog);
    activeTransitionId = null;
    activeTransitionState = null;
}

// --- HARDENED HTTP PROXY ---
const server = http.createServer((req, res) => {
    const requestUrl = req.url;
    const pathname = requestUrl.split('?')[0];
    
    log(`[Proxy] GET: ${requestUrl}`);

    res.on('finish', () => {
        checkTransitionAdvance(requestUrl);
    });
    
    if (pathname.startsWith('/image/clock.png') || pathname.startsWith('/image/pause.png')) {
        const gen = pathname.includes('clock') ? generateClockBuffer() : generatePauseBuffer();
        gen.then(buf => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
            res.end(buf);
        }).catch(() => { res.writeHead(500); res.end(); });
        return;
    }

    // AUDIT FIX: Dedicated route for tracks with no artwork
    if (pathname.startsWith('/image/no_art.png')) {
        let image = new Jimp(64, 64, 0x111111FF);
        if (font8) {
            image.print(font8, 2, 20, currentTrackName.substring(0, 14));
            image.print(font8, 2, 40, currentArtistName.substring(0, 14));
        }
        image.getBufferAsync(Jimp.MIME_PNG).then(buf => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
            res.end(buf);
        }).catch(() => { res.writeHead(500); res.end(); });
        return;
    }

    if (pathname.startsWith('/image/trans_')) {
        const filename = path.basename(pathname);
        const filepath = path.join(configDir, filename);
        if (fs.existsSync(filepath)) {
            const stat = fs.statSync(filepath);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
            const stream = fs.createReadStream(filepath);
            stream.pipe(res);
            
            // AUDIT FIX: Prevent File Descriptor leaks if ESP32 aborts download
            req.on('close', () => { if (!stream.destroyed) stream.destroy(); });
        } else {
            errLog(`[Proxy] 404 Missing File: ${filename}`);
            res.writeHead(404); res.end();
        }
        return;
    }

    if (pathname.startsWith('/image/')) {
        const key = path.basename(pathname).split('.')[0];
        if (core && key) {
            core.services.RoonApiImage.get_image(key, { scale: 'fill', width: 256, height: 256, format: 'image/jpeg' }, async (err, contentType, imgBuffer) => {
                if (err || !imgBuffer) { res.writeHead(500); res.end(); return; }
                try {
                    let jimpImg = await Jimp.read(imgBuffer);
                    jimpImg = await normalizeImageForLED(jimpImg);
                    const outBuf = await jimpImg.quality(90).getBufferAsync(Jimp.MIME_JPEG);
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': outBuf.length });
                    res.end(outBuf);
                } catch (e) {
                    // AUDIT FIX: Break the Infinite Healing Loop by falling back to the raw Roon buffer
                    errLog(`[Proxy] Normalization failed, serving raw buffer fallback: ${e.message}`);
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgBuffer.length });
                    res.end(imgBuffer);
                }
            });
        } else {
            res.writeHead(503); res.end();
        }
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(proxyPort, () => log(`[Server] ${EXT_VERSION} listening on port ${proxyPort}`));

/**
 * Sends a JSON POST to the Tuneshine ESP32 over the shared keep-alive socket.
 * Explicitly sets Content-Length, drains the response for socket reuse, and
 * destroys the socket on timeout to prevent LwIP stack exhaustion.
 * @param {string} endpoint - The ESP32 route (e.g. '/image', '/brightness').
 * @param {Object} body - JSON-serializable payload.
 */
async function postToTuneshine(endpoint, body) {
    const host = mysettings.tuneshine_host;
    if (!host) return;
    const payload = JSON.stringify(body);
    try {
        const options = {
            hostname: host, path: endpoint, method: 'POST',
            agent: keepAliveAgent, 
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 4000
        };
        const req = http.request(options, (res) => { res.resume(); });
        req.on('error', (e) => errLog(`[Post Error] ${e.message}`));
        
        // AUDIT FIX: Node.js does not automatically close sockets on timeout. Must be explicit.
        req.on('timeout', () => {
            errLog(`[Post Timeout] Tuneshine unresponsive. Destroying socket.`);
            req.destroy();
        });
        
        req.write(payload);
        req.end();
    } catch (e) {
        errLog(`[Post Fatal] Synchronous HTTP error: ${e.message}`);
    }
}

/**
 * Reactive Daisy-Chain Sequencer callback. Fired by the proxy's res.on('finish')
 * event after the ESP32 successfully fetches a transition frame.
 * Advances the stage index, enforces the 150ms "breather" delay, arms the
 * per-stage hardware watchdog, and dispatches the next frame POST.
 * If the final stage was just fetched, clears the transition state.
 * @param {string} fetchedUrl - The proxy request URL that was just served.
 */
function checkTransitionAdvance(fetchedUrl) {
    if (displayState !== 'PLAYING' || !activeTransitionState) return;
    const currentStage = activeTransitionState.stages[activeTransitionState.currentStageIndex];
    if (!currentStage) return;

    if (currentStage.url.endsWith(fetchedUrl)) {
        if (transitionWatchdog) clearTimeout(transitionWatchdog);
        activeTransitionState.currentStageIndex++;
        const nextStage = activeTransitionState.stages[activeTransitionState.currentStageIndex];
        
        if (nextStage) {
            const timerId = setTimeout(() => {
                if (displayState === 'PLAYING' && activeTransitionId === activeTransitionState.id) {
                    const watchdogTimeout = currentStage.delayAfterFetch + 5000;
                    const thisTransitionId = activeTransitionId;

                    transitionWatchdog = setTimeout(() => {
                        if (activeTransitionId === thisTransitionId) {
                            errLog(`[Watchdog] Hardware timeout. Forcing sharp art.`);
                            pushStaticImageToTuneshine(activeTransitionState.track, activeTransitionState.artist, lastImageKey);
                        }
                    }, watchdogTimeout);

                    log(`[API] Pushing Stage: ${nextStage.name}`);
                    postToTuneshine('/image', { 
                        trackName: activeTransitionState.track, 
                        artistName: activeTransitionState.artist,
                        idle: false, imageUrl: nextStage.url 
                    });
                }
            }, currentStage.delayAfterFetch + 150); 
            transitionTimers.push(timerId);
        } else {
            activeTransitionState = null; 
        }
    }
}

/**
 * Periodic health-check (20s interval). Polls the Tuneshine's /state endpoint
 * for lastImageError. If the hardware reports a decode failure, re-pushes the
 * correct image for the current display state to heal the display.
 */
async function checkHardwareIntegrity() {
    if (!mysettings.tuneshine_host || !core) return;
    try {
        const options = { hostname: mysettings.tuneshine_host, path: '/state', method: 'GET', agent: keepAliveAgent, timeout: 2000 };
        const intReq = http.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const state = JSON.parse(data);
                        if (state.localMetadata && state.localMetadata.lastImageError) {
                            errLog(`[Integrity] Healing hardware error: ${state.localMetadata.lastImageError}`);
                            if (displayState === 'PLAYING' && currentTrackName && lastImageKey) {
                                pushStaticImageToTuneshine(currentTrackName, currentArtistName, lastImageKey);
                            } else if (displayState === 'PAUSED') {
                                postToTuneshine('/image', { trackName: "Paused", idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/pause.png?t=${Date.now()}` });
                            } else if (displayState === 'CLOCK' || displayState === 'DEEP_IDLE') {
                                pushClockToTuneshine();
                            }
                        }
                    } catch (pe) {
                        errLog(`[Integrity] Malformed JSON from hardware: ${pe.message}`);
                    }
                }
            });
        });
        intReq.on('timeout', () => { errLog(`[Integrity] Hardware timeout. Destroying socket.`); intReq.destroy(); });
        intReq.on('error', (e) => { errLog(`[Integrity] Hardware unreachable: ${e.message}`); });
    } catch (e) {
        errLog(`[Integrity] Fatal: ${e.message}`);
    }
}

/**
 * Sovereign Normalization Engine v7.2.
 * Analyzes luminance histogram and saturation to compute an "energy" score,
 * then applies a proportional 1/x correction curve:
 *   - Soft Black Crush: minLum * 0.4 * strength floor reduction.
 *   - Contrast boost: up to 15% proportional to strength.
 *   - Saturation boost: up to 10% proportional to strength.
 * Bypassed entirely when mysettings.enable_normalization is false.
 * @param {Jimp} jimpImage - The source image to normalize (mutated in place).
 * @returns {Promise<Jimp>} The normalized image.
 */
async function normalizeImageForLED(jimpImage) {
    if (!mysettings.enable_normalization) return jimpImage;
    const histogram = new Array(256).fill(0);
    let totalSat = 0;
    const pixelCount = jimpImage.bitmap.width * jimpImage.bitmap.height;

    jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, function(x, y, idx) {
        const r = this.bitmap.data[idx+0], g = this.bitmap.data[idx+1], b = this.bitmap.data[idx+2];
        const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        histogram[lum]++;
        const avg = (r + g + b) / 3;
        totalSat += Math.sqrt(((r - avg) ** 2 + (g - avg) ** 2 + (b - avg) ** 2) / 3);
    });

    let minLum = 0, maxLum = 255, count = 0;
    const threshold = pixelCount * 0.01;
    for (let i = 0; i < 256; i++) { count += histogram[i]; if (count >= threshold) { minLum = i; break; } }
    count = 0;
    for (let i = 255; i >= 0; i--) { count += histogram[i]; if (count >= threshold) { maxLum = i; break; } }

    const avgSat = totalSat / pixelCount;
    const energy = (((maxLum - minLum) / 255) * 0.5) + (Math.min(1, avgSat / 30) * 0.5);
    const strength = Math.min(1, Math.pow(Math.max(0, (1 / Math.max(0.1, energy)) - 1), 0.7));

    if (strength > 0.05) {
        const floorCrush = minLum * 0.4 * strength;
        jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, function(x, y, idx) {
            const r = this.bitmap.data[idx+0], g = this.bitmap.data[idx+1], b = this.bitmap.data[idx+2];
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b);
            const ratio = Math.max(0, lum - floorCrush) / Math.max(1, lum);
            this.bitmap.data[idx+0] = Math.max(0, Math.min(255, r * ratio));
            this.bitmap.data[idx+1] = Math.max(0, Math.min(255, g * ratio));
            this.bitmap.data[idx+2] = Math.max(0, Math.min(255, b * ratio));
        });
        jimpImage.contrast(0.15 * strength);
        jimpImage.color([{ apply: 'saturate', params: [10 * strength] }]);
    }
    return jimpImage;
}

var roon = new RoonApi({
    extension_id: EXT_ID,
    display_name: EXT_NAME,
    display_version: EXT_VERSION,
    publisher: EXT_PUBLISHER,
    email: EXT_EMAIL,
    website: EXT_WEBSITE,
    log_level: 'none',
    core_paired: function(core_) {
        core = core_;
        svc_status.set_status("Paired", false);
        updateBrightness();
        if (integrityInterval) clearInterval(integrityInterval);
        integrityInterval = setInterval(checkHardwareIntegrity, 20000);
        core.services.RoonApiTransport.subscribe_zones((response, data) => {
            if (response === "Subscribed") {
                zones = data.zones.reduce((acc, z) => { acc[z.zone_id] = z; return acc; }, {});
                checkZone(data.zones);
            } else if (response === "Changed") {
                if (data.zones_added) data.zones_added.forEach(z => zones[z.zone_id] = z);
                if (data.zones_changed) data.zones_changed.forEach(z => zones[z.zone_id] = z);
                checkZone(data.zones_changed || []);
            }
        });
    },
    core_unpaired: function() {
        log("[Core] Unpaired. Falling back to Clock.");
        core = null;
        if (integrityInterval) clearInterval(integrityInterval);
        clearTransitions();
        enterClockMode();
    }
});

let loadedSettings = roon.load_config("settings") || {};
var mysettings = {
    tuneshine_host: loadedSettings.tuneshine_host || "",
    zone_id: loadedSettings.zone_id || null,
    enable_normalization: loadedSettings.enable_normalization ?? true,
    new_album_steps: loadedSettings.new_album_steps ?? 2,
    intra_album_steps: loadedSettings.intra_album_steps ?? 1,
    dissolve_delay: loadedSettings.dissolve_delay ?? 1000,
    active_brightness: loadedSettings.active_brightness ?? 80,
    idle_brightness: loadedSettings.idle_brightness ?? 20,
    clock_timeout: loadedSettings.clock_timeout ?? 60,
    deep_idle_timeout: loadedSettings.deep_idle_timeout ?? 10 
};

var svc_status = new RoonApiStatus(roon);
var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        let zone_dropdown = [{ title: "Select Zone...", value: null }];
        Object.values(zones).forEach(z => zone_dropdown.push({ title: z.display_name, value: z.zone_id }));
        cb({
            values: mysettings,
            layout: [
                { type: "string", title: "Tuneshine Host / IP", setting: "tuneshine_host" },
                { type: "dropdown", title: "Zone to Monitor", setting: "zone_id", values: zone_dropdown },
                { type: "boolean", title: "Enable Image Normalization", setting: "enable_normalization" },
                { type: "integer", title: "New Album Blur Steps (0-5)", setting: "new_album_steps", min: 0, max: 5 },
                { type: "integer", title: "Intra-Album Blur Steps (0-5)", setting: "intra_album_steps", min: 0, max: 5 },
                { type: "integer", title: "Hardware Dissolve Delay (800-5000ms)", setting: "dissolve_delay", min: 800, max: 5000 },
                { type: "integer", title: "Clock Timeout (5-3600s)", setting: "clock_timeout", min: 5, max: 3600 },
                { type: "integer", title: "Deep Idle Timeout (1-1440m)", setting: "deep_idle_timeout", min: 1, max: 1440 },
                { type: "integer", title: "Active Brightness (1-100)", setting: "active_brightness", min: 1, max: 100 },
                { type: "integer", title: "Idle Brightness (1-100)", setting: "idle_brightness", min: 1, max: 100 }
            ]
        });
    },
    save_settings: function(req, isdryrun, settings) {
        if (isdryrun) {
            req.send_complete("Success");
            return;
        }
        mysettings = Object.assign({}, mysettings, settings.values);
        roon.save_config("settings", mysettings);
        req.send_complete("Success");
        updateBrightness();
    }
});

roon.init_services({ required_services: [ RoonApiTransport, RoonApiImage ], provided_services: [ svc_status, svc_settings ] });
roon.start_discovery();

/**
 * State Machine Controller. Evaluates Roon zone events and routes the display:
 *   - Playing + new art/track: triggers the Stepladder blur transition.
 *   - Playing + same track (resume): instantly restores sharp artwork.
 *   - Paused/Stopped: kills transitions, shows Pause screen, starts Clock timer.
 * Only processes the configured zone_id; ignores all others.
 * @param {Array} changedZones - Array of Roon zone objects from the subscription.
 */
function checkZone(changedZones) {
    if (!mysettings.zone_id) return;
    const targetZone = changedZones.find(z => z.zone_id === mysettings.zone_id) || zones[mysettings.zone_id];
    if (!targetZone) return;

    if (targetZone.state === 'playing') {
        clearTimeout(stateTimer);
        clearTimeout(clockSyncTimer);
        const np = targetZone.now_playing;
        if (np) {
            const track = (np.two_line && np.two_line.line1) || "Unknown Track";
            const artist = (np.two_line && np.two_line.line2) || "Unknown Artist";
            
            if (np.image_key !== lastImageKey || track !== currentTrackName) {
                const isNewAlbum = np.image_key !== lastImageKey;
                clearTransitions();
                activeTransitionId = Date.now();
                lastImageKey = np.image_key || "no_art";
                currentTrackName = track;
                currentArtistName = artist;
                
                if (np.image_key) {
                    runStepladderTransition(track, artist, np.image_key, activeTransitionId, isNewAlbum);
                } else {
                    // AUDIT FIX: Handles tracks missing metadata/art entirely
                    pushStaticImageToTuneshine(track, artist, "no_art.png");
                }
            } else if (displayState !== 'PLAYING') {
                clearTransitions();
                pushStaticImageToTuneshine(track, artist, lastImageKey);
            }
            displayState = 'PLAYING';
        }
    } else if ((targetZone.state === 'paused' || targetZone.state === 'stopped') && displayState === 'PLAYING') {
        clearTransitions();
        displayState = 'PAUSED';
        const displayWord = targetZone.state === 'stopped' ? "Stopped" : "Paused";
        postToTuneshine('/image', { trackName: displayWord, idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/pause.png?t=${Date.now()}` });
        stateTimer = setTimeout(enterClockMode, mysettings.clock_timeout * 1000);
    }
}

/**
 * Pre-renders a cinematic "Stepladder" blur-to-sharp transition sequence.
 * Fetches Roon artwork at 256x256, normalizes it, then writes a series of
 * progressively less-blurred Baseline JPEGs to disk. Builds the stage sequence
 * locally to prevent async state corruption, then atomically commits it to
 * the global activeTransitionState. Includes strict checkpointing after every
 * await to kill stale branches from rapid track-skipping.
 * @param {string} track - Current track name.
 * @param {string} artist - Current artist name.
 * @param {string} imageKey - Roon image key for artwork retrieval.
 * @param {number} transitionId - Unique ID (Date.now()) to checkpoint against.
 * @param {boolean} isNewAlbum - True if the album art changed (more blur steps).
 */
async function runStepladderTransition(track, artist, imageKey, transitionId, isNewAlbum) {
    if (!core || !imageKey) return;
    const localIp = getLocalIp();
    core.services.RoonApiImage.get_image(imageKey, { scale: 'fill', width: 256, height: 256, format: 'image/jpeg' }, async (err, contentType, imgBuffer) => {
        if (err || activeTransitionId !== transitionId) return;
        
        try {
            let sharpJimp = await Jimp.read(imgBuffer);
            if (activeTransitionId !== transitionId) return; // AUDIT FIX: Kill stale async loops
            
            sharpJimp = await normalizeImageForLED(sharpJimp);
            if (activeTransitionId !== transitionId) return; // AUDIT FIX: Kill stale async loops
            
            const sharpPath = path.join(configDir, `trans_${transitionId}_0_${imageKey}.jpg`);
            await sharpJimp.quality(90).writeAsync(sharpPath);
            
            preDimmedBackgroundJimp = sharpJimp.clone().resize(64, 64).brightness(-0.6);

            const pathsToCleanup = [sharpPath];
            const steps = isNewAlbum ? mysettings.new_album_steps : mysettings.intra_album_steps;
            
            // AUDIT FIX: Build stages locally so we don't asynchronously mutate global state
            let localStages = [];

            if (steps > 0) {
                for (let i = steps; i >= 1; i--) {
                    if (activeTransitionId !== transitionId) return;
                    const b = Math.ceil(16 * (i / steps));
                    const bPath = path.join(configDir, `trans_${transitionId}_${b}_${imageKey}.jpg`);
                    pathsToCleanup.push(bPath);
                    await sharpJimp.clone().blur(b).quality(90).writeAsync(bPath);
                    
                    if (activeTransitionId !== transitionId) return; 
                    
                    localStages.push({ 
                        url: `http://${localIp}:${proxyPort}/image/trans_${transitionId}_${b}_${imageKey}.jpg?t=${Date.now()}`, 
                        delayAfterFetch: mysettings.dissolve_delay, name: `Blur ${b}` 
                    });
                }
            }
            
            // Final checkpoint before committing to the global state
            if (activeTransitionId !== transitionId) return;
            localStages.push({ url: `http://${localIp}:${proxyPort}/image/trans_${transitionId}_0_${imageKey}.jpg?t=${Date.now()}`, delayAfterFetch: 0, name: "Sharp" });
            
            // Commit fully-built sequence to global state synchronously
            activeTransitionState = { id: transitionId, track: track, artist: artist, currentStageIndex: 0, stages: localStages };

            // Cleanup must outlive the longest possible transition + watchdog + safety margin
            const maxTransitionMs = localStages.length * (mysettings.dissolve_delay + 150 + 5000) + 5000;
            const cleanupDelay = Math.max(15000, maxTransitionMs);
            setTimeout(() => {
                pathsToCleanup.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
            }, cleanupDelay);

            if (activeTransitionId === transitionId) {
                const first = activeTransitionState.stages[0];
                const watchdogTimeout = mysettings.dissolve_delay + 5000;
                transitionWatchdog = setTimeout(() => {
                    if (activeTransitionId === transitionId) pushStaticImageToTuneshine(track, artist, imageKey);
                }, watchdogTimeout);
                postToTuneshine('/image', { trackName: track, artistName: artist, idle: false, imageUrl: first.url });
            }
        } catch (e) {
            // AUDIT FIX: If Jimp crashes reading the Roon buffer, fail gracefully to the text graphic
            errLog(`[Transition] Fatal image decode error. Skipping to fallback. ${e.message}`);
            if (activeTransitionId === transitionId) pushStaticImageToTuneshine(track, artist, "no_art.png");
        }
    });
}

/**
 * Sends a static (non-transition) image command to the Tuneshine. Routes the
 * image URL through the local proxy so normalization is always applied.
 * Handles the "no_art" fallback case by routing to the generated PNG instead
 * of attempting a Roon image fetch with a null key.
 * @param {string} track - Track name for the display overlay.
 * @param {string} artist - Artist name for the display overlay.
 * @param {string} imageKey - Roon image key, or "no_art"/"no_art.png" for fallback.
 */
function pushStaticImageToTuneshine(track, artist, imageKey) {
    const localIp = getLocalIp();
    // AUDIT FIX: Protect the "no_art" fallback from being sent to Roon as a .jpg request
    let urlPath;
    if (imageKey === "no_art" || imageKey === "no_art.png") {
        urlPath = "no_art.png";
    } else {
        urlPath = imageKey.includes('.') ? imageKey : `${imageKey}.jpg`;
    }
    
    postToTuneshine('/image', { 
        trackName: track, artistName: artist, idle: false, 
        imageUrl: `http://${localIp}:${proxyPort}/image/${urlPath}?t=${Date.now()}` 
    });
}

/**
 * Transitions display to Clock Mode. Pushes the clock graphic, starts the
 * minute-aligned sync timer, and arms the Deep Idle timeout.
 */
function enterClockMode() {
    displayState = 'CLOCK';
    pushClockToTuneshine();
    startClockSync();
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(enterDeepIdleMode, mysettings.deep_idle_timeout * 60 * 1000);
}

/**
 * Transitions display to Deep Idle (LED preservation). Kills the clock sync
 * timer and pushes a 100% pure-black frame with no text to the display.
 */
function enterDeepIdleMode() {
    log("[Action] Deep Idle (Blackout)");
    displayState = 'DEEP_IDLE';
    clearTimeout(clockSyncTimer); // AUDIT FIX: Prevent Phantom Wakeups
    pushClockToTuneshine(); 
}

/**
 * Schedules the next clock update aligned to the top of the next minute (+50ms
 * buffer for render). Recursively re-arms itself. Guarded to only run in CLOCK
 * state to prevent phantom wakeups during Deep Idle.
 */
function startClockSync() {
    clearTimeout(clockSyncTimer);
    if (displayState !== 'CLOCK') return; // AUDIT FIX: Ensure DEEP_IDLE doesn't re-trigger sync
    const msUntilNextMinute = 60000 - (Date.now() % 60000);
    clockSyncTimer = setTimeout(() => { pushClockToTuneshine(); startClockSync(); }, msUntilNextMinute + 50);
}

/**
 * Generates the Clock display PNG buffer. In DEEP_IDLE, returns a pure-black
 * 64x64 frame. Otherwise composites the current time (font16) and AM/PM (font8)
 * over dimmed artwork using Random Quadrant Jitter for LED burn-in protection.
 * The AM/PM indicator is always placed in the exact opposite corner of the time.
 * @returns {Promise<Buffer>} PNG image buffer.
 */
async function generateClockBuffer() {
    if (displayState === 'DEEP_IDLE') {
        return await new Jimp(64, 64, 0x000000FF).getBufferAsync(Jimp.MIME_PNG);
    }
    
    let image = preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF);
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const parts = timeStr.split(' '); 
    
    const quad = Math.floor(Math.random() * 4);
    let tX, tY, aX, aY;

    switch(quad) {
        case 0: tX = 2; tY = 2; aX = 48; aY = 48; break;
        case 1: tX = 22; tY = 2; aX = 2; aY = 48; break;
        case 2: tX = 2; tY = 46; aX = 48; aY = 2; break;
        default: tX = 22; tY = 46; aX = 2; aY = 2; break;
    }
    
    if (font16) image.print(font16, tX, tY, parts[0]);
    if (font8 && parts[1]) image.print(font8, aX, aY, parts[1]); 
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Generates the Pause display PNG buffer. Renders two white pause bars over
 * dimmed artwork using Random Quadrant Jitter (4 positions, X and Y) for
 * LED burn-in protection.
 * @returns {Promise<Buffer>} PNG image buffer.
 */
async function generatePauseBuffer() {
    let image = preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF);
    const quad = Math.floor(Math.random() * 4);
    let bX, bY;
    switch(quad) {
        case 0: bX = 10; bY = 10; break;
        case 1: bX = 38; bY = 10; break;
        case 2: bX = 10; bY = 30; break;
        default: bX = 38; bY = 30; break;
    }
    const bar = new Jimp(8, 24, 0xFFFFFFFF);
    image.composite(bar, bX, bY); image.composite(bar, bX + 12, bY);
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Dispatches a clock/idle image command to the Tuneshine via the local proxy.
 * The proxy dynamically generates the appropriate frame (Clock or pure-black)
 * based on the current displayState.
 */
async function pushClockToTuneshine() {
    const localIp = getLocalIp();
    postToTuneshine('/image', { trackName: "Idle", artistName: "Clock", idle: true, imageUrl: `http://${localIp}:${proxyPort}/image/clock.png?t=${Date.now()}` });
}

/**
 * Pushes active and idle brightness levels to the Tuneshine hardware.
 * Called on core_paired and save_settings for instant sync.
 */
function updateBrightness() {
    postToTuneshine('/brightness', { active: Number(mysettings.active_brightness) || 80, idle: Number(mysettings.idle_brightness) || 20 });
}
