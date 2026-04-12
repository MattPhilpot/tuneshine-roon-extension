# Tuneshine Roon Extension

A hyper-optimized, hardware-accelerated Roon integration for the [Tuneshine](https://www.tuneshine.rocks/) LED matrix display.

This extension syncs your Roon Server's album artwork and metadata directly to your local Tuneshine device over the network. It features a custom **Reactive Dissolve Engine** that pushes the ESP32 hardware to its limits to create gorgeous cinematic blur transitions between tracks without crashing the display.

## Features

* **Real-Time Sync:** Utilizes Roon's WebSocket API for instantaneous reaction to play, pause, and skip events.

* **Cinematic Focus-Pull Transitions:** Dynamically generates mathematical Gaussian blur frames and utilizes the Tuneshine's native hardware crossfading to create butter-smooth track transitions.

* **Configurable UI:** Adjust brightness, timeouts, and animation speeds natively inside the Roon Remote application.

* **Deep Idle States:** Automatically dims to a beautiful floating Clock screen when paused, and eventually falls back to a pure black "Deep Idle" state to preserve LED hardware life.

* **Event-Driven Daisy Chain:** Implements a custom HTTP proxy sequencer that waits for the ESP32 microcontroller to acknowledge file downloads, resulting in 100% crash-free transitions.

## Installation (Docker)

Because Roon relies on UDP broadcasts to discover extensions on the network, the Docker container **must** run using host networking (`network_mode: "host"`).

## Configuration

Once the container is running:

1. Open your **Roon Remote** app on your phone, tablet, or PC.

2. Go to **Settings > Extensions**.

3. You will see **Tuneshine Display Controller** listed. Click **Enable**.

4. Click **Settings** next to the extension.

5. Provide the details for your setup:

   * **Tuneshine Host / IP:** Enter your Tuneshine's local IP (e.g. `192.168.1.50`).

   * **Zone to Monitor:** Select your primary listening zone from the dropdown.

   * **New Album Blur Steps:** Controls the length/drama of the focus-pull transition when a completely new album is played.

   * **Intra-Album Blur Steps:** Controls the quick "mini-blur" cue when skipping tracks on the same album.

   * **Hardware Dissolve Delay:** The delay (in ms) given to the ESP32 chip to render its dissolve. *(Keep above 1000ms to prevent buffer exhaustion).*

Click **Save**. The moment music begins playing in your selected zone, your Tuneshine will awaken and sync to the track!

## Why is it built this way?

The ESP32 microcontroller inside the Tuneshine has extreme RAM limitations. Attempting to send high-framerate animated WebP or GIF files to the display causes a heap exhaustion crash (`HTTP_FAIL_ERROR`).

To bypass this, this extension acts as a smart micro-server. When a track changes, Node.js instantly pre-renders a sequence of static PNGs with varying blur radiuses (the "Stepladder"). It serves the first frame to the Tuneshine, monitors the HTTP network pipe to confirm exactly when the hardware finishes downloading it, and then waits for the hardware's native crossfade to finish before serving the next frame. The result is a perfect, cinematic focus-pull that uses zero video memory.
```
