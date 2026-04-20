# Tuneshine Roon Extension

An unofficial Roon Extension for the [Tuneshine](https://www.tuneshine.rocks/) LED matrix display.

Syncs album artwork, metadata, and playback state from Roon to your Tuneshine over the local network. Features a custom **Stepladder Transition Engine** that creates cinematic blur-to-focus transitions between tracks without crashing the ESP32's limited memory.

## Features

- **Real-Time Playback Sync** — Reacts instantly to play, pause, stop, and skip events via Roon's zone subscription API.
- **Cinematic Focus-Pull Transitions** — Pre-renders Gaussian blur frames at varying radiuses and combines them with the Tuneshine's native hardware dissolve for a theatrical rack-focus effect. New albums get a dramatic reveal; intra-album skips get a subtle acknowledgment.
- **Sovereign Normalization Engine** — Analyzes each image's luminance and saturation to apply proportional contrast, saturation, and black-crush corrections optimized for low-resolution LED panels. Bypasses cleanly when disabled.
- **Idle State Machine** — Paused artwork transitions to a floating clock (with burn-in jitter), then to a pure-black deep idle screen to preserve LED lifespan.
- **Event-Driven Sequencer** — A reactive HTTP proxy monitors when the ESP32 finishes fetching each frame before dispatching the next, with per-stage watchdog timeouts for guaranteed recovery.
- **Configurable via Roon** — All settings (brightness, blur steps, delays, timeouts, normalization) are managed natively inside the Roon Remote app.

## Docker Setup

The container requires **host networking** for Roon's UDP discovery to find the extension.

```yaml
services:
  tuneshine-roon:
    image: colseverinus/tuneshine-roon:latest
    container_name: tuneshine-roon
    network_mode: "host"
    restart: unless-stopped
    environment:
      - TZ=America/Chicago
      - PORT=8090
    volumes:
      - ./tuneshine-config:/usr/src/app/config
```

### Volumes

Mapping a host directory to `/usr/src/app/config` persists your Roon pairing token, Tuneshine IP, zone selection, and all animation preferences across container updates. Without it, settings reset on every restart.

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `TZ` | Timezone for the clock display (e.g. `America/New_York`). | `UTC` |
| `PORT` | Port for the internal HTTP proxy that serves images to the Tuneshine. | `8090` |
| `HOST_IP` | Override the auto-detected LAN IP of the Docker host. Only needed if auto-detection picks the wrong interface. | Auto-detected |

## Roon Settings

Once running, go to **Roon Remote > Settings > Extensions**, enable **Tuneshine Roon Controller**, and click **Settings**.

| Setting | What it does | Range | Default |
| :--- | :--- | :--- | :--- |
| **Tuneshine Host / IP** | Local IP or hostname of your Tuneshine device. | — | — |
| **Zone to Monitor** | Which Roon zone to track. | Dropdown | — |
| **Enable Image Normalization** | Toggles the LED normalization engine (contrast, saturation, black crush). | On/Off | On |
| **New Album Blur Steps** | Number of blur frames for cross-album transitions. 0 disables the blur entirely. | 0–5 | 2 |
| **Intra-Album Blur Steps** | Number of blur frames for same-album track skips. | 0–5 | 1 |
| **Hardware Dissolve Delay** | Time (ms) given to the ESP32 for its native crossfade between frames. Values below 1000ms may cause issues on slower networks. | 800–5000 | 1000 |
| **Clock Timeout** | Seconds before paused artwork transitions to the floating clock. | 5–3600 | 60 |
| **Deep Idle Timeout** | Minutes before the clock transitions to a pure-black screen. | 1–1440 | 10 |
| **Active Brightness** | Display brightness during playback. | 1–100 | 80 |
| **Idle Brightness** | Display brightness for clock and deep idle screens. | 1–100 | 20 |

## How It Works

The ESP32 inside the Tuneshine can't handle animated images or rapid HTTP connections without heap exhaustion crashes. This extension solves that by acting as a pacing governor between Roon and the hardware.

When a track changes, the extension:

1. Fetches the artwork from Roon at 256x256 and applies LED normalization.
2. Pre-renders a series of progressively less-blurred Baseline JPEGs to disk (the "Stepladder").
3. Sends the first (most blurred) frame URL to the Tuneshine.
4. Waits for the ESP32 to finish downloading it (confirmed via the HTTP proxy's response event).
5. Pauses for 150ms (the "breather") to let the ESP32 clear its DMA buffer.
6. Sends the next frame. Repeats until the sharp image is displayed.

If the hardware stalls at any point, a per-stage watchdog forces the final sharp image through. If the user skips tracks mid-transition, all in-flight async work is instantly killed via checkpoint guards.

## Docker Hub

[colseverinus/tuneshine-roon](https://hub.docker.com/r/colseverinus/tuneshine-roon)

## License

Unofficial community project. Not affiliated with Tuneshine or Roon Labs.
