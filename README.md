# Tuneshine Roon Extension

An unofficial Roon Extension for the [Tuneshine](https://www.tuneshine.rocks/) LED matrix display.

This extension syncs your Roon Server's album artwork and metadata directly to your local Tuneshine device over the network. It features a custom **Reactive Dissolve Engine** that pushes the ESP32 hardware to its limits to create cinematic blur transitions between tracks without crashing the display (which happened a lot during development 😄 )

## Features

* **Real-Time Sync:** Utilizes Roon's WebSocket API to react to play, pause, and skip events.

* **Cinematic Focus-Pull Transitions:** Generates mathematical Gaussian blur frames and utilizes the Tuneshine's native hardware crossfading to create smooth track transitions.

* **Configurable UI:** Adjust brightness, timeouts, and animation speeds natively inside the Roon Remote application.

* **Deep Idle States:** Automatically dims to a beautiful floating Clock screen when paused, and eventually falls back to a pure black "Deep Idle" state to preserve LED hardware life.

* **Event-Driven Daisy Chain:** Implements a custom HTTP proxy sequencer that waits for the ESP32 microcontroller to acknowledge file downloads, resulting in 100% crash-free transitions.

## Installation (Docker)

Docker Image is hosted here - https://hub.docker.com/r/colseverinus/tuneshine-roon

Because Roon relies on UDP broadcasts to discover extensions on the network, the Docker container **must** run using host networking (`network_mode: "host"`).

### Environment Variables

You can customize the extension behavior by passing the following environment variables to the Docker container:

| Variable | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| `PORT` | The port the internal HTTP proxy server listens on. | `8090` | No |
| `TZ` | Timezone for the clock display (e.g., `America/New_York`). | `UTC` | No |
| `CLOCK_FORMAT` | Set to `12` or `24` for the clock display format. | `12` | No |
| `HOST_IP` | Manually specify the LAN IP of the Docker host if auto-detection fails. | *Auto-detected* | No |
| `TUNESHINE_HOST` | The IP address of your Tuneshine (can also be configured via Roon UI). | `""` | No |


## Configuration

Once the container is running:

1. Open your **Roon Remote** app on your phone, tablet, or PC.

2. Go to **Settings > Extensions**.

3. You will see **Tuneshine Display Controller** listed. Click **Enable**.

4. Click **Settings** next to the extension.

5. Provide the details for your setup:

| Setting Name | Description | Range | Default |
| :--- | :--- | :--- | :--- |
| **Tuneshine Host / IP** | The local network IP address or hostname of your Tuneshine hardware. | N/A | None |
| **Zone to Monitor** | The specific Roon playback zone the extension will track and display. | List of Zones | None |
| **New Album Blur Steps (0-5)** | The number of intermediate blur frames generated when a new album starts. 0 = Bypass | 0 — 5 | 2 |
| **Intra-Album Blur Steps (0-5)** | The number of quick blur frames generated when skipping tracks within the same album. 0 = Bypass | 0 — 5 | 1 |
| **Hardware Dissolve Delay (750-5000ms)** | The amount of time (in ms) allowed for the ESP32 to perform each hardware crossfade. **Warning:** Even though <1000 is allowed, it may cause issues if your network speed is slow | 750 — 5000 | 2000 |
| **Clock Timeout (5-3600s)** | How long the "Paused" art stays on screen before transitioning to the floating Clock. | 5 — 3600 | 60 |
| **Deep Idle Timeout (1-1440m)** | How long the Clock stays active before the screen turns pure black to save LED life. | 1 — 1440 | 10 |
| **Active Brightness (1-100)** | The hardware brightness level used during active music playback. | 1 — 100 | 80 |
| **Idle Brightness (1-100)** | The hardware brightness level used for the Clock and Deep Idle screens. | 1 — 100 | 20 |

Click **Save**. The moment music begins playing in your selected zone, your Tuneshine will awaken and sync to the track!

## Why is it built this way?

The ESP32 microcontroller inside the Tuneshine has extreme RAM limitations. Attempting to send high-framerate animated WebP or GIF files to the display causes a heap exhaustion crash (`HTTP_FAIL_ERROR`).

To bypass this, this extension acts as a smart micro-server. When a track changes, Node.js instantly pre-renders a sequence of static PNGs with varying blur radiuses (the "Stepladder"). It serves the first frame to the Tuneshine, monitors the HTTP network pipe to confirm exactly when the hardware finishes downloading it, and then waits for the hardware's native crossfade to finish before serving the next frame. The result is a cinematic-like focus-pull that uses zero video memory.
