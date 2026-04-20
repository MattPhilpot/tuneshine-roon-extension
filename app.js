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

// --- Release 1.0.7 "Gold Master" Networking ---
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 3000 });

const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
process.chdir(configDir);

/**
 * Startup Purge: Destroys stale transition frames from previous crashed sessions.
 */
function purgeTempFiles() {
    fs.readdirSync(configDir).forEach(file => {
        if (file.endsWith('.jpg') && file.includes('_trans_')) {
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
Jimp.loadFont(Jimp.FONT_SANS_16_WHITE).then(f => font16 = f);
Jimp.loadFont(Jimp.FONT_SANS_8_WHITE).then(f => font8 = f);

let displayState = 'PLAYING';
let stateTimer = null;
let clockSyncTimer = null;
let integrityInterval = null;
let currentZoneState = null;
let currentTrackName = "";
let currentArtistName = "";

let transitionTimers = []; 
let activeTransitionId = null; 
let activeTransitionState = null; 
let transitionWatchdog = null;

function clearTransitions() {
    transitionTimers.forEach(t => clearTimeout(t));
    transitionTimers = [];
    if (transitionWatchdog) clearTimeout(transitionWatchdog);
    activeTransitionId = null;
    activeTransitionState = null;
}

// --- HARDENED HTTP PROXY (v1.0.7) ---
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

    if (pathname.startsWith('/image/trans_')) {
        const filename = path.basename(pathname);
        const filepath = path.join(configDir, filename);
        if (fs.existsSync(filepath)) {
            const stat = fs.statSync(filepath);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
            fs.createReadStream(filepath).pipe(res);
        } else {
            errLog(`[Proxy] 404 Missing File: ${filename}`);
            res.writeHead(404); res.end();
        }
        return;
    }

    // Roon Original Image Proxy (Now guarantees normalization on fallback images)
    if (pathname.startsWith('/image/')) {
        const key = path.basename(pathname).split('.')[0];
        if (core && key) {
            core.services.RoonApiImage.get_image(key, { scale: 'fill', width: 256, height: 256, format: 'image/jpeg' }, async (err, contentType, imgBuffer) => {
                if (err) { res.writeHead(500); res.end(); return; }
                try {
                    let jimpImg = await Jimp.read(imgBuffer);
                    jimpImg = await normalizeImageForLED(jimpImg);
                    const outBuf = await jimpImg.quality(90).getBufferAsync(Jimp.MIME_JPEG);
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': outBuf.length });
                    res.end(outBuf);
                } catch (e) {
                    errLog(`[Proxy] Fallback normalization failed: ${e.message}`);
                    res.writeHead(500); res.end();
                }
            });
        } else {
            res.writeHead(503); res.end();
        }
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(proxyPort, () => log(`[Server] Release 1.0.7 (Gold Master) listening on port ${proxyPort}`));

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
        const req = http.request(options);
        req.on('error', (e) => errLog(`[Post Error] ${e.message}`));
        req.write(payload);
        req.end();
    } catch (e) {}
}

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

async function checkHardwareIntegrity() {
    if (!mysettings.tuneshine_host || !core) return;
    try {
        const options = { hostname: mysettings.tuneshine_host, path: '/state', method: 'GET', agent: keepAliveAgent, timeout: 2000 };
        http.get(options, (res) => {
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
                    } catch (pe) {}
                }
            });
        }).on('error', () => {});
    } catch (e) {}
}

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
    extension_id: 'com.colseverinus.tuneshine.roon',
    display_name: 'Tuneshine Roon Controller',
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
        if (!isdryrun) {
            mysettings = settings.values;
            roon.save_config("settings", mysettings);
            req.send_complete("Success");
            updateBrightness();
        }
    }
});

roon.init_services({ required_services: [ RoonApiTransport, RoonApiImage ], provided_services: [ svc_status, svc_settings ] });
roon.start_discovery();

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
                lastImageKey = np.image_key;
                currentTrackName = track;
                currentArtistName = artist;
                runStepladderTransition(track, artist, np.image_key, activeTransitionId, isNewAlbum);
            }
        }
        displayState = 'PLAYING';
    } else if ((targetZone.state === 'paused' || targetZone.state === 'stopped') && displayState === 'PLAYING') {
        displayState = 'PAUSED';
        const displayWord = targetZone.state === 'stopped' ? "Stopped" : "Paused";
        postToTuneshine('/image', { trackName: displayWord, idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/pause.png?t=${Date.now()}` });
        stateTimer = setTimeout(enterClockMode, mysettings.clock_timeout * 1000);
    }
}

async function runStepladderTransition(track, artist, imageKey, transitionId, isNewAlbum) {
    if (!core || !imageKey) return;
    const localIp = getLocalIp();
    core.services.RoonApiImage.get_image(imageKey, { scale: 'fill', width: 256, height: 256, format: 'image/jpeg' }, async (err, contentType, imgBuffer) => {
        if (err || activeTransitionId !== transitionId) return;
        let sharpJimp = await Jimp.read(imgBuffer);
        sharpJimp = await normalizeImageForLED(sharpJimp);
        
        const sharpPath = path.join(configDir, `trans_${transitionId}_0_${imageKey}.jpg`);
        await sharpJimp.quality(90).writeAsync(sharpPath);
        
        // Critical Fix: Explicitly scale the reference background to 64x64 to prevent microscopic UI overlays
        preDimmedBackgroundJimp = sharpJimp.clone().resize(64, 64).brightness(-0.6);

        const pathsToCleanup = [sharpPath];
        const steps = isNewAlbum ? mysettings.new_album_steps : mysettings.intra_album_steps;
        activeTransitionState = { id: transitionId, track: track, artist: artist, currentStageIndex: 0, stages: [] };

        if (steps > 0) {
            for (let i = steps; i >= 1; i--) {
                if (activeTransitionId !== transitionId) break;
                const b = Math.ceil(16 * (i / steps));
                const bPath = path.join(configDir, `trans_${transitionId}_${b}_${imageKey}.jpg`);
                pathsToCleanup.push(bPath);
                await sharpJimp.clone().blur(b).quality(90).writeAsync(bPath);
                activeTransitionState.stages.push({ 
                    url: `http://${localIp}:${proxyPort}/image/trans_${transitionId}_${b}_${imageKey}.jpg?t=${Date.now()}`, 
                    delayAfterFetch: mysettings.dissolve_delay, name: `Blur ${b}` 
                });
            }
        }
        activeTransitionState.stages.push({ url: `http://${localIp}:${proxyPort}/image/trans_${transitionId}_0_${imageKey}.jpg?t=${Date.now()}`, delayAfterFetch: 0, name: "Sharp" });

        setTimeout(() => {
            pathsToCleanup.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
        }, 15000);

        if (activeTransitionId === transitionId) {
            const first = activeTransitionState.stages[0];
            const watchdogTimeout = mysettings.dissolve_delay + 5000;
            transitionWatchdog = setTimeout(() => {
                if (activeTransitionId === transitionId) pushStaticImageToTuneshine(track, artist, imageKey);
            }, watchdogTimeout);
            postToTuneshine('/image', { trackName: track, artistName: artist, idle: false, imageUrl: first.url });
        }
    });
}

function pushStaticImageToTuneshine(track, artist, imageKey) {
    const localIp = getLocalIp();
    postToTuneshine('/image', { 
        trackName: track, artistName: artist, idle: false, 
        imageUrl: `http://${localIp}:${proxyPort}/image/${imageKey}.jpg?t=${Date.now()}` 
    });
}

function enterClockMode() {
    displayState = 'CLOCK';
    pushClockToTuneshine();
    startClockSync();
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(enterDeepIdleMode, mysettings.deep_idle_timeout * 60 * 1000);
}

function enterDeepIdleMode() {
    displayState = 'DEEP_IDLE';
    pushClockToTuneshine(); 
}

function startClockSync() {
    clearTimeout(clockSyncTimer);
    if (displayState !== 'CLOCK' && displayState !== 'DEEP_IDLE') return;
    const msUntilNextMinute = 60000 - (Date.now() % 60000);
    clockSyncTimer = setTimeout(() => { pushClockToTuneshine(); startClockSync(); }, msUntilNextMinute + 50);
}

async function generateClockBuffer() {
    let image = (displayState === 'DEEP_IDLE') ? new Jimp(64, 64, 0x000000FF) : (preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF));
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

async function generatePauseBuffer() {
    let image = preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF);
    const quad = Math.floor(Math.random() * 4);
    let bX = (quad % 2 === 0) ? 10 : 38;
    const bar = new Jimp(8, 24, 0xFFFFFFFF);
    image.composite(bar, bX, 20); image.composite(bar, bX + 12, 20);
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

async function pushClockToTuneshine() {
    const localIp = getLocalIp();
    postToTuneshine('/image', { trackName: "Idle", artistName: "Clock", idle: true, imageUrl: `http://${localIp}:${proxyPort}/image/clock.png?t=${Date.now()}` });
}

function updateBrightness() {
    postToTuneshine('/brightness', { active: Number(mysettings.active_brightness) || 80, idle: Number(mysettings.idle_brightness) || 20 });
}
