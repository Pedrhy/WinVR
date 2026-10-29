# WinVR — High-Performance Windows to Mobile VR Pipeline

**WinVR** transforms any modern smartphone into a wireless PC VR display over local Wi-Fi. It streams desktop game windows or full desktop environments directly to a mobile browser in stereoscopic 3D, featuring hardware-accelerated WebRTC encoding, custom WebGL shader tone-mapping, optical lens convergence calibration, and sub-millisecond gyroscope head-tracking translation.

---

## Key Technical Features

### 1. Modular Dashboard & Ergonomic Control Interface
- **Structured Visual Hierarchy**: Built with a clean, high-contrast dark theme utilizing glassmorphism surfaces, clear functional grouping, accessible typography, subtle elevation borders, and responsive layouts across all viewport sizes.
- **Precision Controls & Live Telemetry**: Segmented pill selectors for projection modes (`FPV Dome`, `Cinema`, `3D SBS`), dynamic FPS presets (`30`, `60`, `90`, `120 FPS`), and streaming profiles. Calibrated sliders provide millimeter-accurate physical optical adjustments with monospace numerical readouts.
- **Customizable Layout**: Modular collapsible cards with chevron toggles, custom drag-and-drop section rearrangement, and persistent user configuration.

---

### 2. Dynamic Frame Pacing & Performance Engine
- **Live Frame Rate Throttling (30 to 120 FPS)**: Dynamically adjusts streaming frame rate mid-session without restarting the stream or WebRTC peer connection.
- **Dual-Layer Frame Pacing Pipeline**:
  1. **Capture Pacing**: `MediaStreamTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } })` governs the Windows desktop capture engine.
  2. **Encoder Pacing**: `RTCRtpSender.setParameters({ encodings: [{ maxFramerate: fps, degradationPreference: 'maintain-framerate' }] })` coordinates hardware video encoding (NVENC / QuickSync / AMF).
- **Diagnostics Telemetry**: Real-time monitoring distinguishing **Target FPS** from **Delivered FPS**, network round-trip time (`LAN RTT`), and dropped frames.
- **State Persistence**: Selected performance and optical parameters persist via `localStorage` and restore automatically upon reconnection.

---

### 3. Lifecycle & Viewport Synchronization
- **Background Throttling Mitigation**: Browsers suspend `requestAnimationFrame` and compress inactive viewports when switching application windows or backgrounding tabs.
- **`ViewportLayoutManager`**: Monitors `resize`, `visibilitychange`, `pageshow`, and `focus` events. Upon viewport reactivation, it schedules staged layout passes, updates canvas render targets, and maintains continuous video decode without stream renegotiation.

---

### 4. Ultra-Low Latency LAN Streaming Pipeline
- **Expanded Kernel Socket Buffers (16 MB)**: Sets `SO_SNDBUF` and `SO_RCVBUF` to 16 MB across Windows TCP and UDP socket stacks to eliminate buffer bloat and driver-level packet queuing.
- **High-Throughput UDP Worker (Port 8082)**: Runs a dedicated background UDP worker (`WinVR_UDP_Worker`) delivering sub-millisecond gyroscope datagram processing.
- **Zero Nagle Coalescing (`TCP_NODELAY`)**: Explicitly disables Nagle's packet buffering algorithm across HTTP, HTTPS, and WebSocket connections (`NoDelay = true`).
- **Desynchronized WebGL Pipeline (`desynchronized: true`)**: Configures mobile WebGL context to bypass Android Chrome compositor double-buffering, eliminating frame presentation latency.
- **Zero Playout Delay (`playoutDelayHint = 0`)**: Overrides default 150–250 ms WebRTC jitter buffers (`receiver.playoutDelayHint = 0`, `receiver.jitterBufferTarget = 0`) for real-time interactive response.

---

### 5. Optical Calibration & Double Vision Correction
- **Independent Stereoscopic Convergence**: Independent horizontal convergence ($-30\text{ mm}$ to $+30\text{ mm}$) and vertical alignment ($-15\text{ mm}$ to $+15\text{ mm}$) sliders calibrate stereoscopic views into a unified 3D focal image.
- **Physical IPD & Center Split**: Calibrated separation control (40% to 60%) with micro-nudge stepping to align cleanly with diverse headset nose bridges and optical centers.
- **Projection Modes**:
  - **FPV Panoramic Dome**: $195^\circ \times 115^\circ$ curved dome projection with $105^\circ$ FOV for cockpit simulators and first-person games.
  - **Virtual Cinema**: Curved floating screen with adjustable distance and curvature inside an ambient backdrop.
  - **Stereoscopic 3D (Side-by-Side)**: Native 1:1 stereo pass-through for stereoscopic media and 3D titles.

---

### 6. True Color & Anti-Washout Tone Mapping
- **Custom Fragment Shader Pipeline**: Eliminates blown-out highlights and washed-out windshields caused by Windows HDR desktop capture.
- **Targeted Luminance Recovery**: Selectively compresses high-luminance highlights and restores road/environment contrast without crushing dark cabin or cockpit interiors.
- **Hardware-Neutral GLSL Shader**: Pure GPU math executed during texture sampling with 0 ms CPU overhead.

---

## Quick Start

### 1. Launch WinVR
Run the startup script in the `WinVR` directory:
```bat
run.bat
```
*(Or launch `WinVR.exe` directly)*.

The **WinVR Native Controller** starts, launching the **PC Control Dashboard** at `http://localhost:8080`.

### 2. Connect Mobile Client
1. Ensure the smartphone and PC are connected to the **same local Wi-Fi network**.
2. Scan the **QR Code** on the PC dashboard with your phone camera, or browse to `https://<YOUR_PC_IP>:8443/vr.html`.
   > *Note:* Accept the self-signed certificate on initial access. The local HTTPS connection is required by mobile browsers to grant access to hardware orientation sensors and gyroscope APIs.
3. Align optical convergence using the on-screen calibration controls.
4. Tap **"ENTER VR HEADSET"** and insert the phone into your mobile VR headset.

### 3. Select Display Source
1. On the PC Control Dashboard, click **"Select Game / App Window to Cast"**.
2. Select an application window or full display.
3. Configure target frame rates (60, 90, or 120 FPS) and latency profiles as required.

---

## Controls & Navigation

| Action | Function |
|---|---|
| **Head Movement (Yaw / Pitch)** | Translates head orientation to PC cursor / camera view |
| **Single Tap on Phone Screen** | Recenters neutral forward heading |
| **Two-Finger Tap** | Toggles the In-VR Floating Calibration HUD |

---

## Architecture & Repository Structure

```
WinVR/
├── WinVR.exe        # Standalone Native Windows Server & Controller (.NET 4.0+)
├── cert.pfx         # Local SSL certificate for HTTPS (Port 8443) and sensor access
├── build.bat        # Build script using Windows csc.exe compiler
├── run.bat          # Startup script
├── README.md        # Technical documentation
├── src/
│   └── Program.cs   # Dual HTTP/HTTPS server, UDP worker, WebSockets, Win32 input hook
└── web/
    ├── index.html   # PC host control dashboard
    ├── app.css      # Host dashboard design system and responsive layout
    ├── host.js      # WebRTC broadcaster, layout manager, UDP datagram handler
    ├── vr.html      # Mobile VR client and stereo canvas
    ├── vr.css       # Mobile client styling and In-VR HUD
    ├── vr.js        # WebGL rendering engine, tone-mapping shader, sensor fusion
    └── qrcode.js    # ISO/IEC 18004 QR code generator with Reed-Solomon ECC
```
