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

const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir);
}
process.chdir(configDir);

// --- GLOBAL TIMESTAMP LOGGER ---
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

// --- OPTIMIZED IMAGE CACHES ---
let lastImgBuffer = null; 
let preDimmedBackgroundJimp = null; // Caches the darkened album art
let font16 = null; // Caches Clock Font
let font8 = null; // Caches AM/PM Font

// Pre-load fonts into memory immediately to prevent I/O blocking later
Jimp.loadFont(Jimp.FONT_SANS_16_WHITE).then(f => font16 = f);
Jimp.loadFont(Jimp.FONT_SANS_8_WHITE).then(f => font8 = f);

// --- STATE MACHINE TRACKERS ---
let displayState = 'PLAYING'; // 'PLAYING', 'PAUSED', 'CLOCK', 'DEEP_IDLE'
let stateTimer = null;
let clockSyncTimer = null;
let currentZoneState = null;
let currentTrackName = null;

// Track the transition state so we can cancel it cleanly
let transitionTimers = []; 
let activeTransitionId = null; 
let activeTransitionState = null; 

function clearTransitions() {
    transitionTimers.forEach(t => clearTimeout(t));
    transitionTimers = [];
    activeTransitionId = null;
    activeTransitionState = null;
}

// --- Setup Micro HTTP Server ---
const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    
    log(`[Proxy] Tuneshine requested: ${pathname}`);

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
            res.writeHead(400); res.end('Missing key');
        }
    } else {
        res.writeHead(404); res.end('Not found');
    }
});

server.listen(proxyPort, () => log(`[Server] Tuneshine Proxy running on port ${proxyPort}`));

// --- REACTIVE DAISY-CHAIN SEQUENCER ---
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

// --- Roon API Setup ---
var roon = new RoonApi({
    extension_id: 'com.colseverinus.tuneshine.roon',
    display_name: 'Tuneshine Display Controller',
    display_version: '1.0.0',
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
    core_unpaired: function(core_) { 
        core = null; 
        log("[Roon] Unpaired from Roon Core");
    }
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
    clock_timeout: loadedSettings.clock_timeout || loadedSettings.idle_timeout || 60, 
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
            { type: "integer", title: "New Album Blur Steps (0 = Off)", setting: "new_album_steps", min: 0, max: 5 },
            { type: "integer", title: "Intra-Album Blur Steps (0 = Off)", setting: "intra_album_steps", min: 0, max: 5 },
            { type: "integer", title: "Hardware Dissolve Delay (ms)", setting: "dissolve_delay", min: 1000, max: 5000 },
            { type: "integer", title: "Clock Timeout (Seconds)", setting: "clock_timeout", min: 5, max: 3600 },
            { type: "integer", title: "Deep Idle Timeout (Minutes)", setting: "deep_idle_timeout", min: 1, max: 1440 },
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
            log(`[Roon] Extension settings updated via UI. New config: ${JSON.stringify(mysettings)}`);

            if (mysettings.zone_id && zones[mysettings.zone_id]) checkZone([zones[mysettings.zone_id]]);
            if (mysettings.active_brightness !== prev.active_brightness || mysettings.idle_brightness !== prev.idle_brightness) updateBrightness();
        }
    }
});

roon.init_services({ required_services: [ RoonApiTransport, RoonApiImage ], provided_services: [ svc_status, svc_settings ] });
roon.start_discovery();

// --- STATE MACHINE LOGIC ---

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
            if (track !== currentTrackName) {
                log(`[Roon Event] Now playing: ${track}`);
            }
            const imageKey = np.image_key;
            
            if (imageKey) {
                if (imageKey !== lastImageKey) {
                    log(`[Action] New album detected. Triggering Full Stepladder.`);
                    clearTransitions();
                    activeTransitionId = Date.now();
                    lastImageKey = imageKey;
                    svc_status.set_status(`Playing: ${track}`, false);
                    runStepladderTransition(track, imageKey, activeTransitionId, true);
                } 
                else if (displayState !== 'PLAYING') {
                    log(`[Action] Resumed playback. Restoring sharp art.`);
                    clearTransitions();
                    svc_status.set_status(`Playing: ${track}`, false);
                    pushStaticImageToTuneshine(track, imageKey);
                } 
                else if (track !== currentTrackName) {
                    log(`[Action] Track changed on same album. Triggering Mini-Blur.`);
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
        log(`[Action] Music paused. Aborting transitions.`);
        displayState = 'PAUSED';
        clearTransitions(); 
        
        pushPauseToTuneshine();
        stateTimer = setTimeout(() => { enterClockMode(); }, mysettings.clock_timeout * 1000);

    } else if (targetZone.state === 'stopped' && displayState === 'PLAYING') {
        log(`[Action] Music stopped. Aborting transitions.`);
        displayState = 'PAUSED'; 
        clearTransitions();
        
        stateTimer = setTimeout(() => { enterClockMode(); }, mysettings.clock_timeout * 1000);
    }
}

// --- REACTIVE DISSOLVE ENGINE ---

async function runStepladderTransition(track, imageKey, transitionId, isNewAlbum) {
    if (!core) return;
    const host = mysettings.tuneshine_host;
    if (!host) return;
    const localIp = getLocalIp();

    core.services.RoonApiImage.get_image(imageKey, { scale: 'fill', width: 64, height: 64, format: 'image/png' }, async (err, contentType, imgBuffer) => {
        if (err || displayState !== 'PLAYING' || activeTransitionId !== transitionId) return;

        try {
            const steps = isNewAlbum ? mysettings.new_album_steps : mysettings.intra_album_steps;
            const maxBlur = isNewAlbum ? 16 : 6;
            const delay = mysettings.dissolve_delay;

            log(`[Transition] Generating ${steps} Blur frames for track: ${track} (Delay: ${delay}ms)`);
            
            lastImgBuffer = imgBuffer; 
            const sharpPath = path.join(configDir, `trans_0_${imageKey}.png`);
            fs.writeFileSync(sharpPath, imgBuffer);
            
            const sharpJimp = await Jimp.read(imgBuffer);
            preDimmedBackgroundJimp = sharpJimp.clone().brightness(-0.6);
            
            let pathsToCleanup = [sharpPath];

            activeTransitionState = {
                id: transitionId,
                track: track,
                currentStageIndex: 0,
                stages: []
            };

            if (steps === 0) {
                // If the user disabled blur, just load the sharp image immediately
                activeTransitionState.stages.push({
                    url: `http://${localIp}:${proxyPort}/image/trans_0_${imageKey}.png?t=${Date.now()}`,
                    delayAfterFetch: 0,
                    name: "Direct Sharp Image (Bypass Blur)"
                });
            } else {
                // Calculate mathematical blur radiuses based on user steps
                const blurValues = [];
                for (let i = steps; i >= 1; i--) {
                    blurValues.push(Math.ceil(maxBlur * (i / steps)));
                }

                // Generate and save all blur frames concurrently
                const blurPromises = blurValues.map(b => {
                    const bPath = path.join(configDir, `trans_${b}_${imageKey}.png`);
                    pathsToCleanup.push(bPath);
                    return sharpJimp.clone().blur(b).writeAsync(bPath);
                });
                await Promise.all(blurPromises);

                // Queue the blurred stages
                blurValues.forEach((b, index) => {
                    activeTransitionState.stages.push({
                        url: `http://${localIp}:${proxyPort}/image/trans_${b}_${imageKey}.png?t=${Date.now()}`,
                        delayAfterFetch: delay,
                        name: `Blur Step ${index + 1}/${steps}: ${b}px`
                    });
                });

                // Add the final sharp stage
                activeTransitionState.stages.push({
                    url: `http://${localIp}:${proxyPort}/image/trans_0_${imageKey}.png?t=${Date.now()}`,
                    delayAfterFetch: 0,
                    name: `Final Sharp Image`
                });
            }

            const cleanupTimer = setTimeout(() => {
                pathsToCleanup.forEach(p => { 
                    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} 
                });
            }, 15000);
            transitionTimers.push(cleanupTimer);

            if (displayState === 'PLAYING' && activeTransitionId === transitionId) {
                const firstStage = activeTransitionState.stages[0];
                log(`[API] Pushing POST for ${firstStage.name}`);
                await fetch(`http://${host}/image`, { 
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ trackName: track, idle: false, imageUrl: firstStage.url }) 
                }).then(res => log(`[API] POST acknowledged (Status: ${res.status})`))
                  .catch(err => errLog(`[API Error] Failed to start transition: ${err.message}`));
            }

        } catch (e) { errLog(`[Transition Error] ${e}`); }
    });
}

// Helper to push the sharp image directly
async function pushStaticImageToTuneshine(track, imageKey) {
    const host = mysettings.tuneshine_host; if (!host) return;
    const localIp = getLocalIp();
    
    log(`[API] Sending POST for Static Sharp Image...`);
    try {
        await fetch(`http://${host}/image`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ trackName: track, idle: false, imageUrl: `http://${localIp}:${proxyPort}/image/${imageKey}.png?t=${Date.now()}` }) 
        }).then(res => log(`[API] POST acknowledged (Status: ${res.status})`));
    } catch (err) {
        errLog(`[API Error] Failed to push static image: ${err.message}`);
    }
}

// --- IDLE & CLOCK LOGIC ---

function enterClockMode() {
    log("[Action] Entering Clock Mode (Album Art + Time).");
    displayState = 'CLOCK';
    pushClockToTuneshine();
    startClockSync();

    log(`[Action] Starting ${mysettings.deep_idle_timeout}m Deep Idle timer.`);
    stateTimer = setTimeout(() => {
        enterDeepIdleMode();
    }, mysettings.deep_idle_timeout * 60 * 1000); 
}

function enterDeepIdleMode() {
    log("[Action] Entering Deep Idle Mode (Pure Black + Time).");
    displayState = 'DEEP_IDLE';
    pushClockToTuneshine(); 
}

function startClockSync() {
    clearTimeout(clockSyncTimer);
    function scheduleNext() {
        if (displayState !== 'CLOCK' && displayState !== 'DEEP_IDLE') return;
        const msUntilNextMinute = 60000 - (Date.now() % 60000);
        clockSyncTimer = setTimeout(() => {
            pushClockToTuneshine();
            scheduleNext();
        }, msUntilNextMinute + 50);
    }
    scheduleNext();
}

async function generateClockBuffer() {
    let image;
    if (displayState === 'DEEP_IDLE') {
        image = new Jimp(64, 64, 0x000000FF);
    } else if (preDimmedBackgroundJimp) {
        image = preDimmedBackgroundJimp.clone(); // Instant access! No math required!
    } else {
        image = new Jimp(64, 64, 0x111111FF);
    }

    // Use cached fonts if available
    const f16 = font16 || await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const f8 = font8 || await Jimp.loadFont(Jimp.FONT_SANS_8_WHITE);
    
    const now = new Date();
    const is24Hour = process.env.CLOCK_FORMAT === '24';
    const timeOptions = { hour: is24Hour ? '2-digit' : 'numeric', minute: '2-digit', hour12: !is24Hour };
    if (process.env.TZ) timeOptions.timeZone = process.env.TZ;
    
    let parts = now.toLocaleTimeString('en-US', timeOptions).split(' ');
    const timeStr = parts[0]; const amPmStr = parts[1] || "";
    
    const timeWidth = Jimp.measureText(f16, timeStr); const timeHeight = Jimp.measureTextHeight(f16, timeStr, 64);
    const randomX = Math.floor(Math.random() * Math.max(0, 64 - timeWidth));
    const randomY = Math.floor(Math.random() * Math.max(0, 64 - timeHeight));
    
    image.print(f16, randomX, randomY, timeStr);
    
    if (amPmStr) {
        const padding = 2; const amPmWidth = Jimp.measureText(f8, amPmStr); const amPmHeight = Jimp.measureTextHeight(f8, amPmStr, 64);
        const tCX = randomX + (timeWidth / 2); const tCY = randomY + (timeHeight / 2);
        let cX, cY;
        if (tCX < 32 && tCY < 32) { cX = 64 - amPmWidth - padding; cY = 64 - amPmHeight - padding; }
        else if (tCX >= 32 && tCY < 32) { cX = padding; cY = 64 - amPmHeight - padding; }
        else if (tCX < 32 && tCY >= 32) { cX = 64 - amPmWidth - padding; cY = padding; }
        else { cX = padding; cY = padding; }
        image.print(f8, cX, cY, amPmStr);
    }
    
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

async function pushClockToTuneshine() {
    const host = mysettings.tuneshine_host; if (!host) return;
    log(`[API] Sending POST for Clock screen...`);
    try {
        await fetch(`http://${host}/image`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ trackName: "Idle", idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/clock.png?t=${Date.now()}` }) 
        }).then(res => {
            log(`[API] POST acknowledged (Status: ${res.status})`);
            if (res.ok) { svc_status.set_status(`Idle (Clock)`, false); }
        });
    } catch (err) { errLog(`[API Error] Failed to push clock: ${err.message}`); }
}

async function generatePauseBuffer() {
    let image = preDimmedBackgroundJimp ? preDimmedBackgroundJimp.clone() : new Jimp(64, 64, 0x111111FF);
    const bar = new Jimp(8, 24, 0xFFFFFFFF);
    image.composite(bar, 20, 20); image.composite(bar, 36, 20);
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

async function pushPauseToTuneshine() {
    const host = mysettings.tuneshine_host; if (!host) return;
    log(`[API] Sending POST for Pause screen...`);
    try {
        await fetch(`http://${host}/image`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ trackName: "Paused", idle: true, imageUrl: `http://${getLocalIp()}:${proxyPort}/image/pause.png?t=${Date.now()}` }) 
        }).then(res => {
            log(`[API] POST acknowledged (Status: ${res.status})`);
            if (res.ok) { svc_status.set_status(`Paused`, false); }
        });
    } catch (err) { errLog(`[API Error] Failed to push pause: ${err.message}`); }
}

function updateBrightness() {
    const host = mysettings.tuneshine_host; if (!host) return;
    try {
        fetch(`http://${host}/brightness`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: Number(mysettings.active_brightness) || 80, idle: Number(mysettings.idle_brightness) || 20 }) });
    } catch (err) {}
}