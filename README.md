# ⚡ WinVR - Windows Display to VR Converter

**WinVR** turns any mobile phone into a wireless PC VR headset over your local Wi-Fi. Stream specific application windows (OBS-style) or your entire desktop directly to your phone in stereoscopic VR, with realistic Meta Quest style 180° FPV gaming dome immersion, curved IMAX virtual cinema, and ultra-low latency LAN streaming powered by Moonlight / Steam Link architecture.

---

## 🌟 Architecture & Core Features

### 1. 🎨 Airbnb-Level UI/UX Redesign
- **Clarity, Spacing & Visual Hierarchy**:
  Completely redesigned interface inspired by Airbnb's design philosophy: refined obsidian slate surfaces, generous yet purposeful breathing room, crisp typography (`Circular` / `-apple-system`), subtle 1px borders, and restrained elevation shadows.
- **Tactile Segmented Controls & Sliders**:
  Airbnb-style pill controls for display modes (`🚀 FPV Dome`, `🎬 Cinema`, `👓 3D SBS`), quick FPS presets (`30`, `60`, `90`, `120 FPS`), and LAN streaming profiles. Range sliders feature high-precision feedback with live monospace numerical pills.
- **Eliminated Clutter with Preserved Functionality**:
  Clean, modular cards with clear distinctions between primary capture actions and advanced tuning. Zero features were removed.

---

### 2. ⚡ Dynamic FPS Controller & Performance Engine
- **User-Adjustable Target FPS Slider (30 to 120 FPS)**:
  Adjust streaming frame rate dynamically during an active streaming session without needing to restart the stream or reload the page.
- **Dual-Layer Frame Pacing**:
  1. `MediaStreamTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } })` dynamically re-paces DesktopCaptureEngine frame capture.
  2. `RTCRtpSender.setParameters({ encodings: [{ maxFramerate: fps, degradationPreference: 'maintain-framerate' }] })` paces the hardware video encoder (NVENC / QuickSync / AMF) at the WebRTC transport layer.
- **Honest Real-Time Diagnostics Telemetry**:
  Distinguishes the user's selected **Target FPS** (e.g. `60 FPS`) from the **Actual Delivered FPS** (e.g. `59.9 FPS`), network round-trip latency (e.g. `2 ms LAN RTT`), and dropped frames.
- **Persistent Preferences**:
  Target FPS is persisted to `localStorage` (`winvr_target_fps`) and automatically restored upon launch.

---

### 3. 🛡️ Browser Tab & Window Switching Bug Fix
- **Root Cause**:
  When switching tabs in the browser or switching to another application, Chromium engines throttle background execution, drop `clientWidth`/`clientHeight` to 0, cancel fullscreen, and suspend `requestAnimationFrame`. When returning, stale cached dimensions and lack of responsive layout synchronization left the primary window permanently locked into a compressed mobile view.
- **`ViewportLayoutManager` Fix**:
  Implemented in `web/host.js` and `web/vr.js` listening to `resize`, `visibilitychange`, `pageshow`, and `focus`. On return, it forces immediate and staged layout passes, dynamically calculates actual viewport dimensions, applies the correct view classes (`is-desktop-view`, `is-tablet-view`, `is-mobile-view`), re-measures canvases, and ensures video playback continues seamlessly without tearing, stuck layouts, or stream resets.

---

### 4. 🚀 LAN Gaming Ultra-Low Latency Engine (Moonlight / Steam Link)
- **16MB Operating System Socket Buffers**:
  Forces `SO_SNDBUF` and `SO_RCVBUF` to 16MB across Windows TCP and UDP socket stacks, preventing buffer bloat.
- **UDP Datagram Server (Port 8082)**:
  Dedicated high-throughput UDP socket running on independent background thread (`WinVR_UDP_Worker`) for sub-millisecond head tracking and control datagrams.
- **TCP_NODELAY Enabled Everywhere**:
  Nagle's packet coalescing algorithm is explicitly disabled across HTTP, HTTPS, and WebSocket connections (`NoDelay = true`).
- **Desynchronized WebGL Pipeline (`desynchronized: true`)**:
  WebGL contexts bypass Android Chrome's compositor double-buffer queue, saving ~16ms input delay.
- **0ms Jitter Buffer Target**:
  Bypasses standard 150-250ms playout delays (`receiver.playoutDelayHint = 0`, `receiver.jitterBufferTarget = 0`).

---

### 5. 👁️ Optical Tuning & Double Vision Fix
- **Direct Stereoscopic Image Convergence**:
  Adjust Horizontal Convergence (`-30mm` to `+30mm`) and Vertical Level Alignment (`-15mm` to `+15mm`) sliders to fuse left and right views into **ONE unified 3D image**, then click `💾 Save Alignment as Default`.
- **Live Center Separator Adjustment**:
  Live center split slider (40% to 60%) with micro-nudge buttons (`◀ Left 0.2%`, `Right 0.2% ▶`, `Reset 50%`) to align directly with your headset's nose bridge.
- **3 Immersion Modes**:
  - 🚀 **FPV 180° Game Dome**: Meta Quest panoramic curved dome ($195^\circ \times 115^\circ$, $105^\circ$ FOV).
  - 🎬 **Virtual Cinema (IMAX)**: Floating curved screen in a 3D starfield universe.
  - 👓 **3D SBS (Side-by-Side)**: Native stereoscopic 3D for 3D movies and VR games.

---

## 🚀 Quick Start

### 1. Launch WinVR
In the `WinVR` folder, double-click:
```bat
run.bat
```
*(Or run `WinVR.exe` directly)*.

The **WinVR Native Controller** will open, and your default browser will launch the **PC Control Dashboard** at `http://localhost:8080`.

### 2. Connect Your Phone
1. Connect your phone to the **same Wi-Fi network** as your PC.
2. Scan the **HTTPS QR code** on the PC screen (or navigate to `https://<YOUR_PC_IP>:8443/vr`).
   > *Note on first visit:* Mobile browsers will display "Connection is not private" (because it's a self-signed local LAN certificate). Tap **Advanced -> Proceed to [IP] (unsafe)**. This is normal for local network servers and unlocks all motion sensors!
3. Before entering VR, adjust the **Double Vision Convergence** slider until the screen comfortably fuses into one clear image.
4. Tap **"ENTER VR HEADSET"** and slot your phone into your headset!

### 3. Cast Any Window & Adjust FPS
1. On the PC Control Dashboard (`http://localhost:8080`), click:
   **"Select Game / App Window to Cast"**
2. Choose your game window, VLC player, or entire monitor.
3. Use the **Stream Performance & Frame Rate** slider to select your desired target FPS (e.g. 60 FPS, 90 FPS, or 120 FPS).

---

## 🎮 Head-Tracking & Touch Controls

| Action | Function |
|---|---|
| **Head Movement (Yaw / Pitch)** | Moves PC mouse / aims camera in games |
| **Single Tap on Phone Screen** | Instantly snaps / recenters neutral forward heading |
| **Two-Finger Tap** | Opens / Closes the In-VR Floating Tuning HUD |

---

## 🛠️ Project Structure

```
WinVR/
├── WinVR.exe        # Standalone Native Windows Server & Controller (.NET 4.0+)
├── cert.pfx         # SSL Certificate for local HTTPS (Port 8443)
├── build.bat        # Recompile script (using Windows built-in csc.exe)
├── run.bat          # 1-click launch script
├── README.md        # Documentation
├── src/
│   └── Program.cs   # Dual HTTP/HTTPS Server, UDP 8082 Fast Server, WebSockets, Win32 Mouse Hook
└── web/
    ├── index.html   # PC Host Control Dashboard (Airbnb Design, FPS Slider, Diagnostics)
    ├── app.css      # Airbnb-inspired Design System, Responsive Breakpoints, Glassmorphism
    ├── host.js      # ViewportLayoutManager, FpsController, WebRTC Broadcaster, UDP Chunker
    ├── vr.html      # Mobile VR Client View (Polished Airbnb Setup Overlay & HUD)
    ├── vr.css       # Mobile stereoscopic styling & In-VR HUD
    ├── vr.js        # Desynchronized WebGL, LifecycleManager, sensor fusion, UDP DataChannel
    └── qrcode.js    # Pure JS Offline QR Code generator
```
