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

// Ensure the config directory exists for persistent settings and cached images
const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir);
}
process.chdir(configDir);

// --- GLOBAL TIMESTAMP LOGGER ---

/**
 * Standard timestamped logger for standard output.
 * @param {string} msg - The message to log.
 */
function log(msg) {
    const now = new Date();
    const ts = `${now.toISOString().replace('T', ' ').substring(0, 19)}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    console.log(`[${ts}] ${msg}`);
}

/**
 * Timestamped logger for error output.
 * @param {string} msg - The error message to log.
 */
function errLog(msg) {
    const now = new Date();
    const ts = `${now.toISOString().replace('T', ' ').substring(0, 19)}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    console.error(`[${ts}] ${msg}`);
}

/**
 * Detects the local IPv4 address of the host machine.
 * Ignores Docker bridge networks to ensure the Tuneshine can route back to this proxy.
 * @returns {string} The detected local IP address.
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

let lastImgBuffer = null; 
let preDimmedBackgroundJimp = null; 
let font16 = null; 
let font8 = null; 

// Pre-load fonts into memory to eliminate I/O lag during time-sensitive clock updates
Jimp.loadFont(Jimp.FONT_SANS_16_WHITE).then(f => font16 = f);
Jimp.loadFont(Jimp.FONT_SANS_8_WHITE).then(f => font8 = f);

let displayState = 'PLAYING'; // 'PLAYING', 'PAUSED', 'CLOCK', 'DEEP_IDLE'
let stateTimer = null;
let clockSyncTimer = null;
let currentZoneState = null;
let currentTrackName = null;

let transitionTimers = []; 
let activeTransitionId = null; 
let activeTransitionState = null; 

/**
 * Halts any active frame transitions and clears timers.
 */
function clearTransitions() {
    transitionTimers.forEach(t => clearTimeout(t));
    transitionTimers = [];
    activeTransitionId = null;
    activeTransitionState = null;
}

// --- HTTP SERVER ---
const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    
    log(`[Proxy] Tuneshine requested: ${pathname}`);

    // Trigger the reactive daisy-chain advance once a file is successfully transmitted
    res.on('finish', () => {
        log(`[Proxy] Finished transmitting: ${pathname}`);
        checkTransitionAdvance(pathname);
    });
    
    if (pathname.startsWith('/image/clock.png')) {
        generateClockBuffer().then(imgBuffer => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
            res.end(imgBuffer);
        }).catch(err => { res.writeHead(500); res.end('Error'); });
        return;
    }

    if (pathname.startsWith('/image/pause.png')) {
        generatePauseBuffer().then(imgBuffer => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imgBuffer.length });
            res.end(imgBuffer);
        }).catch(err => { res.writeHead(500); res.end('Error'); });
        return;
    }

    if (pathname.startsWith('/image/trans_')) {
        const filepath = path.join(configDir, pathname.replace('/image/', ''));
        if (fs.existsSync(filepath)) {
            const stat = fs.statSync(filepath);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size });
            fs.createReadStream(filepath).pipe(res);
        } else {
            res.writeHead(404); res.end('Not found');
        }
        return;
    }

    if (pathname.startsWith('/image/')) {
        const key = pathname.replace('/image/', '').replace('.png', '').replace('.jpg', '');
        if (core && key) {
            core.services.RoonApiImage.get_image(key, { scale: 'fill', width: 64, height: 64, format: 'image/png' }, (err, contentType, imgBuffer) => {
                if (err) { res.writeHead(500); res.end('Error'); return; }
                lastImgBuffer = imgBuffer;
                res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': imgBuffer.length });
                res.end(imgBuffer);
            });
        } else {
            res.writeHead(404); res.end('Not found');
        }
    } else {
        res.writeHead(404); res.end('Not found');
    }
});

server.listen(proxyPort, () => log(`[Server] Tuneshine Proxy running on port ${proxyPort}`));

/**
 * Daisy-chain sequencer that waits for the hardware to finish fetching a frame
 * before pushing the next stage of the focus-pull transition.
 */
function checkTransitionAdvance(fetchedPathname) {
    if (displayState !== 'PLAYING' || !activeTransitionState) return;
    const currentStage = activeTransitionState.stages[activeTransitionState.currentStageIndex];
    if (!currentStage) return;

    if (currentStage.url.includes(fetchedPathname)) {
        log(`[Transition] Confirmed Tuneshine received ${currentStage.name}.`);
        activeTransitionState.currentStageIndex++;
        const nextStage = activeTransitionState.stages[activeTransitionState.currentStageIndex];
        
        if (nextStage) {
            log(`[Transition] Hardware dissolve active. Waiting ${currentStage.delayAfterFetch}ms before pushing next stage...`);
            const timerId = setTimeout(async () => {
                if (displayState === 'PLAYING' && activeTransitionId === activeTransitionState.id) {
                    log(`[API] Pushing POST for ${nextStage.name}`);
                    await fetch(`http://${mysettings.tuneshine_host}/image`, {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ trackName: activeTransitionState.track, idle: false, imageUrl: nextStage.url })
                    }).then(res => log(`[API] POST acknowledged (Status: ${res.status})`))
                      .catch(err => errLog(`[API Error] Failed to push stage: ${err.message}`));
                }
            }, currentStage.delayAfterFetch);
            transitionTimers.push(timerId);
        } else {
            log(`[Transition] Sequence completed successfully.`);
            activeTransitionState = null; 
        }
    }
}

// --- ROON SETUP ---
var roon = new RoonApi({
    extension_id: 'com.colseverinus.tuneshine.roon',
    display_name: 'Tuneshine Display Controller',
    display_version: 'v0.37',
    publisher: 'Matt Philpot',
    email: 'col.severinus@gmail.com',
    website: 'https://everydayaudiophile.com',
    log_level: 'none',

    core_paired: function(core_) {
        core = core_;
        svc_status.set_status("Paired to core", false);
        log("[Roon] Successfully paired to Roon Core");
        core.services.RoonApiTransport.subscribe_zones((response, data) => {
            if (response === "Subscribed") {
                zones = data.zones.reduce((acc, z) => { acc[z.zone_id] = z; return acc; }, {});
                checkZone(data.zones);
            } else if (response === "Changed") {
                if (data.zones_added) { data.zones_added.forEach(z => zones[z.zone_id] = z); checkZone(data.zones_added); }
                if (data.zones_changed) { data.zones_changed.forEach(z => zones[z.zone_id] = z); checkZone(data.zones_changed); }
                if (data.zones_removed) { data.zones_removed.forEach(z => delete zones[z.zone_id]); }
            }
        });
    },
    core_unpaired: function(core_) { core = null; log("[Roon] Unpaired from Roon Core"); }
});

let loadedSettings = roon.load_config("settings") || {};
var mysettings = {
    tuneshine_host: loadedSettings.tuneshine_host || "",
    zone_id: loadedSettings.zone_id || null,
    new_album_steps: loadedSettings.new_album_steps ?? 2,
    intra_album_steps: loadedSettings.intra_album_steps ?? 1,
    dissolve_delay: loadedSettings.dissolve_delay || 2000,
    active_brightness: loadedSettings.active_brightness || 80,
    idle_brightness: loadedSettings.idle_brightness || 20,
    clock_timeout: loadedSettings.clock_timeout || 60, 
    deep_idle_timeout: loadedSettings.deep_idle_timeout || 10 
};

var svc_status = new RoonApiStatus(roon);

function makeLayout(settings) {
    let zone_dropdown = [{ title: "Select Zone...", value: null }];
    Object.values(zones).forEach(z => zone_dropdown.push({ title: z.display_name, value: z.zone_id }));
    return {
        values: settings,
        layout: [
            { type: "string", title: "Tuneshine Host / IP", setting: "tuneshine_host" },
            { type: "dropdown", title: "Zone to Monitor", setting: "zone_id", values: zone_dropdown },
            { type: "integer", title: "New Album Blur Steps (0-5)", setting: "new_album_steps", min: 0, max: 5 },
            { type: "integer", title: "Intra-Album Blur Steps (0-5)", setting: "intra_album_steps", min: 0, max: 5 },
            { type: "integer", title: "Hardware Dissolve Delay (750-5000ms)", setting: "dissolve_delay", min: 750, max: 5000 },
            { type: "integer", title: "Clock Timeout (5-3600s)", setting: "clock_timeout", min: 5, max: 3600 },
            { type: "integer", title: "Deep Idle Timeout (1-1440m)", setting: "deep_idle_timeout", min: 1, max: 1440 },
            { type: "integer", title: "Active Brightness (1-100)", setting: "active_brightness", min: 1, max: 100 },
            { type: "integer", title: "Idle Brightness (1-100)", setting: "idle_brightness", min: 1, max: 100 }
        ],
        has_error: false
    };
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) { cb(makeLayout(mysettings)); },
    save_settings: function(req, isdryrun, settings) {
        let l = makeLayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });
        if (!isdryrun && !l.has_error) {
            let prev = Object.assign({}, mysettings);
            mysettings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", mysettings);
            log(`[Roon] Extension settings updated via UI.`);
            if (mysettings.zone_id && zones[mysettings.zone_id]) checkZone([zones[mysettings.zone_id]]);
            if (mysettings.active_brightness !== prev.active_brightness || mysettings.idle_brightness !== prev.idle_brightness) updateBrightness();
        }
    }
});

roon.init_services({ required_services: [ RoonApiTransport, RoonApiImage ], provided_services: [ svc_status, svc_settings ] });
roon.start_discovery();

/**
 * Intelligent Image Normalization v7.2 (Reverted Protection, Softened Proportional Boost).
 * Uses a refined 1/x progression to apply subtle Contrast (max 15%) and Saturation (max 10%)
 * to low-energy art. Uses a softened 0.4 black crush to clean mud without artificial glow.
 * @param {Jimp} jimpImage - The raw 64x64 Jimp object from Roon.
 * @returns {Jimp} The normalized Jimp object.
 */
async function normalizeImageForLED(jimpImage) {
    const histogram = new Array(256).fill(0);
    let totalSat = 0;
    const pixelCount = jimpImage.bitmap.width * jimpImage.bitmap.height;

    // Pass 1: Metric analysis
    jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, function(x, y, idx) {
        const r = this.bitmap.data[idx + 0], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
        const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        histogram[lum]++;
        const avg = (r + g + b) / 3;
        totalSat += Math.sqrt(((r - avg) ** 2 + (g - avg) ** 2 + (b - avg) ** 2) / 3);
    });

    // Pass 2: Identify 1%/99% dynamic range
    let minLum = 0, maxLum = 255, count = 0;
    const threshold = pixelCount * 0.01;
    for (let i = 0; i < 256; i++) { count += histogram[i]; if (count >= threshold) { minLum = i; break; } }
    count = 0;
    for (let i = 255; i >= 0; i--) { count += histogram[i]; if (count >= threshold) { maxLum = i; break; } }

    const avgSat = totalSat / pixelCount;
    
    // Calculate Energy Factor (E).
    const eLum = (maxLum - minLum) / 255;
    const eSat = Math.min(1, avgSat / 30);
    const energy = (eLum * 0.5) + (eSat * 0.5);

    // Intervention Strength based on refined 1/x curve.
    const aggression = (1 / Math.max(0.1, energy)) - 1;
    const strength = Math.min(1, Math.pow(Math.max(0, aggression), 0.7));

    log(`[Normalization] E:${energy.toFixed(2)} -> Strength:${strength.toFixed(2)} (Softened 0.4 Crush)`);

    // Only apply if signal weakness warrants a boost
    if (strength > 0.05) {
        // Step 1: Softened Black Crush (0.4 coefficient)
        // Reverted to uniform scaling to prevent "Oranj" artifacts.
        const floorCrush = minLum * 0.4 * strength;
        
        jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, function(x, y, idx) {
            const r = this.bitmap.data[idx + 0], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b);
            
            const crushedLum = Math.max(0, lum - floorCrush);
            const ratio = crushedLum / Math.max(1, lum);

            this.bitmap.data[idx + 0] = Math.max(0, Math.min(255, r * ratio));
            this.bitmap.data[idx + 1] = Math.max(0, Math.min(255, g * ratio));
            this.bitmap.data[idx + 2] = Math.max(0, Math.min(255, b * ratio));
        });

        // Step 2: Proportional Contrast (Max 15%)
        jimpImage.contrast(0.15 * strength);

        // Step 3: Proportional Saturation (Max 10%)
        jimpImage.color([{ apply: 'saturate', params: [10 * strength] }]);
    } else {
        log(`[Normalization] Art is high fidelity. Bypassing engine.`);
    }

    return jimpImage;
}

/**
 * State Machine. Evaluates zone playback status and triggers display updates.
 * @param {Array} changedZones - Array of zone data updated by the Roon API.
 */
function checkZone(changedZones) {
    if (!mysettings.zone_id) return;
    const targetZone = changedZones.find(z => z.zone_id === mysettings.zone_id);
    if (!targetZone) return;

    if (targetZone.state !== currentZoneState) {
        log(`[Roon Event] Zone state changed to: ${targetZone.state}`);
        currentZoneState = targetZone.state;
    }

    if (targetZone.state === 'playing') {
        clearTimeout(stateTimer);
        clearTimeout(clockSyncTimer);
        
        const np = targetZone.now_playing;
        if (np) {
            const track = (np.three_line && np.three_line.line1) || (np.two_line && np.two_line.line1) || "";
            if (track !== currentTrackName) log(`[Roon Event] Now playing: ${track}`);
            
            const imageKey = np.image_key;
            if (imageKey) {
                if (imageKey !== lastImageKey) {
                    log(`[Action] New album detected. Triggering focus-pull.`);
                    clearTransitions();
                    activeTransitionId = Date.now();
                    lastImageKey = imageKey;
                    svc_status.set_status(`Playing: ${track}`, false);
                    runStepladderTransition(track, imageKey, activeTransitionId, true);
                } 
                else if (displayState !== 'PLAYING') {
                    log(`[Action] Resumed playback. Restoring art.`);
                    clearTransitions();
                    svc_status.set_status(`Playing: ${track}`, false);
                    pushStaticImageToTuneshine(track, imageKey);
                } 
                else if (track !== currentTrackName) {
                    log(`[Action] Track change on same album.`);
                    clearTransitions();
                    activeTransitionId = Date.now();
                    svc_status.set_status(`Playing: ${track}`, false);
                    runStepladderTransition(track, imageKey, activeTransitionId, false);
                }
            }
            currentTrackName = track;
        }
        displayState = 'PLAYING';
    } else if (targetZone.state === 'paused' && displayState === 'PLAYING') {
        displayState = 'PAUSED';
        clearTransitions(); 
        pushPauseToTuneshine();
        stateTimer = setTimeout(() => { enterClockMode(); }, mysettings.clock_timeout * 1000);
    } else if (targetZone.state === 'stopped' && displayState === 'PLAYING') {
        displayState = 'PAUSED'; 
        clearTransitions();
        stateTimer = setTimeout(() => { enterClockMode(); }, mysettings.clock_timeout * 1000);
    }
}

/**
 * Pre-renders blur stages and dispatches the reactive sequence.
 * @param {string} track - Current track name.
 * @param {string} imageKey - Roon Image identifier.
 * @param {number} transitionId - Unique ID to prevent skip-collision.
 * @param {boolean} isNewAlbum - True for deep focus-pulls, false for quick skips.
 */
async function runStepladderTransition(track, imageKey, transitionId, isNewAlbum) {
    if (!core) return;
    const host = mysettings.tuneshine_host; if (!host) return;
    const localIp = getLocalIp();

    core.services.RoonApiImage.get_image(imageKey, { scale: 'fill', width: 64, height: 64, format: 'image/png' }, async (err, contentType, imgBuffer) => {
        if (err || displayState !== 'PLAYING' || activeTransitionId !== transitionId) return;

        try {
            const steps = isNewAlbum ? mysettings.new_album_steps : mysettings.intra_album_steps;
            const maxBlur = isNewAlbum ? 16 : 6;
            const delay = mysettings.dissolve_delay;

            lastImgBuffer = imgBuffer; 
            let sharpJimp = await Jimp.read(imgBuffer);
            
            // Normalize before blur generation
            sharpJimp = await normalizeImageForLED(sharpJimp);
            
            const sharpPath = path.join(configDir, `trans_0_${imageKey}.png`);
            await sharpJimp.writeAsync(sharpPath);
            preDimmedBackgroundJimp = sharpJimp.clone().brightness(-0.6);
            
            let pathsToCleanup = [sharpPath];
            activeTransitionState = { id: transitionId, track: track, currentStageIndex: 0, stages: [] };

            if (steps === 0) {
                activeTransitionState.stages.push({ url: `http://${localIp}:${proxyPort}/image/trans_0_${imageKey}.png?t=${Date.now()}`, delayAfterFetch: 0, name: "Sharp Image" });
            } else {
                const blurValues = [];
                for (let i = steps; i >= 1; i--) blurValues.push(Math.ceil(maxBlur * (i / steps)));

                const blurPromises = blurValues.map(b => {
                    const bPath = path.join(configDir, `trans_${b}_${imageKey}.png`);
                    pathsToCleanup.push(bPath);
                    return sharpJimp.clone().blur(b).writeAsync(bPath);
                });
                await Promise.all(blurPromises);

                blurValues.forEach((b, index) => {
                    activeTransitionState.stages.push({ url: `http://${localIp}:${proxyPort}/image/trans_${b}_${imageKey}.png?t=${Date.now()}`, delayAfterFetch: delay, name: `Blur Step ${index + 1}` });
                });
                activeTransitionState.stages.push({ url: `http://${localIp}:${proxyPort}/image/trans_0_${imageKey}.png?t=${Date.now()}`, delayAfterFetch: 0, name: `Final Sharp` });
            }

            const cleanupTimer = setTimeout(() => {
                pathsToCleanup.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
            }, 15000);
            transitionTimers.push(cleanupTimer);

            if (displayState === 'PLAYING' && activeTransitionId === transitionId) {
                const firstStage = activeTransitionState.stages[0];
                await fetch(`http://${host}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackName: track, idle: false, imageUrl: firstStage.url }) }).catch(()=>{});
            }
        } catch (e) { errLog(`[Transition Error] ${e}`); }
    });
}

/**
 * Pushes a static image URL to hardware.
 * @param {string} track - Current track name.
 * @param {string} imageKey - Roon Image identifier.
 */
async function pushStaticImageToTuneshine(track, imageKey) {
    const host = mysettings.tuneshine_host; if (!host) return;
    try {
        await fetch(`http://${host}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackName: track, idle: false, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/${imageKey}.png?t=${Date.now()}` }) });
    } catch (err) {}
}

/**
 * Switches the display to Clock mode and initiates the sync loop.
 */
function enterClockMode() {
    log("[Action] Entering Clock Mode.");
    displayState = 'CLOCK';
    pushClockToTuneshine();
    startClockSync();
    stateTimer = setTimeout(() => { enterDeepIdleMode(); }, mysettings.deep_idle_timeout * 60 * 1000); 
}

/**
 * Switches the display to Deep Idle mode (Pure black background).
 */
function enterDeepIdleMode() {
    log("[Action] Entering Deep Idle Mode.");
    displayState = 'DEEP_IDLE';
    pushClockToTuneshine(); 
}

/**
 * Synchronizes the clock refresh to the top of the real-world minute.
 */
function startClockSync() {
    clearTimeout(clockSyncTimer);
    function scheduleNext() {
        if (displayState !== 'CLOCK' && displayState !== 'DEEP_IDLE') return;
        const msUntilNextMinute = 60000 - (Date.now() % 60000);
        clockSyncTimer = setTimeout(() => { pushClockToTuneshine(); scheduleNext(); }, msUntilNextMinute + 50);
    }
    scheduleNext();
}

/**
 * Generates a PNG buffer containing the current time overlayed on the dimmed album art.
 * @returns {Buffer} The generated PNG buffer.
 */
async function generateClockBuffer() {
    let image = (displayState === 'DEEP_IDLE') ? new Jimp(64, 64, 0x000000FF) : (preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF));
    const f16 = font16 || await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const f8 = font8 || await Jimp.loadFont(Jimp.FONT_SANS_8_WHITE);
    const now = new Date();
    const is24Hour = process.env.CLOCK_FORMAT === '24';
    const timeOptions = { hour: is24Hour ? '2-digit' : 'numeric', minute: '2-digit', hour12: !is24Hour };
    if (process.env.TZ) timeOptions.timeZone = process.env.TZ;
    let parts = now.toLocaleTimeString('en-US', timeOptions).split(' ');
    const timeStr = parts[0], amPmStr = parts[1] || "";
    const timeWidth = Jimp.measureText(f16, timeStr), timeHeight = Jimp.measureTextHeight(f16, timeStr, 64);
    const randomX = Math.floor(Math.random() * Math.max(0, 64 - timeWidth));
    const randomY = Math.floor(Math.random() * Math.max(0, 64 - timeHeight));
    image.print(f16, randomX, randomY, timeStr);
    if (amPmStr) {
        const p = 2, amW = Jimp.measureText(f8, amPmStr), amH = Jimp.measureTextHeight(f8, amPmStr, 64);
        const tCX = randomX + (timeWidth / 2), tCY = randomY + (timeHeight / 2);
        let cX, cY;
        if (tCX < 32 && tCY < 32) { cX = 64 - amW - p; cY = 64 - amH - p; }
        else if (tCX >= 32 && tCY < 32) { cX = p; cY = 64 - amH - p; }
        else if (tCX < 32 && tCY >= 32) { cX = 64 - amW - p; cY = p; }
        else { cX = p; cY = p; }
        image.print(f8, cX, cY, amPmStr);
    }
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Pushes the Clock URL to the Tuneshine hardware.
 */
async function pushClockToTuneshine() {
    const host = mysettings.tuneshine_host; if (!host) return;
    try {
        await fetch(`http://${host}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackName: "Idle", idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/clock.png?t=${Date.now()}` }) }).then(res => { if (res.ok) svc_status.set_status(`Idle (Clock)`, false); });
    } catch (err) {}
}

/**
 * Generates a PNG buffer containing universal pause bars.
 * @returns {Buffer} The generated PNG buffer.
 */
async function generatePauseBuffer() {
    let image = preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF);
    const bar = new Jimp(8, 24, 0xFFFFFFFF);
    image.composite(bar, 20, 20); image.composite(bar, 36, 20);
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Pushes the Pause screen URL to the Tuneshine hardware.
 */
async function pushPauseToTuneshine() {
    const host = mysettings.tuneshine_host; if (!host) return;
    try {
        await fetch(`http://${host}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackName: "Paused", idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/pause.png?t=${Date.now()}` }) }).then(res => { if (res.ok) svc_status.set_status(`Paused`, false); });
    } catch (err) {}
}

/**
 * Sends current brightness settings to the Tuneshine hardware.
 */
function updateBrightness() {
    const host = mysettings.tuneshine_host; if (!host) return;
    try { fetch(`http://${host}/brightness`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: Number(mysettings.active_brightness) || 80, idle: Number(mysettings.idle_brightness) || 20 }) }); } catch (err) {}
}
