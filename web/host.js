/**
 * WinVR Host - PC Screen / Window Capture & WebRTC Broadcaster
 * Upgraded with ViewportLayoutManager, FpsController, and High-Throughput Telemetry
 */
(function() {
    'use strict';

    // MTU Payload Chunking Helper (1400 - 7680 bytes)
    const MtuChunker = {
        CHUNK_SIZE: 7680,

        send: function(channel, rawString) {
            if (!channel || channel.readyState !== 'open') return false;
            if (rawString.length <= 1400) {
                channel.send(rawString);
                return true;
            }
            const id = Math.floor(Math.random() * 1000000).toString(36);
            const total = Math.ceil(rawString.length / this.CHUNK_SIZE);
            for (let i = 0; i < total; i++) {
                const chunk = rawString.substr(i * this.CHUNK_SIZE, this.CHUNK_SIZE);
                channel.send(JSON.stringify({
                    _c: 1,
                    id: id,
                    idx: i,
                    tot: total,
                    data: chunk
                }));
            }
            return true;
        },

        _pending: {},
        receive: function(packetStr, onComplete) {
            if (typeof packetStr !== 'string' || !packetStr.startsWith('{"_c":1')) {
                onComplete(packetStr);
                return;
            }
            try {
                const p = JSON.parse(packetStr);
                if (!this._pending[p.id]) {
                    this._pending[p.id] = { parts: new Array(p.tot), received: 0 };
                }
                const item = this._pending[p.id];
                if (!item.parts[p.idx]) {
                    item.parts[p.idx] = p.data;
                    item.received++;
                }
                if (item.received === p.tot) {
                    const fullStr = item.parts.join('');
                    delete this._pending[p.id];
                    onComplete(fullStr);
                }
            } catch (e) {
                onComplete(packetStr);
            }
        }
    };

    const state = {
        ws: null,
        pc: null,
        stream: null,
        clientConnected: false,
        httpUrl: '',
        httpsUrl: '',
        activeUrl: '',
        lanBitrate: 35, // Optimal 35 Mbps for stutter-free, zero-bufferbloat LAN gaming
        targetFps: 60, // Target streaming frame rate (30 - 120 FPS)
        dataChannel: null, // Ultra-low latency UDP DataChannel for controls
        keyFramesGenerated: 0,
        config: {
            mouseLookEnabled: false, // Default OFF to ensure desktop stability
            yawSensitivity: 2.0,
            pitchSensitivity: 1.8,
            smoothing: 0.0, // 0.0 default for 0ms raw instant gaming!
            deadzone: 0.003,
            noiseFloor: 0.008, // Eliminates creeping drift when stationary
            invertX: false,
            invertY: false
        },
        streamResolution: {
            width: 2560,
            height: 1440
        },
        phoneResolution: null,
        lanBitrate: 65, // 65 Mbps default: Zero buffer queuing for instant steering response
        vr: {
            mode: 'dome', // 'dome' | 'cinema' | 'sbs'
            dividerRatio: 0.50,
            lensOffset: 0.0,
            shiftX: 0.0, // Horizontal stereoscopic convergence shift in mm
            shiftY: 0.0, // Vertical level shift in mm
            ipd: 63,
            fov: 105,
            distance: 4.5, // Movie screen distance in meters (1.0m - 50.0m)
            scale: 1.4,    // Movie screen scale (0.5 - 8.0)
            elevation: 0.0, // Vertical screen height offset (-2.0m to +2.0m)
            curved: true,   // Curved IMAX vs Flat
            blackLevel: 0.0,    // Studio-to-Full range black clamp (0.0 = 1:1 monitor reference)
            whiteLevel: 1.0,    // Studio-to-Full range white clamp (1.0 = 1:1 monitor reference)
            exposure: 1.00,     // Daylight exposure multiplier (1.00 = 1:1 monitor reference)
            highlightCut: 0.00, // Intelligent highlight roll-off (0.00 = 1:1 monitor reference)
            shadowBoost: 0.00,  // Cockpit interior shadow compensation (0.00 = 1:1 inky blacks)
            gamma: 1.00,        // Deepens road asphalt and shadow depth (1.00 = 1:1 monitor reference)
            contrast: 1.00,     // Dynamic contrast pop (1.00 = 1:1 monitor reference)
            brightness: 0.00,   // Black level offset (0.00 = 1:1 monitor reference)
            saturation: 1.00    // Natural color saturation (1.00 = 1:1 monitor reference)
        },
        gyro: {
            yaw: 0,
            pitch: 0,
            dx: 0,
            dy: 0
        }
    };

    // Load saved FPS target from local storage
    try {
        const savedFps = localStorage.getItem('winvr_target_fps');
        if (savedFps) {
            const parsed = parseInt(savedFps, 10);
            if (!isNaN(parsed) && parsed >= 30 && parsed <= 120) {
                state.targetFps = parsed;
            }
        }
    } catch (e) {}

    // DOM Elements - Status & Preview
    const badgeServerDot = document.getElementById('badgeServerDot');
    const badgeServerText = document.getElementById('badgeServerText');
    const badgeClientDot = document.getElementById('badgeClientDot');
    const badgeClientText = document.getElementById('badgeClientText');
    const previewVideo = document.getElementById('previewVideo');
    const previewPlaceholder = document.getElementById('previewPlaceholder');
    const previewStats = document.getElementById('previewStats');
    const statRes = document.getElementById('statRes');
    const statFps = document.getElementById('statFps');
    const btnPickWindow = document.getElementById('btnPickWindow');
    const btnStopStream = document.getElementById('btnStopStream');
    const chkIncludeAudio = document.getElementById('chkIncludeAudio');
    const txtMobileUrl = document.getElementById('txtMobileUrl');
    const btnCopyUrl = document.getElementById('btnCopyUrl');
    const qrcodeContainer = document.getElementById('qrcodeContainer');

    // FPS Engine Controls
    const rangeFps = document.getElementById('rangeFps');
    const valFps = document.getElementById('valFps');
    const btnFps30 = document.getElementById('btnFps30');
    const btnFps60 = document.getElementById('btnFps60');
    const btnFps90 = document.getElementById('btnFps90');
    const btnFps120 = document.getElementById('btnFps120');
    const statTargetFps = document.getElementById('statTargetFps');
    const statDeliveredFps = document.getElementById('statDeliveredFps');
    const statRtt = document.getElementById('statRtt');
    const statDroppedFrames = document.getElementById('statDroppedFrames');
    const fpsPresetButtons = [btnFps30, btnFps60, btnFps90, btnFps120];

    // VR Calibration Controls
    const valVrMode = document.getElementById('valVrMode');
    const btnModeDome = document.getElementById('btnModeDome');
    const btnModeDomeWide = document.getElementById('btnModeDomeWide');
    const btnModeCinema = document.getElementById('btnModeCinema');
    const btnModeSbs = document.getElementById('btnModeSbs');
    const valCenterSplit = document.getElementById('valCenterSplit');
    const rangeCenterSplit = document.getElementById('rangeCenterSplit');
    const btnNudgeLeft = document.getElementById('btnNudgeLeft');
    const btnNudgeRight = document.getElementById('btnNudgeRight');
    const btnResetSplit = document.getElementById('btnResetSplit');
    const valLensOffset = document.getElementById('valLensOffset');
    const rangeLensOffset = document.getElementById('rangeLensOffset');
    const valHostIpd = document.getElementById('valHostIpd');
    const rangeHostIpd = document.getElementById('rangeHostIpd');
    const valFpvFov = document.getElementById('valFpvFov');
    const rangeFpvFov = document.getElementById('rangeFpvFov');
    const btnRemoteRecenter = document.getElementById('btnRemoteRecenter');

    // Virtual Cinema & Movie Screen Geometry Controls
    const rangeCinemaDistance = document.getElementById('rangeCinemaDistance');
    const valCinemaDistance = document.getElementById('valCinemaDistance');
    const btnDistCloser = document.getElementById('btnDistCloser');
    const btnDistFarther = document.getElementById('btnDistFarther');
    const btnDistReset = document.getElementById('btnDistReset');

    const rangeCinemaScale = document.getElementById('rangeCinemaScale');
    const valCinemaScale = document.getElementById('valCinemaScale');
    const btnScaleDown = document.getElementById('btnScaleDown');
    const btnScaleUp = document.getElementById('btnScaleUp');
    const btnScaleReset = document.getElementById('btnScaleReset');

    const rangeCinemaElevation = document.getElementById('rangeCinemaElevation');
    const valCinemaElevation = document.getElementById('valCinemaElevation');
    const btnElevDown = document.getElementById('btnElevDown');
    const btnElevUp = document.getElementById('btnElevUp');
    const btnElevReset = document.getElementById('btnElevReset');

    const btnToggleCurved = document.getElementById('btnToggleCurved');
    const btnPresetCinemaGrand = document.getElementById('btnPresetCinemaGrand');
    const btnPresetCinemaImax = document.getElementById('btnPresetCinemaImax');
    const btnPresetCinemaClassic = document.getElementById('btnPresetCinemaClassic');
    const btnPresetCinemaCozy = document.getElementById('btnPresetCinemaCozy');
    const btnPresetCinemaDesktop = document.getElementById('btnPresetCinemaDesktop');

    // Stereoscopic Convergence & Alignment Controls (Double Vision Fix)
    const btnSaveCalibration = document.getElementById('btnSaveCalibration');
    const valShiftX = document.getElementById('valShiftX');
    const rangeShiftX = document.getElementById('rangeShiftX');
    const btnShiftXIn = document.getElementById('btnShiftXIn');
    const btnShiftXOut = document.getElementById('btnShiftXOut');
    const btnShiftXReset = document.getElementById('btnShiftXReset');
    const valShiftY = document.getElementById('valShiftY');
    const rangeShiftY = document.getElementById('rangeShiftY');
    const btnShiftYDown = document.getElementById('btnShiftYDown');
    const btnShiftYUp = document.getElementById('btnShiftYUp');
    const btnShiftYReset = document.getElementById('btnShiftYReset');

    // LAN Ultra-Low Latency Engine Controls (Moonlight / Steam Link Architecture)
    const btnPresetSteamLink = document.getElementById('btnPresetSteamLink');
    const btnPresetMoonlight = document.getElementById('btnPresetMoonlight');
    const btnPresetExtreme = document.getElementById('btnPresetExtreme');
    const btnPresetMax = document.getElementById('btnPresetMax');
    const rangeLanBitrate = document.getElementById('rangeLanBitrate');
    const valLanBitrate = document.getElementById('valLanBitrate');
    const statLiveThroughput = document.getElementById('statLiveThroughput');
    const statJitterBuffer = document.getElementById('statJitterBuffer');
    const statCodec = document.getElementById('statCodec');
    const statDataChannel = document.getElementById('statDataChannel');

    // Gyroscope & Mouse Look Controls
    const chkEnableMouseLook = document.getElementById('chkEnableMouseLook');
    const rangeYawSens = document.getElementById('rangeYawSens');
    const valYawSens = document.getElementById('valYawSens');
    const rangePitchSens = document.getElementById('rangePitchSens');
    const valPitchSens = document.getElementById('valPitchSens');
    const rangeSmoothing = document.getElementById('rangeSmoothing');
    const valSmoothing = document.getElementById('valSmoothing');
    const rangeDeadzone = document.getElementById('rangeDeadzone');
    const valDeadzone = document.getElementById('valDeadzone');
    const chkInvertX = document.getElementById('chkInvertX');
    const chkInvertY = document.getElementById('chkInvertY');
    const btnRecenter = document.getElementById('btnRecenter');
    const gyroCanvas = document.getElementById('gyroVisualizer');
    const gyroCtx = gyroCanvas ? gyroCanvas.getContext('2d') : null;

    // =========================================================================
    // Viewport & Lifecycle Layout Manager (Resolves Tab-Switching Mobile Lock)
    // =========================================================================
    const ViewportLayoutManager = {
        layoutTimer: null,

        init: function() {
            this.syncLayoutState('init');

            window.addEventListener('resize', () => {
                clearTimeout(this.layoutTimer);
                this.layoutTimer = setTimeout(() => this.syncLayoutState('resize'), 60);
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    this.syncLayoutState('visibilitychange');
                }
            });

            window.addEventListener('pageshow', () => {
                this.syncLayoutState('pageshow');
            });

            window.addEventListener('focus', () => {
                this.syncLayoutState('focus');
            });
        },

        syncLayoutState: function(reason) {
            const width = window.innerWidth || document.documentElement.clientWidth || 1200;
            document.body.classList.remove('is-desktop-view', 'is-tablet-view', 'is-mobile-view');

            if (width >= 1024) {
                document.body.classList.add('is-desktop-view');
            } else if (width >= 768) {
                document.body.classList.add('is-tablet-view');
            } else {
                document.body.classList.add('is-mobile-view');
            }

            // Re-measure gyro visualizer without corruption
            if (gyroCanvas) {
                const rect = gyroCanvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    gyroCanvas.width = rect.width;
                    gyroCanvas.height = rect.height;
                }
            }

            // Ensure video preview hasn't paused on tab switch
            if (previewVideo && state.stream && previewVideo.paused) {
                previewVideo.play().catch(() => {});
            }
        }
    };

    ViewportLayoutManager.init();

    // =========================================================================
    // Dynamic Range & Highlight Clipping Inspector (Frame Statistics & Telemetry)
    // =========================================================================
    const DynamicRangeInspector = {
        canvas: null,
        ctx: null,
        intervalId: null,
        lastStats: { clipPct: 0, blackFloor: 0, avgLuma: 0 },

        init: function() {
            this.canvas = document.createElement('canvas');
            this.canvas.width = 160;
            this.canvas.height = 90;
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        },

        start: function() {
            if (this.intervalId) return;
            if (!this.canvas) this.init();
            this.intervalId = setInterval(() => this.analyzeFrame(), 600);
        },

        stop: function() {
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
            this.updateUI(0, 0, 0);
        },

        analyzeFrame: function() {
            if (!previewVideo || !state.stream || previewVideo.readyState < 2 || previewVideo.videoWidth === 0) {
                return;
            }
            try {
                this.ctx.drawImage(previewVideo, 0, 0, 160, 90);
                const imgData = this.ctx.getImageData(0, 0, 160, 90);
                const data = imgData.data;
                const totalPixels = 160 * 90;
                let clippedHighlights = 0;
                let minLuma = 255;
                let sumLuma = 0;

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    sumLuma += luma;
                    if (luma < minLuma) minLuma = luma;

                    // Detect hard-clamped specular whites
                    if (r >= 248 && g >= 248 && b >= 248) {
                        clippedHighlights++;
                    }
                }

                const clipPct = Math.round((clippedHighlights / totalPixels) * 1000) / 10;
                const blackFloor = Math.round((minLuma / 255) * 1000) / 10;
                const avgLuma = Math.round((sumLuma / (totalPixels * 255)) * 100);

                this.lastStats = { clipPct, blackFloor, avgLuma };
                this.updateUI(clipPct, blackFloor, avgLuma);

                // Broadcast stats to phone client for in-headset HUD
                sendControlPacket({
                    type: 'stats_update',
                    clipPct: clipPct,
                    blackFloor: blackFloor,
                    avgLuma: avgLuma
                });
            } catch (e) {
                // Ignore transient drawImage exceptions during track setup
            }
        },

        updateUI: function(clipPct, blackFloor, avgLuma) {
            const elClip = document.getElementById('statClipPct');
            const elFloor = document.getElementById('statBlackFloor');
            const elAvg = document.getElementById('statAvgLuma');
            const elBanner = document.getElementById('bannerHdrClippingAlert');

            if (elClip) {
                elClip.textContent = `${clipPct.toFixed(1)}%` + (clipPct > 5.0 ? ' ⚠️ (Severe Clipping)' : (clipPct > 1.0 ? ' (Moderate)' : ' (Clean)'));
                elClip.style.color = clipPct > 5.0 ? '#ef4444' : (clipPct > 1.0 ? '#f59e0b' : 'var(--accent-green)');
            }
            if (elFloor) {
                elFloor.textContent = `${blackFloor.toFixed(1)}%` + (blackFloor > 4.0 ? ' (Studio Lift)' : ' (Inky)');
                elFloor.style.color = blackFloor > 4.0 ? '#f59e0b' : 'var(--accent-green)';
            }
            if (elAvg) {
                elAvg.textContent = `${avgLuma}%`;
            }
            if (elBanner) {
                if (clipPct > 5.0) {
                    elBanner.style.display = 'block';
                    elBanner.innerHTML = `<strong>⚠️ Highlight Clipping Detected (${clipPct.toFixed(1)}%):</strong> Windows HDR is hard-clipping highlights to white during desktop duplication. Click <em>"☀️ Windows HDR Highlight Recovery"</em> below or calibrate the Windows HDR SDR brightness slider.`;
                } else {
                    elBanner.style.display = 'none';
                }
            }
        }
    };

    DynamicRangeInspector.init();

    // =========================================================================
    // FPS Controller (Dynamic Frame Pacing & Telemetry)
    // =========================================================================
    async function applyTargetFps(fps) {
        fps = Math.max(30, Math.min(120, parseInt(fps, 10) || 60));
        state.targetFps = fps;
        try {
            localStorage.setItem('winvr_target_fps', fps.toString());
        } catch (e) {}

        // 1. Update live capture track constraints dynamically without stopping stream
        if (state.stream) {
            const videoTrack = state.stream.getVideoTracks()[0];
            if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
                try {
                    await videoTrack.applyConstraints({
                        frameRate: { ideal: fps, max: fps }
                    });
                } catch (err) {
                    console.warn('[WinVR Host] applyConstraints error:', err);
                }
            }
        }

        // 2. Update WebRTC video sender encoding parameters dynamically
        if (state.pc) {
            const senders = state.pc.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                try {
                    const params = videoSender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.encodings[0].maxFramerate = fps;
                    params.encodings[0].degradationPreference = 'maintain-framerate';
                    await videoSender.setParameters(params);
                } catch (e) {
                    console.warn('[WinVR Host] videoSender setParameters error:', e);
                }
            }
        }

        // 3. Notify mobile client so client adjusts presentation pacing
        sendControlPacket({
            type: 'set_fps',
            targetFps: fps
        });

        updateFpsUI();
    }

    function updateFpsUI() {
        if (rangeFps) rangeFps.value = state.targetFps;
        if (valFps) valFps.textContent = `${state.targetFps} FPS`;
        if (statTargetFps) statTargetFps.textContent = `${state.targetFps} FPS`;
        fpsPresetButtons.forEach(btn => {
            if (btn) btn.classList.toggle('active', parseInt(btn.dataset.fps, 10) === state.targetFps);
        });
    }

    // Bind FPS slider & preset buttons
    if (rangeFps) {
        rangeFps.addEventListener('input', function() {
            applyTargetFps(this.value);
        });
    }

    fpsPresetButtons.forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', function() {
            const fps = parseInt(this.dataset.fps, 10);
            applyTargetFps(fps);
        });
    });

    updateFpsUI();

    // --- Discover PC IP & Generate QR Code ---
    async function loadNetworkInfo() {
        try {
            const res = await fetch('/api/ip');
            const data = await res.json();
            state.httpUrl = data.httpUrl;
            state.httpsUrl = data.httpsUrl;

            state.activeUrl = data.httpsUrl || data.httpUrl;
            txtMobileUrl.value = state.activeUrl;
            renderQr(state.activeUrl);

            if (btnSelectHttp && data.httpPort) {
                btnSelectHttp.textContent = `🌐 HTTP ${data.httpPort}`;
                btnSelectHttp.title = `Use standard HTTP (Port ${data.httpPort})`;
            }
        } catch (e) {
            console.warn('[WinVR] Could not fetch IP endpoint:', e);
            const fallback = window.location.origin + '/vr';
            state.activeUrl = fallback;
            txtMobileUrl.value = fallback;
            renderQr(fallback);
        }
    }

    function renderQr(url) {
        if (window.QRCode && qrcodeContainer) {
            qrcodeContainer.innerHTML = '';
            new QRCode(qrcodeContainer, {
                text: url,
                width: 118,
                height: 118,
                colorDark: '#0a0d14',
                colorLight: '#ffffff'
            });
        }
    }

    btnCopyUrl.addEventListener('click', function() {
        txtMobileUrl.select();
        document.execCommand('copy');
        btnCopyUrl.textContent = 'Copied!';
        setTimeout(() => btnCopyUrl.textContent = 'Copy', 1500);
    });

    const btnSelectHttps = document.getElementById('btnSelectHttps');
    const btnSelectHttp = document.getElementById('btnSelectHttp');

    if (btnSelectHttps) {
        btnSelectHttps.addEventListener('click', function() {
            if (btnSelectHttp) btnSelectHttp.classList.remove('active');
            btnSelectHttps.classList.add('active');
            state.activeUrl = state.httpsUrl;
            txtMobileUrl.value = state.activeUrl;
            renderQr(state.activeUrl);
        });
    }
    if (btnSelectHttp) {
        btnSelectHttp.addEventListener('click', function() {
            if (btnSelectHttps) btnSelectHttps.classList.remove('active');
            btnSelectHttp.classList.add('active');
            state.activeUrl = state.httpUrl;
            txtMobileUrl.value = state.activeUrl;
            renderQr(state.activeUrl);
        });
    }

    // --- WebSocket Signaling & Control ---
    function connectServer() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = protocol + '//' + window.location.host + '/ws';

        state.ws = new WebSocket(wsUrl);

        state.ws.onopen = function() {
            badgeServerDot.className = 'dot dot-green';
            badgeServerText.textContent = 'Server: Ready';

            state.ws.send(JSON.stringify({
                type: 'register',
                role: 'host'
            }));

            sendConfig();
        };

        state.ws.onmessage = async function(event) {
            MtuChunker.receive(event.data, async (fullData) => {
                try {
                    const msg = JSON.parse(fullData);
                    if (msg.type === 'client_connected') {
                        state.clientConnected = true;
                        badgeClientDot.className = 'dot dot-green';
                        badgeClientText.textContent = 'Phone: Connected';

                        sendVrTuning();
                        sendFpsTarget();

                        if (state.stream) {
                            startWebRTC();
                        }
                    } else if (msg.type === 'client_disconnected') {
                        state.clientConnected = false;
                        badgeClientDot.className = 'dot dot-yellow';
                        badgeClientText.textContent = 'Phone: Waiting';
                    } else if (msg.type === 'client_resumed' || msg.type === 'request_keyframe') {
                        triggerKeyFrame(msg.reason || 'client_requested');
                        sendVrTuning();
                        sendFpsTarget();
                    } else if (msg.type === 'webrtc_client_stats') {
                        state.clientStats = msg;
                        const statClientRes = document.getElementById('statClientRes');
                        const statClientJitter = document.getElementById('statClientJitter');
                        const statClientDropped = document.getElementById('statClientDropped');
                        if (statClientRes && msg.decodedWidth && msg.decodedHeight) {
                            statClientRes.textContent = `${msg.decodedWidth}×${msg.decodedHeight}`;
                        }
                        if (statClientJitter && msg.jitterBufferMs !== undefined) {
                            statClientJitter.textContent = `${msg.jitterBufferMs} ms`;
                        }
                        if (statClientDropped && msg.framesDropped !== undefined) {
                            statClientDropped.textContent = `${msg.framesDropped}`;
                        }
                    } else if (msg.type === 'signal') {
                        handleWebRTCSignal(msg.data);
                    } else if (msg.type === 'phone_resolution') {
                        state.phoneResolution = { width: msg.width, height: msg.height, dpr: msg.dpr };
                        const valPhoneDetected = document.getElementById('valPhoneDetected');
                        const btnApplyPhoneRes = document.getElementById('btnApplyPhoneRes');
                        if (valPhoneDetected) {
                            valPhoneDetected.textContent = `${msg.width} × ${msg.height} (${msg.dpr}x DPR)`;
                            valPhoneDetected.style.color = 'var(--accent-green)';
                        }
                        if (btnApplyPhoneRes) {
                            btnApplyPhoneRes.style.display = 'inline-flex';
                            btnApplyPhoneRes.textContent = `⚡ Match Phone (${msg.width}×${msg.height})`;
                        }
                    } else if (msg.type === 'gyro_visual') {
                        state.gyro.dx = msg.dx || 0;
                        state.gyro.dy = msg.dy || 0;
                        state.gyro.yaw += state.gyro.dx;
                        state.gyro.pitch += state.gyro.dy;
                    } else if (msg.type === 'stats_update') {
                        if (msg.gyroRate !== undefined && statDataChannel) {
                            statDataChannel.textContent = `Direct WebSocket (${msg.gyroRate} Hz)`;
                        }
                    } else if (msg.type === 'tune_vr') {
                        if (msg.dividerRatio !== undefined && rangeCenterSplit) {
                            rangeCenterSplit.value = (msg.dividerRatio * 100).toFixed(1);
                            valCenterSplit.textContent = rangeCenterSplit.value + '%';
                            state.vr.dividerRatio = msg.dividerRatio;
                        }
                        if ((msg.distance !== undefined || msg.screenDistance !== undefined) && rangeCinemaDistance) {
                            const raw = msg.distance !== undefined ? msg.distance : msg.screenDistance;
                            state.vr.distance = parseFloat(raw);
                            rangeCinemaDistance.value = state.vr.distance.toFixed(1);
                            if (valCinemaDistance) valCinemaDistance.textContent = state.vr.distance.toFixed(1) + ' m';
                        }
                        if ((msg.scale !== undefined || msg.screenScale !== undefined) && rangeCinemaScale) {
                            const raw = msg.scale !== undefined ? msg.scale : msg.screenScale;
                            state.vr.scale = parseFloat(raw);
                            rangeCinemaScale.value = Math.round(state.vr.scale * 100);
                            if (valCinemaScale) valCinemaScale.textContent = Math.round(state.vr.scale * 100) + '%';
                        }
                        if ((msg.elevation !== undefined || msg.screenElevation !== undefined) && rangeCinemaElevation) {
                            const raw = msg.elevation !== undefined ? msg.elevation : msg.screenElevation;
                            state.vr.elevation = parseFloat(raw);
                            rangeCinemaElevation.value = state.vr.elevation.toFixed(1);
                            if (valCinemaElevation) valCinemaElevation.textContent = (state.vr.elevation >= 0 ? '+' : '') + state.vr.elevation.toFixed(1) + ' m';
                        }
                        if (msg.curved !== undefined && btnToggleCurved) {
                            state.vr.curved = Boolean(msg.curved);
                            btnToggleCurved.classList.toggle('active', state.vr.curved);
                            btnToggleCurved.innerHTML = state.vr.curved ? '🌐 Curved IMAX Screen' : '▭ Flat Screen';
                        }
                        if (msg.gamma !== undefined && rangeGamma) {
                            state.vr.gamma = parseFloat(msg.gamma);
                            rangeGamma.value = state.vr.gamma.toFixed(2);
                            if (valGamma) valGamma.textContent = state.vr.gamma.toFixed(2) + (state.vr.gamma > 1.05 ? ' (Deep Asphalt)' : '');
                        }
                        if (msg.exposure !== undefined && rangeExposure) {
                            state.vr.exposure = parseFloat(msg.exposure);
                            rangeExposure.value = state.vr.exposure.toFixed(2);
                            if (valExposure) valExposure.textContent = state.vr.exposure.toFixed(2) + 'x' + (state.vr.exposure < 1.0 ? ' (Anti-Blowout)' : '');
                        }
                        if (msg.highlightCut !== undefined && rangeHighlightCut) {
                            state.vr.highlightCut = parseFloat(msg.highlightCut);
                            rangeHighlightCut.value = state.vr.highlightCut.toFixed(2);
                            const hcPct = Math.round(state.vr.highlightCut * 100);
                            if (valHighlightCut) valHighlightCut.textContent = hcPct + '%' + (hcPct > 20 ? ' (Road Recovered)' : '');
                        }
                        if (msg.shadowBoost !== undefined && rangeShadowBoost) {
                            state.vr.shadowBoost = parseFloat(msg.shadowBoost);
                            rangeShadowBoost.value = state.vr.shadowBoost.toFixed(2);
                            const sbPct = Math.round(state.vr.shadowBoost * 100);
                            if (valShadowBoost) valShadowBoost.textContent = (sbPct > 0 ? '+' : '') + sbPct + '% (Clear Gauges)';
                        }
                        if (msg.brightness !== undefined && rangeBrightness) {
                            state.vr.brightness = parseFloat(msg.brightness);
                            rangeBrightness.value = state.vr.brightness.toFixed(2);
                            const bPct = Math.round(state.vr.brightness * 100);
                            if (valBrightness) valBrightness.textContent = (bPct >= 0 ? '+' : '') + bPct + '%';
                        }
                        if (msg.contrast !== undefined && rangeContrast) {
                            state.vr.contrast = parseFloat(msg.contrast);
                            rangeContrast.value = state.vr.contrast.toFixed(2);
                            const cPct = Math.round((state.vr.contrast - 1.0) * 100);
                            if (valContrast) valContrast.textContent = (cPct >= 0 ? '+' : '') + cPct + '%';
                        }
                        if (msg.saturation !== undefined && rangeSaturation) {
                            state.vr.saturation = parseFloat(msg.saturation);
                            rangeSaturation.value = state.vr.saturation.toFixed(2);
                            const sPct = Math.round((state.vr.saturation - 1.0) * 100);
                            if (valSaturation) valSaturation.textContent = (sPct >= 0 ? '+' : '') + sPct + '%';
                        }
                    } else if (msg.type === 'tune_crosshair') {
                        if (msg.shiftX !== undefined && rangeShiftX) {
                            state.vr.shiftX = parseFloat(msg.shiftX);
                            rangeShiftX.value = state.vr.shiftX.toFixed(1);
                            if (valShiftX) valShiftX.textContent = (state.vr.shiftX >= 0 ? '+' : '') + state.vr.shiftX.toFixed(1) + ' mm';
                        }
                        if (msg.shiftY !== undefined && rangeShiftY) {
                            state.vr.shiftY = parseFloat(msg.shiftY);
                            rangeShiftY.value = state.vr.shiftY.toFixed(1);
                            if (valShiftY) valShiftY.textContent = (state.vr.shiftY >= 0 ? '+' : '') + state.vr.shiftY.toFixed(1) + ' mm';
                        }
                    } else if (msg.type === 'save_calibration') {
                        if (msg.calibration) {
                            try {
                                localStorage.setItem('winvr_calibration', JSON.stringify(msg.calibration));
                            } catch (e) {}
                        }
                    }
                } catch (err) {
                    console.error('[WinVR] Message error:', err);
                }
            });
        };

        state.ws.onclose = function() {
            badgeServerDot.className = 'dot dot-yellow';
            badgeServerText.textContent = 'Server: Disconnected';
            setTimeout(connectServer, 2000);
        };
    }

    function sendConfig() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'config',
                config: state.config
            }));
        }
    }

    function sendFpsTarget() {
        sendControlPacket({
            type: 'set_fps',
            targetFps: state.targetFps
        });
    }

    function sendControlPacket(msgObj) {
        const raw = JSON.stringify(msgObj);
        if (state.dataChannel && state.dataChannel.readyState === 'open') {
            try {
                if (MtuChunker.send(state.dataChannel, raw)) return;
            } catch (e) {}
        }
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(raw);
        }
    }

    // --- Window / Screen Picker with Dynamic Hot-Swapping & Target FPS ---
    btnPickWindow.addEventListener('click', async function() {
        try {
            const includeAudio = chkIncludeAudio.checked;

            const targetW = state.streamResolution ? state.streamResolution.width : 2560;
            const targetH = state.streamResolution ? state.streamResolution.height : 1440;

            const displayMediaOptions = {
                video: {
                    cursor: 'always',
                    width: { ideal: targetW, max: Math.max(3840, targetW) },
                    height: { ideal: targetH, max: Math.max(2160, targetH) },
                    frameRate: { ideal: state.targetFps || 60, max: state.targetFps || 60 }
                },
                audio: includeAudio ? {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    latency: 0
                } : false,
                surfaceSwitching: 'include',
                selfBrowserSurface: 'include',
                systemAudio: 'include',
                preferCurrentTab: false
            };

            let newStream = null;
            try {
                newStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
            } catch (mediaErr) {
                if (mediaErr.name === 'NotAllowedError') {
                    console.log('[WinVR Host] Screen selection was cancelled by user.');
                    return;
                }
                console.warn('[WinVR Host] Primary display constraints rejected, falling back to clean standard options:', mediaErr);
                try {
                    newStream = await navigator.mediaDevices.getDisplayMedia({
                        video: {
                            width: { ideal: targetW },
                            height: { ideal: targetH },
                            frameRate: { ideal: state.targetFps || 60 }
                        },
                        audio: includeAudio
                    });
                } catch (fallbackErr) {
                    if (fallbackErr.name === 'NotAllowedError') return;
                    console.warn('[WinVR Host] Standard options rejected, falling back to bare minimum:', fallbackErr);
                    newStream = await navigator.mediaDevices.getDisplayMedia({
                        video: true,
                        audio: includeAudio
                    });
                }
            }

            if (!newStream) return;
            const newVideoTrack = newStream.getVideoTracks()[0];
            const newAudioTrack = newStream.getAudioTracks()[0];

            // Set 'motion' to prioritize lowest possible encoder latency and real-time delivery
            if ('contentHint' in newVideoTrack) {
                newVideoTrack.contentHint = 'motion';
            }

            const oldStream = state.stream;

            // Check if we have an active WebRTC peer connection to hot-swap tracks
            let hotSwapped = false;
            if (state.pc && (state.pc.connectionState === 'connected' || state.pc.iceConnectionState === 'connected' || state.pc.iceConnectionState === 'completed')) {
                const senders = state.pc.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === 'video') || senders.find(s => s.track);
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

                if (videoSender) {
                    try {
                        console.log('[WinVR Host] Hot-swapping video track via replaceTrack (0ms stream interruption)...');
                        await videoSender.replaceTrack(newVideoTrack);
                        if (audioSender && newAudioTrack) {
                            await audioSender.replaceTrack(newAudioTrack);
                        }
                        hotSwapped = true;
                    } catch (e) {
                        console.warn('[WinVR Host] replaceTrack failed, falling back to clean renegotiation:', e);
                        hotSwapped = false;
                    }
                }
            }

            // Cleanly release old tracks
            if (oldStream) {
                oldStream.getTracks().forEach(t => {
                    t.onended = null;
                    t.stop();
                });
            }

            state.stream = newStream;
            previewVideo.srcObject = newStream;
            updatePreviewVideoFilter();
            previewPlaceholder.style.display = 'none';
            btnStopStream.style.display = 'inline-flex';
            previewStats.style.display = 'block';

            // Update button label to indicate hot-swap capability
            btnPickWindow.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
                Switch Window / Tab to Cast
            `;

            const settings = newVideoTrack.getSettings();
            statRes.textContent = `${settings.width || 1920}x${settings.height || 1080}`;
            statFps.textContent = `${Math.round(settings.frameRate || state.targetFps)} FPS`;

            const badgeCaptureColorSpace = document.getElementById('badgeCaptureColorSpace');
            if (badgeCaptureColorSpace) {
                badgeCaptureColorSpace.textContent = `8-bit sRGB / Rec.709 (${settings.width || targetW}×${settings.height || targetH})`;
            }
            DynamicRangeInspector.start();

            newVideoTrack.onended = function() {
                stopStream();
            };

            // Detect dynamic browser tab/window changes from browser's top bar
            if ('oncapturehandlechange' in newVideoTrack) {
                newVideoTrack.oncapturehandlechange = () => {
                    console.log('[WinVR Host] Browser tab switched via browser bar');
                    triggerKeyFrame();
                    sendControlPacket({ type: 'stream_swapped' });
                };
            }

            if (hotSwapped) {
                // Apply dynamic FPS constraints and bitrate to the new track
                await applyTargetFps(state.targetFps);
                await applySenderBitrate(state.lanBitrate || 75);

                // Notify mobile client of swapped stream and force keyframe
                triggerKeyFrame();
                sendControlPacket({
                    type: 'stream_swapped',
                    width: settings.width,
                    height: settings.height
                });
                console.log('[WinVR Host] Stream hot-swapped successfully! Mobile stream uninterrupted.');
            } else {
                // If peer connection was not ready or replaceTrack wasn't possible,
                // do a clean peer connection initialization
                if (state.pc) {
                    try { state.pc.close(); } catch (e) {}
                    state.pc = null;
                }
                if (state.dataChannel) {
                    try { state.dataChannel.close(); } catch (e) {}
                    state.dataChannel = null;
                }
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({ type: 'reset_peer' }));
                    state.ws.send(JSON.stringify({ type: 'host_ready' }));
                }

                if (state.clientConnected) {
                    startWebRTC();
                }
            }
        } catch (err) {
            console.warn('[WinVR] Screen capture cancelled or failed:', err);
            if (err && err.name !== 'NotAllowedError') {
                alert('Screen capture failed: ' + (err.message || err.name));
            }
        }
    });

    function stopStream() {
        if (state.stream) {
            state.stream.getTracks().forEach(t => {
                t.onended = null;
                t.stop();
            });
            state.stream = null;
        }
        previewVideo.srcObject = null;
        previewVideo.style.filter = 'none';
        DynamicRangeInspector.stop();
        previewPlaceholder.style.display = 'flex';
        btnStopStream.style.display = 'none';
        btnPickWindow.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            Select Game / App Window to Cast
        `;
        previewStats.style.display = 'none';

        stopStatsMonitor();

        sendControlPacket({ type: 'stream_stopped' });

        if (state.dataChannel) {
            try { state.dataChannel.close(); } catch (e) {}
            state.dataChannel = null;
        }
        if (statDataChannel) statDataChannel.textContent = 'UDP DataChannel';

        if (state.pc) {
            try { state.pc.close(); } catch (e) {}
            state.pc = null;
        }
    }

    btnStopStream.addEventListener('click', stopStream);

    // --- Advanced SDP Optimization (H.264 High Profile, RTX Packet Repair & LAN Turbo) ---
    function optimizeSdpForGaming(sdp, bitrateMbps) {
        const bitrateKbps = Math.round(bitrateMbps * 1000);
        const bitrateBps = Math.round(bitrateMbps * 1000000);
        const lines = sdp.split('\r\n');

        // 1. Discover all H264 codecs and their fmtp profile-level-ids
        const h264Profiles = {};
        const rtxForCodec = {};
        const h264Payloads = [];

        for (let i = 0; i < lines.length; i++) {
            const mRtp = lines[i].match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
            if (mRtp) {
                h264Payloads.push(mRtp[1]);
            }
            const mFmtp = lines[i].match(/^a=fmtp:(\d+)\s+(.*)$/);
            if (mFmtp) {
                const pt = mFmtp[1];
                const config = mFmtp[2];
                h264Profiles[pt] = config;

                const aptMatch = config.match(/apt=(\d+)/);
                if (aptMatch) {
                    rtxForCodec[aptMatch[1]] = pt;
                }
            }
        }

        // 2. Prioritize Constrained Baseline H.264 (42e0, 4200) for instant <2ms hardware decoding on Android
        // Guarantees zero frame-reordering latency, zero B-frames, and bypasses software decoder fallbacks
        h264Payloads.sort((a, b) => {
            const profA = h264Profiles[a] || '';
            const profB = h264Profiles[b] || '';
            const isBaseA = profA.includes('profile-level-id=42e0') || profA.includes('profile-level-id=4200');
            const isBaseB = profB.includes('profile-level-id=42e0') || profB.includes('profile-level-id=4200');
            if (isBaseA && !isBaseB) return -1;
            if (!isBaseA && isBaseB) return 1;
            const isMainA = profA.includes('profile-level-id=4d00');
            const isMainB = profB.includes('profile-level-id=4d00');
            if (isMainA && !isMainB) return -1;
            if (!isMainA && isMainB) return 1;
            return 0;
        });

        // 3. Assemble ordered payload list keeping each codec immediately paired with its RTX repair channel
        const prioritizedPayloads = [];
        h264Payloads.forEach(pt => {
            if (!prioritizedPayloads.includes(pt)) prioritizedPayloads.push(pt);
            if (rtxForCodec[pt] && !prioritizedPayloads.includes(rtxForCodec[pt])) {
                prioritizedPayloads.push(rtxForCodec[pt]);
            }
        });

        const out = [];
        let inVideo = false;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            if (line.startsWith('m=video ')) {
                inVideo = true;
                if (prioritizedPayloads.length > 0) {
                    const parts = line.split(' ');
                    const header = parts.slice(0, 3);
                    const payloads = parts.slice(3);
                    const remaining = payloads.filter(pt => !prioritizedPayloads.includes(pt));
                    line = header.concat(prioritizedPayloads, remaining).join(' ');
                }
                out.push(line);
                out.push('b=AS:' + bitrateKbps);
                out.push('b=TIAS:' + bitrateBps);
                continue;
            }

            if (line.startsWith('m=audio ') || line.startsWith('m=application ')) {
                inVideo = false;
            }

            if (inVideo && line.startsWith('a=fmtp:')) {
                const ptMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
                if (ptMatch && h264Payloads.includes(ptMatch[1])) {
                    let fmtp = ptMatch[2];
                    if (!fmtp.includes('x-google-min-bitrate')) {
                        // Resilient LAN tuning: 3 Mbps minimum prevents queue freezes on Wi-Fi dips, smooth 20M startup
                        const minKbps = 3000;
                        const startKbps = Math.min(bitrateKbps, 20000);
                        const maxKbps = bitrateKbps;
                        fmtp += `;x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps};x-google-start-bitrate=${startKbps}`;
                    }
                    line = 'a=fmtp:' + ptMatch[1] + ' ' + fmtp;
                }
            }

            out.push(line);
        }

        return out.join('\r\n');
    }

    async function applySenderBitrate(bitrateMbps) {
        if (!state.pc) return;
        const senders = state.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
            try {
                const params = videoSender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = bitrateMbps * 1000000;
                params.encodings[0].maxFramerate = state.targetFps || 60;
                // Strictly lock 1:1 pixel scaling so Chromium never degrades resolution to 720p
                params.encodings[0].scaleResolutionDownBy = 1.0;
                params.encodings[0].degradationPreference = 'maintain-framerate';
                await videoSender.setParameters(params);
            } catch (e) {
                console.warn('[WinVR] setParameters error:', e);
            }
        }
    }

    let lastHostKeyframeTime = 0;
    function triggerKeyFrame(reason) {
        if (!state.pc) return;
        const now = performance.now();
        if (now - lastHostKeyframeTime < 350) return; // Protect NVENC encoder from spam
        lastHostKeyframeTime = now;
        try {
            const senders = state.pc.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender && typeof videoSender.generateKeyFrame === 'function') {
                videoSender.generateKeyFrame().then(() => {
                    state.keyFramesGenerated = (state.keyFramesGenerated || 0) + 1;
                    console.log(`[WinVR Host] Generated fresh IDR keyframe (#${state.keyFramesGenerated}, reason: ${reason || 'unspecified'})`);
                    const statKeyframesEl = document.getElementById('statKeyframes');
                    if (statKeyframesEl) statKeyframesEl.textContent = `${state.keyFramesGenerated} IDRs`;
                }).catch(() => {});
            }
        } catch (e) {}
    }

    // Proactive periodic IDR keyframe refresh (Clears macroblock drift / corruption every 3.5s)
    let idrPeriodicTimer = setInterval(() => {
        if (state.pc && state.stream && state.clientConnected) {
            triggerKeyFrame('periodic_refresh');
        }
    }, 3500);

    function handleControlPacket(rawData) {
        try {
            const msg = JSON.parse(rawData);
            if (msg.type === 'gyro_delta') {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(rawData);
                }
                state.gyro.dx = msg.dx || 0;
                state.gyro.dy = msg.dy || 0;
                state.gyro.yaw += state.gyro.dx;
                state.gyro.pitch += state.gyro.dy;
            } else if (msg.type === 'request_keyframe' || msg.type === 'client_resumed') {
                triggerKeyFrame(msg.reason || 'client_requested');
                sendVrTuning();
                sendFpsTarget();
            } else if (msg.type === 'webrtc_client_stats') {
                state.clientStats = msg;
                const statClientRes = document.getElementById('statClientRes');
                const statClientJitter = document.getElementById('statClientJitter');
                const statClientDropped = document.getElementById('statClientDropped');
                if (statClientRes && msg.decodedWidth && msg.decodedHeight) {
                    statClientRes.textContent = `${msg.decodedWidth}×${msg.decodedHeight}`;
                }
                if (statClientJitter && msg.jitterBufferMs !== undefined) {
                    statClientJitter.textContent = `${msg.jitterBufferMs} ms`;
                }
                if (statClientDropped && msg.framesDropped !== undefined) {
                    statClientDropped.textContent = `${msg.framesDropped}`;
                }
            } else if (msg.type === 'recenter' || msg.type === 'tune_vr' || msg.type === 'tune_crosshair' || msg.type === 'save_calibration') {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(rawData);
                }
            }
        } catch (e) {}
    }

    // --- WebRTC Peer Connection ---
    async function startWebRTC() {
        if (!state.stream) return;

        if (state.pc) {
            try { state.pc.close(); } catch (e) {}
            state.pc = null;
        }
        if (state.dataChannel) {
            try { state.dataChannel.close(); } catch (e) {}
            state.dataChannel = null;
        }

        state.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });

        try {
            state.dataChannel = state.pc.createDataChannel('vr-controls', {
                ordered: false,
                maxRetransmits: 0
            });
            state.dataChannel.onopen = function() {
                console.log('[WinVR] UDP DataChannel OPEN for ultra-low latency controls');
                if (statDataChannel) statDataChannel.textContent = 'UDP DataChannel (Active)';
            };
            state.dataChannel.onmessage = function(e) {
                MtuChunker.receive(e.data, (fullData) => {
                    handleControlPacket(fullData);
                });
            };
        } catch (err) {
            console.warn('[WinVR] Could not create DataChannel:', err);
        }

        state.pc.onicecandidate = function(e) {
            if (e.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'signal',
                    target: 'client',
                    data: { type: 'candidate', candidate: e.candidate }
                }));
            }
        };

        state.stream.getTracks().forEach(track => {
            state.pc.addTrack(track, state.stream);
        });

        // Prefer Constrained Baseline H.264 for instant <2ms mobile hardware decoding with 0 frames latency
        try {
            const transceivers = state.pc.getTransceivers();
            const videoTransceiver = transceivers.find(t => t.sender && t.sender.track && t.sender.track.kind === 'video');
            if (videoTransceiver && typeof videoTransceiver.setCodecPreferences === 'function' && typeof RTCRtpSender.getCapabilities === 'function') {
                const caps = RTCRtpSender.getCapabilities('video');
                if (caps && caps.codecs) {
                    const h264Base = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264' && c.sdpFmtpLine && (c.sdpFmtpLine.includes('profile-level-id=42e0') || c.sdpFmtpLine.includes('profile-level-id=4200')));
                    const h264Other = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264' && (!c.sdpFmtpLine || (!c.sdpFmtpLine.includes('profile-level-id=42e0') && !c.sdpFmtpLine.includes('profile-level-id=4200'))));
                    const others = caps.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
                    videoTransceiver.setCodecPreferences([...h264Base, ...h264Other, ...others]);
                }
            }
        } catch (e) {}

        const offer = await state.pc.createOffer();
        const optimizedSdp = optimizeSdpForGaming(offer.sdp, state.lanBitrate || 75);
        await state.pc.setLocalDescription({ type: 'offer', sdp: optimizedSdp });

        await applySenderBitrate(state.lanBitrate || 75);
        startStatsMonitor();

        state.ws.send(JSON.stringify({
            type: 'signal',
            target: 'client',
            data: state.pc.localDescription
        }));
    }

    async function handleWebRTCSignal(signal) {
        if (!state.pc) return;

        if (signal.type === 'answer') {
            await state.pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === 'candidate') {
            if (signal.candidate) {
                try {
                    await state.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                } catch (e) {}
            }
        }
    }

    // --- Gyro Controls Binding ---
    chkEnableMouseLook.addEventListener('change', function() {
        state.config.mouseLookEnabled = this.checked;
        sendConfig();
    });

    rangeYawSens.addEventListener('input', function() {
        state.config.yawSensitivity = parseFloat(this.value);
        valYawSens.textContent = this.value + 'x';
        sendConfig();
    });

    rangePitchSens.addEventListener('input', function() {
        state.config.pitchSensitivity = parseFloat(this.value);
        valPitchSens.textContent = this.value + 'x';
        sendConfig();
    });

    rangeSmoothing.addEventListener('input', function() {
        state.config.smoothing = parseInt(this.value, 10) / 100.0;
        valSmoothing.textContent = this.value + '%';
        sendConfig();
    });

    rangeDeadzone.addEventListener('input', function() {
        state.config.deadzone = parseFloat(this.value);
        state.config.noiseFloor = Math.max(0.006, state.config.deadzone * 1.6);
        valDeadzone.textContent = this.value + '°';
        sendConfig();
    });

    chkInvertX.addEventListener('change', function() {
        state.config.invertX = this.checked;
        sendConfig();
    });

    chkInvertY.addEventListener('change', function() {
        state.config.invertY = this.checked;
        sendConfig();
    });

    btnRecenter.addEventListener('click', function() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'recenter' }));
        }
        state.gyro.yaw = 0;
        state.gyro.pitch = 0;
    });

    // --- VR Calibration & Tone-Mapping Remote Dispatcher ---
    function updatePreviewVideoFilter() {
        if (!previewVideo) return;
        const exp = state.vr.exposure !== undefined ? state.vr.exposure : 1.0;
        const b = state.vr.brightness !== undefined ? state.vr.brightness : 0.0;
        const c = state.vr.contrast !== undefined ? state.vr.contrast : 1.0;
        const sat = state.vr.saturation !== undefined ? state.vr.saturation : 1.0;
        const bl = state.vr.blackLevel !== undefined ? state.vr.blackLevel : 0.0;

        // Effective brightness and contrast for CSS filter emulation
        let effectiveBright = exp * (1.0 + b);
        let effectiveContrast = c;
        if (bl > 0.01) {
            // Emulate studio-to-full expansion [16, 235] -> [0, 255]
            effectiveContrast *= 1.15;
            effectiveBright *= 0.94;
        }

        if (Math.abs(effectiveBright - 1.0) < 0.01 && Math.abs(effectiveContrast - 1.0) < 0.01 && Math.abs(sat - 1.0) < 0.01 && bl < 0.01) {
            previewVideo.style.filter = 'none';
        } else {
            previewVideo.style.filter = `brightness(${effectiveBright.toFixed(3)}) contrast(${effectiveContrast.toFixed(3)}) saturate(${sat.toFixed(3)})`;
        }
    }

    function sendVrTuning() {
        sendControlPacket({
            type: 'tune_vr',
            mode: state.vr.mode,
            dividerRatio: state.vr.dividerRatio,
            lensOffset: state.vr.lensOffset,
            shiftX: state.vr.shiftX,
            shiftY: state.vr.shiftY,
            ipd: state.vr.ipd,
            fov: state.vr.fov,
            distance: state.vr.distance,
            scale: state.vr.scale,
            elevation: state.vr.elevation,
            curved: state.vr.curved,
            blackLevel: state.vr.blackLevel,
            whiteLevel: state.vr.whiteLevel,
            exposure: state.vr.exposure,
            highlightCut: state.vr.highlightCut,
            shadowBoost: state.vr.shadowBoost,
            gamma: state.vr.gamma,
            contrast: state.vr.contrast,
            brightness: state.vr.brightness,
            saturation: state.vr.saturation
        });
        updatePreviewVideoFilter();
    }

    // VR Display Mode Switcher
    const modeButtons = [
        { el: btnModeDome, mode: 'dome', name: '🏎️ Sim Crisp (135° Dome)' },
        { el: btnModeDomeWide, mode: 'dome_wide', name: '🌐 Ultra-Wide (195° Dome)' },
        { el: btnModeCinema, mode: 'cinema', name: '🎬 Virtual Cinema' },
        { el: btnModeSbs, mode: 'sbs', name: '👓 3D SBS' }
    ];

    modeButtons.forEach(item => {
        if (!item.el) return;
        item.el.addEventListener('click', function() {
            modeButtons.forEach(b => { if (b.el) b.el.classList.remove('active'); });
            item.el.classList.add('active');
            state.vr.mode = item.mode;
            if (valVrMode) valVrMode.textContent = item.name;
            sendVrTuning();
        });
    });

    // Center Separator Split Slider & Nudge Buttons
    if (rangeCenterSplit) {
        rangeCenterSplit.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.dividerRatio = val / 100.0;
            if (valCenterSplit) valCenterSplit.textContent = val.toFixed(1) + '%';
            sendVrTuning();
        });
    }

    if (btnNudgeLeft) {
        btnNudgeLeft.addEventListener('click', function() {
            if (!rangeCenterSplit) return;
            const cur = Math.max(40.0, parseFloat(rangeCenterSplit.value) - 0.2);
            rangeCenterSplit.value = cur.toFixed(1);
            rangeCenterSplit.dispatchEvent(new Event('input'));
        });
    }

    if (btnNudgeRight) {
        btnNudgeRight.addEventListener('click', function() {
            if (!rangeCenterSplit) return;
            const cur = Math.min(60.0, parseFloat(rangeCenterSplit.value) + 0.2);
            rangeCenterSplit.value = cur.toFixed(1);
            rangeCenterSplit.dispatchEvent(new Event('input'));
        });
    }

    if (btnResetSplit) {
        btnResetSplit.addEventListener('click', function() {
            if (!rangeCenterSplit) return;
            rangeCenterSplit.value = '50.0';
            rangeCenterSplit.dispatchEvent(new Event('input'));
        });
    }

    // Lens Optical Offset / Convergence
    if (rangeLensOffset) {
        rangeLensOffset.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.lensOffset = val;
            if (valLensOffset) valLensOffset.textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + ' mm';
            sendVrTuning();
        });
    }

    // IPD Slider
    if (rangeHostIpd) {
        rangeHostIpd.addEventListener('input', function() {
            const val = parseInt(this.value, 10);
            state.vr.ipd = val;
            if (valHostIpd) valHostIpd.textContent = val + ' mm';
            sendVrTuning();
        });
    }

    // FPV FOV Slider
    if (rangeFpvFov) {
        rangeFpvFov.addEventListener('input', function() {
            const val = parseInt(this.value, 10);
            state.vr.fov = val;
            if (valFpvFov) valFpvFov.textContent = val + '°';
            sendVrTuning();
        });
    }

    // Remote Recenter Button
    if (btnRemoteRecenter) {
        btnRemoteRecenter.addEventListener('click', function() {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'remote_recenter' }));
                btnRemoteRecenter.textContent = '✓ Recenter Dispatched!';
                setTimeout(() => {
                    btnRemoteRecenter.textContent = '🎯 Remote Recenter Phone VR Screen';
                }, 1200);
            }
        });
    }

    // --- Virtual Cinema & Movie Screen Geometry Handlers ---
    // Cinema Distance (Backwards / Forward)
    if (rangeCinemaDistance) {
        rangeCinemaDistance.addEventListener('input', function() {
            state.vr.distance = parseFloat(this.value);
            if (valCinemaDistance) valCinemaDistance.textContent = state.vr.distance.toFixed(1) + ' m';
            sendVrTuning();
        });
    }
    if (btnDistCloser) {
        btnDistCloser.addEventListener('click', function() {
            if (!rangeCinemaDistance) return;
            state.vr.distance = Math.max(1.0, parseFloat(rangeCinemaDistance.value) - 0.5);
            rangeCinemaDistance.value = state.vr.distance.toFixed(1);
            rangeCinemaDistance.dispatchEvent(new Event('input'));
        });
    }
    if (btnDistFarther) {
        btnDistFarther.addEventListener('click', function() {
            if (!rangeCinemaDistance) return;
            state.vr.distance = Math.min(30.0, parseFloat(rangeCinemaDistance.value) + 0.5);
            rangeCinemaDistance.value = state.vr.distance.toFixed(1);
            rangeCinemaDistance.dispatchEvent(new Event('input'));
        });
    }
    if (btnDistReset) {
        btnDistReset.addEventListener('click', function() {
            if (!rangeCinemaDistance) return;
            state.vr.distance = 4.5;
            rangeCinemaDistance.value = '4.5';
            rangeCinemaDistance.dispatchEvent(new Event('input'));
        });
    }

    // Cinema Screen Scale (Size)
    if (rangeCinemaScale) {
        rangeCinemaScale.addEventListener('input', function() {
            state.vr.scale = parseInt(this.value, 10) / 100.0;
            if (valCinemaScale) valCinemaScale.textContent = Math.round(state.vr.scale * 100) + '%';
            sendVrTuning();
        });
    }
    if (btnScaleDown) {
        btnScaleDown.addEventListener('click', function() {
            if (!rangeCinemaScale) return;
            const cur = Math.max(50, parseInt(rangeCinemaScale.value, 10) - 10);
            rangeCinemaScale.value = cur;
            rangeCinemaScale.dispatchEvent(new Event('input'));
        });
    }
    if (btnScaleUp) {
        btnScaleUp.addEventListener('click', function() {
            if (!rangeCinemaScale) return;
            const cur = Math.min(600, parseInt(rangeCinemaScale.value, 10) + 10);
            rangeCinemaScale.value = cur;
            rangeCinemaScale.dispatchEvent(new Event('input'));
        });
    }
    if (btnScaleReset) {
        btnScaleReset.addEventListener('click', function() {
            if (!rangeCinemaScale) return;
            rangeCinemaScale.value = 140;
            rangeCinemaScale.dispatchEvent(new Event('input'));
        });
    }

    // Cinema Screen Elevation (Height)
    if (rangeCinemaElevation) {
        rangeCinemaElevation.addEventListener('input', function() {
            state.vr.elevation = parseFloat(this.value);
            if (valCinemaElevation) valCinemaElevation.textContent = (state.vr.elevation >= 0 ? '+' : '') + state.vr.elevation.toFixed(1) + ' m';
            sendVrTuning();
        });
    }
    if (btnElevDown) {
        btnElevDown.addEventListener('click', function() {
            if (!rangeCinemaElevation) return;
            const cur = Math.max(-1.5, parseFloat(rangeCinemaElevation.value) - 0.1);
            rangeCinemaElevation.value = cur.toFixed(1);
            rangeCinemaElevation.dispatchEvent(new Event('input'));
        });
    }
    if (btnElevUp) {
        btnElevUp.addEventListener('click', function() {
            if (!rangeCinemaElevation) return;
            const cur = Math.min(1.5, parseFloat(rangeCinemaElevation.value) + 0.1);
            rangeCinemaElevation.value = cur.toFixed(1);
            rangeCinemaElevation.dispatchEvent(new Event('input'));
        });
    }
    if (btnElevReset) {
        btnElevReset.addEventListener('click', function() {
            if (!rangeCinemaElevation) return;
            rangeCinemaElevation.value = '0.0';
            rangeCinemaElevation.dispatchEvent(new Event('input'));
        });
    }

    // Curved Screen Toggle
    if (btnToggleCurved) {
        btnToggleCurved.addEventListener('click', function() {
            state.vr.curved = !state.vr.curved;
            btnToggleCurved.classList.toggle('active', state.vr.curved);
            btnToggleCurved.innerHTML = state.vr.curved ? '🌐 Curved IMAX Screen' : '▭ Flat Screen';
            sendVrTuning();
        });
    }

    // Movie Experience Presets
    function applyCinemaPreset(distance, scale, elevation, curved, activeBtn) {
        state.vr.distance = distance;
        state.vr.scale = scale;
        state.vr.elevation = elevation;
        state.vr.curved = curved;

        if (rangeCinemaDistance) rangeCinemaDistance.value = distance.toFixed(1);
        if (valCinemaDistance) valCinemaDistance.textContent = distance.toFixed(1) + ' m';
        if (rangeCinemaScale) rangeCinemaScale.value = Math.round(scale * 100);
        if (valCinemaScale) valCinemaScale.textContent = Math.round(scale * 100) + '%';
        if (rangeCinemaElevation) rangeCinemaElevation.value = elevation.toFixed(1);
        if (valCinemaElevation) valCinemaElevation.textContent = (elevation >= 0 ? '+' : '') + elevation.toFixed(1) + ' m';
        if (btnToggleCurved) {
            btnToggleCurved.classList.toggle('active', curved);
            btnToggleCurved.innerHTML = curved ? '🌐 Curved IMAX Screen' : '▭ Flat Screen';
        }

        [btnPresetCinemaGrand, btnPresetCinemaImax, btnPresetCinemaClassic, btnPresetCinemaCozy, btnPresetCinemaDesktop].forEach(b => {
            if (b) b.classList.toggle('active', b === activeBtn);
        });

        if (state.vr.mode === 'dome' && btnModeCinema) {
            btnModeCinema.click();
        } else {
            sendVrTuning();
        }
    }

    if (btnPresetCinemaGrand) {
        btnPresetCinemaGrand.addEventListener('click', () => applyCinemaPreset(15.0, 4.5, 0.4, true, btnPresetCinemaGrand));
    }
    if (btnPresetCinemaImax) {
        btnPresetCinemaImax.addEventListener('click', () => applyCinemaPreset(8.0, 2.6, 0.2, true, btnPresetCinemaImax));
    }
    if (btnPresetCinemaClassic) {
        btnPresetCinemaClassic.addEventListener('click', () => applyCinemaPreset(4.5, 1.4, 0.0, true, btnPresetCinemaClassic));
    }
    if (btnPresetCinemaCozy) {
        btnPresetCinemaCozy.addEventListener('click', () => applyCinemaPreset(2.4, 1.15, 0.0, true, btnPresetCinemaCozy));
    }
    if (btnPresetCinemaDesktop) {
        btnPresetCinemaDesktop.addEventListener('click', () => applyCinemaPreset(1.8, 0.85, 0.0, false, btnPresetCinemaDesktop));
    }

    // --- Stream Resolution & Phone Display Handlers (Locks Maximum Quality) ---
    const valPhoneDetected = document.getElementById('valPhoneDetected');
    const btnApplyPhoneRes = document.getElementById('btnApplyPhoneRes');
    const valCurrentRes = document.getElementById('valCurrentRes');
    const btnResPhoneUltra = document.getElementById('btnResPhoneUltra');
    const btnRes1080p = document.getElementById('btnRes1080p');
    const btnRes2k = document.getElementById('btnRes2k');
    const btnResPhone3k = document.getElementById('btnResPhone3k');
    const btnRes4k = document.getElementById('btnRes4k');
    const inputCustomWidth = document.getElementById('inputCustomWidth');
    const inputCustomHeight = document.getElementById('inputCustomHeight');
    const btnApplyCustomRes = document.getElementById('btnApplyCustomRes');

    const resButtons = [btnResPhoneUltra, btnRes1080p, btnRes2k, btnResPhone3k, btnRes4k];

    async function setStreamResolution(w, h, activeBtn) {
        state.streamResolution = { width: w, height: h };
        if (inputCustomWidth) inputCustomWidth.value = w;
        if (inputCustomHeight) inputCustomHeight.value = h;
        if (valCurrentRes) {
            valCurrentRes.textContent = `${w} × ${h} (Locked 1:1 Pixel Match)`;
            valCurrentRes.style.color = 'var(--accent-green)';
        }

        resButtons.forEach(b => {
            if (b) b.classList.toggle('active', b === activeBtn);
        });

        // If stream is active, dynamically update video track constraints and WebRTC encoding
        if (state.stream) {
            const track = state.stream.getVideoTracks()[0];
            if (track) {
                try {
                    await track.applyConstraints({
                        width: { ideal: w, max: 3840 },
                        height: { ideal: h, max: 2160 }
                    });
                    console.log(`[WinVR Host] Applied resolution constraints: ${w}x${h}`);
                } catch (e) {
                    console.warn('[WinVR Host] applyConstraints note:', e);
                }
            }
            await applySenderBitrate(state.lanBitrate || 65);
        }
    }

    if (btnResPhoneUltra) {
        btnResPhoneUltra.addEventListener('click', () => setStreamResolution(2400, 1080, btnResPhoneUltra));
    }
    if (btnRes1080p) {
        btnRes1080p.addEventListener('click', () => setStreamResolution(1920, 1080, btnRes1080p));
    }
    if (btnRes2k) {
        btnRes2k.addEventListener('click', () => setStreamResolution(2560, 1440, btnRes2k));
    }
    if (btnResPhone3k) {
        btnResPhone3k.addEventListener('click', () => setStreamResolution(3200, 1440, btnResPhone3k));
    }
    if (btnRes4k) {
        btnRes4k.addEventListener('click', () => setStreamResolution(3840, 2160, btnRes4k));
    }

    if (btnApplyPhoneRes) {
        btnApplyPhoneRes.addEventListener('click', function() {
            if (state.phoneResolution) {
                setStreamResolution(state.phoneResolution.width, state.phoneResolution.height, null);
                btnApplyPhoneRes.textContent = `✓ Matched Phone (${state.phoneResolution.width}×${state.phoneResolution.height})`;
            }
        });
    }

    if (btnApplyCustomRes) {
        btnApplyCustomRes.addEventListener('click', function() {
            const w = parseInt(inputCustomWidth.value, 10) || 2560;
            const h = parseInt(inputCustomHeight.value, 10) || 1440;
            setStreamResolution(w, h, null);
        });
    }

    // --- Visual Fidelity & Tone Mapping Handlers (Eliminates Washed-Out Roads) ---
    const rangeHighlightCut = document.getElementById('rangeHighlightCut');
    const valHighlightCut = document.getElementById('valHighlightCut');
    const btnHighlightCutDefault = document.getElementById('btnHighlightCutDefault');

    const rangeExposure = document.getElementById('rangeExposure');
    const valExposure = document.getElementById('valExposure');
    const btnExposureDefault = document.getElementById('btnExposureDefault');

    const rangeShadowBoost = document.getElementById('rangeShadowBoost');
    const valShadowBoost = document.getElementById('valShadowBoost');
    const btnShadowBoostDefault = document.getElementById('btnShadowBoostDefault');

    const rangeGamma = document.getElementById('rangeGamma');
    const valGamma = document.getElementById('valGamma');
    const btnGammaDefault = document.getElementById('btnGammaDefault');

    const rangeBrightness = document.getElementById('rangeBrightness');
    const valBrightness = document.getElementById('valBrightness');
    const btnBrightnessDefault = document.getElementById('btnBrightnessDefault');

    const rangeContrast = document.getElementById('rangeContrast');
    const valContrast = document.getElementById('valContrast');
    const btnContrastDefault = document.getElementById('btnContrastDefault');

    const rangeSaturation = document.getElementById('rangeSaturation');
    const valSaturation = document.getElementById('valSaturation');
    const btnSaturationDefault = document.getElementById('btnSaturationDefault');

    const btnPresetRefColor = document.getElementById('btnPresetRefColor');
    const btnPresetHdrRecovery = document.getElementById('btnPresetHdrRecovery');
    const btnPresetFullRange = document.getElementById('btnPresetFullRange');
    const btnPresetFixRoad = document.getElementById('btnPresetFixRoad');
    const btnPresetCinemaColor = document.getElementById('btnPresetCinemaColor');
    const btnPresetVibrantGame = document.getElementById('btnPresetVibrantGame');
    const btnPresetNightBoost = document.getElementById('btnPresetNightBoost');

    if (rangeHighlightCut) {
        rangeHighlightCut.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.highlightCut = val;
            const pct = Math.round(val * 100);
            if (valHighlightCut) valHighlightCut.textContent = pct + '%' + (pct > 0 ? ' (Road Recovered)' : ' (1:1 Reference)');
            sendVrTuning();
        });
    }
    if (btnHighlightCutDefault) {
        btnHighlightCutDefault.addEventListener('click', function() {
            if (!rangeHighlightCut) return;
            rangeHighlightCut.value = '0.00';
            rangeHighlightCut.dispatchEvent(new Event('input'));
        });
    }

    if (rangeExposure) {
        rangeExposure.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.exposure = val;
            if (valExposure) valExposure.textContent = val.toFixed(2) + 'x' + (Math.abs(val - 1.0) < 0.01 ? ' (1:1 Reference)' : (val < 1.0 ? ' (Anti-Blowout)' : ' (Boost)'));
            sendVrTuning();
        });
    }
    if (btnExposureDefault) {
        btnExposureDefault.addEventListener('click', function() {
            if (!rangeExposure) return;
            rangeExposure.value = '1.00';
            rangeExposure.dispatchEvent(new Event('input'));
        });
    }

    if (rangeShadowBoost) {
        rangeShadowBoost.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.shadowBoost = val;
            const pct = Math.round(val * 100);
            if (valShadowBoost) valShadowBoost.textContent = (pct > 0 ? '+' + pct + '% (Clear Gauges)' : '0% (1:1 True Black)');
            sendVrTuning();
        });
    }
    if (btnShadowBoostDefault) {
        btnShadowBoostDefault.addEventListener('click', function() {
            if (!rangeShadowBoost) return;
            rangeShadowBoost.value = '0.00';
            rangeShadowBoost.dispatchEvent(new Event('input'));
        });
    }

    if (rangeGamma) {
        rangeGamma.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.gamma = val;
            if (valGamma) valGamma.textContent = val.toFixed(2) + (Math.abs(val - 1.0) < 0.01 ? ' (1:1 Reference)' : (val > 1.05 ? ' (Deep Asphalt)' : ''));
            sendVrTuning();
        });
    }
    if (btnGammaDefault) {
        btnGammaDefault.addEventListener('click', function() {
            if (!rangeGamma) return;
            rangeGamma.value = '1.00';
            rangeGamma.dispatchEvent(new Event('input'));
        });
    }

    if (rangeBrightness) {
        rangeBrightness.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.brightness = val;
            const pct = Math.round(val * 100);
            if (valBrightness) valBrightness.textContent = (pct === 0 ? '0% (1:1 Reference)' : (pct > 0 ? '+' : '') + pct + '%');
            sendVrTuning();
        });
    }
    if (btnBrightnessDefault) {
        btnBrightnessDefault.addEventListener('click', function() {
            if (!rangeBrightness) return;
            rangeBrightness.value = '0.00';
            rangeBrightness.dispatchEvent(new Event('input'));
        });
    }

    if (rangeContrast) {
        rangeContrast.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.contrast = val;
            const pct = Math.round((val - 1.0) * 100);
            if (valContrast) valContrast.textContent = (pct === 0 ? '0% (1:1 Reference)' : (pct > 0 ? '+' : '') + pct + '%');
            sendVrTuning();
        });
    }
    if (btnContrastDefault) {
        btnContrastDefault.addEventListener('click', function() {
            if (!rangeContrast) return;
            rangeContrast.value = '1.00';
            rangeContrast.dispatchEvent(new Event('input'));
        });
    }

    if (rangeSaturation) {
        rangeSaturation.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.saturation = val;
            const pct = Math.round((val - 1.0) * 100);
            if (valSaturation) valSaturation.textContent = (pct === 0 ? '0% (1:1 Reference)' : (pct > 0 ? '+' : '') + pct + '%');
            sendVrTuning();
        });
    }
    if (btnSaturationDefault) {
        btnSaturationDefault.addEventListener('click', function() {
            if (!rangeSaturation) return;
            rangeSaturation.value = '1.00';
            rangeSaturation.dispatchEvent(new Event('input'));
        });
    }

    function applyColorPreset(exp, hc, sb, gamma, bright, contrast, sat, blackLevel, whiteLevel, activeBtn) {
        state.vr.blackLevel = blackLevel !== undefined ? blackLevel : 0.0;
        state.vr.whiteLevel = whiteLevel !== undefined ? whiteLevel : 1.0;
        if (rangeExposure) rangeExposure.value = exp.toFixed(2);
        if (rangeHighlightCut) rangeHighlightCut.value = hc.toFixed(2);
        if (rangeShadowBoost) rangeShadowBoost.value = sb.toFixed(2);
        if (rangeGamma) rangeGamma.value = gamma.toFixed(2);
        if (rangeBrightness) rangeBrightness.value = bright.toFixed(2);
        if (rangeContrast) rangeContrast.value = contrast.toFixed(2);
        if (rangeSaturation) rangeSaturation.value = sat.toFixed(2);

        [btnPresetRefColor, btnPresetHdrRecovery, btnPresetFullRange, btnPresetFixRoad, btnPresetCinemaColor, btnPresetVibrantGame, btnPresetNightBoost].forEach(b => {
            if (b) b.classList.toggle('active', b === activeBtn);
        });

        if (rangeExposure) rangeExposure.dispatchEvent(new Event('input'));
        if (rangeHighlightCut) rangeHighlightCut.dispatchEvent(new Event('input'));
        if (rangeShadowBoost) rangeShadowBoost.dispatchEvent(new Event('input'));
        if (rangeGamma) rangeGamma.dispatchEvent(new Event('input'));
        if (rangeBrightness) rangeBrightness.dispatchEvent(new Event('input'));
        if (rangeContrast) rangeContrast.dispatchEvent(new Event('input'));
        if (rangeSaturation) rangeSaturation.dispatchEvent(new Event('input'));
    }

    if (btnPresetRefColor) {
        btnPresetRefColor.addEventListener('click', () => applyColorPreset(1.00, 0.00, 0.00, 1.00, 0.00, 1.00, 1.00, 0.0, 1.0, btnPresetRefColor));
    }
    if (btnPresetHdrRecovery) {
        btnPresetHdrRecovery.addEventListener('click', () => applyColorPreset(0.92, 0.20, 0.00, 1.05, 0.00, 1.05, 1.05, 0.0, 1.0, btnPresetHdrRecovery));
    }
    if (btnPresetFullRange) {
        btnPresetFullRange.addEventListener('click', () => applyColorPreset(1.00, 0.00, 0.00, 1.00, 0.00, 1.00, 1.00, 0.0627, 0.9216, btnPresetFullRange));
    }
    if (btnPresetFixRoad) {
        btnPresetFixRoad.addEventListener('click', () => applyColorPreset(0.90, 0.25, 0.00, 1.10, 0.00, 1.05, 1.15, 0.0, 1.0, btnPresetFixRoad));
    }
    if (btnPresetCinemaColor) {
        btnPresetCinemaColor.addEventListener('click', () => applyColorPreset(1.00, 0.00, 0.00, 1.00, 0.00, 1.00, 1.00, 0.0, 1.0, btnPresetCinemaColor));
    }
    if (btnPresetVibrantGame) {
        btnPresetVibrantGame.addEventListener('click', () => applyColorPreset(1.00, 0.05, 0.00, 1.05, 0.00, 1.10, 1.25, 0.0, 1.0, btnPresetVibrantGame));
    }
    if (btnPresetNightBoost) {
        btnPresetNightBoost.addEventListener('click', () => applyColorPreset(1.05, 0.00, 0.15, 0.95, 0.02, 1.05, 1.10, 0.0, 1.0, btnPresetNightBoost));
    }

    // --- Stereoscopic Convergence Alignment Handlers (Double Vision Fix) ---
    function sendCrosshairTune() {
        sendControlPacket({
            type: 'tune_crosshair',
            shiftX: state.vr.shiftX,
            shiftY: state.vr.shiftY
        });
    }

    // Horizontal Convergence (Merge In / Out)
    if (rangeShiftX) {
        rangeShiftX.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.shiftX = val;
            if (valShiftX) valShiftX.textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + ' mm';
            sendCrosshairTune();
        });
    }

    if (btnShiftXIn) {
        btnShiftXIn.addEventListener('click', function() {
            if (!rangeShiftX) return;
            const cur = Math.min(30.0, parseFloat(rangeShiftX.value) + 0.5);
            rangeShiftX.value = cur.toFixed(1);
            rangeShiftX.dispatchEvent(new Event('input'));
        });
    }

    if (btnShiftXOut) {
        btnShiftXOut.addEventListener('click', function() {
            if (!rangeShiftX) return;
            const cur = Math.max(-30.0, parseFloat(rangeShiftX.value) - 0.5);
            rangeShiftX.value = cur.toFixed(1);
            rangeShiftX.dispatchEvent(new Event('input'));
        });
    }

    if (btnShiftXReset) {
        btnShiftXReset.addEventListener('click', function() {
            if (!rangeShiftX) return;
            rangeShiftX.value = '0.0';
            rangeShiftX.dispatchEvent(new Event('input'));
        });
    }

    // Vertical Alignment (Y-Shift)
    if (rangeShiftY) {
        rangeShiftY.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.vr.shiftY = val;
            if (valShiftY) valShiftY.textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + ' mm';
            sendCrosshairTune();
        });
    }

    if (btnShiftYDown) {
        btnShiftYDown.addEventListener('click', function() {
            if (!rangeShiftY) return;
            const cur = Math.max(-15.0, parseFloat(rangeShiftY.value) - 0.5);
            rangeShiftY.value = cur.toFixed(1);
            rangeShiftY.dispatchEvent(new Event('input'));
        });
    }

    if (btnShiftYUp) {
        btnShiftYUp.addEventListener('click', function() {
            if (!rangeShiftY) return;
            const cur = Math.min(15.0, parseFloat(rangeShiftY.value) + 0.5);
            rangeShiftY.value = cur.toFixed(1);
            rangeShiftY.dispatchEvent(new Event('input'));
        });
    }

    if (btnShiftYReset) {
        btnShiftYReset.addEventListener('click', function() {
            if (!rangeShiftY) return;
            rangeShiftY.value = '0.0';
            rangeShiftY.dispatchEvent(new Event('input'));
        });
    }

    // Save Alignment Calibration to LocalStorage and Mobile
    if (btnSaveCalibration) {
        btnSaveCalibration.addEventListener('click', function() {
            const calib = {
                shiftX: state.vr.shiftX,
                shiftY: state.vr.shiftY,
                dividerRatio: state.vr.dividerRatio,
                lensOffset: state.vr.lensOffset,
                ipd: state.vr.ipd,
                mode: state.vr.mode,
                fov: state.vr.fov,
                distance: state.vr.distance,
                scale: state.vr.scale,
                elevation: state.vr.elevation,
                curved: state.vr.curved,
                exposure: state.vr.exposure,
                highlightCut: state.vr.highlightCut,
                shadowBoost: state.vr.shadowBoost,
                gamma: state.vr.gamma,
                contrast: state.vr.contrast,
                brightness: state.vr.brightness,
                saturation: state.vr.saturation
            };
            try {
                localStorage.setItem('winvr_calibration', JSON.stringify(calib));
            } catch (e) {}

            sendControlPacket({
                type: 'save_calibration',
                calibration: calib
            });

            btnSaveCalibration.textContent = '✓ Saved as Default!';
            setTimeout(() => {
                btnSaveCalibration.textContent = '💾 Save Alignment as Default';
            }, 1500);
        });
    }

    // --- LAN Gaming Bandwidth Handlers ---
    const lanPresetButtons = [btnPresetSteamLink, btnPresetMoonlight, btnPresetExtreme, btnPresetMax];

    if (rangeLanBitrate) {
        rangeLanBitrate.addEventListener('input', function() {
            const val = parseInt(this.value, 10);
            state.lanBitrate = val;
            if (valLanBitrate) valLanBitrate.textContent = val + ' Mbps';

            lanPresetButtons.forEach(b => {
                if (b) b.classList.toggle('active', parseInt(b.dataset.bitrate, 10) === val);
            });

            applySenderBitrate(val);
        });
    }

    lanPresetButtons.forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', function() {
            const br = parseInt(this.dataset.bitrate, 10);
            lanPresetButtons.forEach(b => {
                if (b) b.classList.toggle('active', b === btn);
            });
            if (rangeLanBitrate) {
                rangeLanBitrate.value = br;
                rangeLanBitrate.dispatchEvent(new Event('input'));
            }
        });
    });

    // Real-time WebRTC Telemetry Monitor (Distinguishes Target vs Actual Delivered FPS)
    let statsTimer = null;
    let lastBytesSent = 0;
    let lastFramesSent = 0;
    let lastTimestamp = 0;

    function startStatsMonitor() {
        if (statsTimer) clearInterval(statsTimer);
        lastBytesSent = 0;
        lastFramesSent = 0;
        lastTimestamp = 0;

        statsTimer = setInterval(async () => {
            if (!state.pc) {
                if (statLiveThroughput) statLiveThroughput.textContent = `${state.lanBitrate} Mbps (Ready)`;
                if (statDeliveredFps) statDeliveredFps.textContent = `${state.targetFps}.0 FPS`;
                return;
            }

            try {
                const stats = await state.pc.getStats();
                let rttFound = false;
                stats.forEach(report => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        if (lastTimestamp > 0 && report.timestamp > lastTimestamp && report.bytesSent !== undefined) {
                            const timeDiffSec = (report.timestamp - lastTimestamp) / 1000.0;
                            const bytesDiff = report.bytesSent - lastBytesSent;
                            if (bytesDiff >= 0 && timeDiffSec > 0) {
                                const currentBitrateMbps = ((bytesDiff * 8) / (timeDiffSec * 1000000)).toFixed(1);
                                const deliveredFps = report.framesPerSecond !== undefined
                                    ? Math.round(report.framesPerSecond)
                                    : (report.framesSent !== undefined ? Math.round((report.framesSent - lastFramesSent) / timeDiffSec) : state.targetFps);

                                if (statLiveThroughput) {
                                    statLiveThroughput.textContent = `${currentBitrateMbps} Mbps (${deliveredFps} FPS)`;
                                }
                                if (statDeliveredFps) {
                                    statDeliveredFps.textContent = `${deliveredFps} FPS`;
                                }
                                if (statFps) {
                                    statFps.textContent = `${deliveredFps} FPS`;
                                }
                            }
                        }
                        lastBytesSent = report.bytesSent || 0;
                        lastFramesSent = report.framesSent || 0;
                        lastTimestamp = report.timestamp;

                        // Encoder Health & Quality Limitation Telemetry
                        const statEncoderStatus = document.getElementById('statEncoderStatus');
                        if (statEncoderStatus) {
                            if (report.qualityLimitationReason === 'cpu') {
                                statEncoderStatus.textContent = 'CPU Overload';
                                statEncoderStatus.style.color = '#ef4444';
                            } else if (report.qualityLimitationReason === 'bandwidth') {
                                statEncoderStatus.textContent = 'Bandwidth Limited';
                                statEncoderStatus.style.color = '#f59e0b';
                            } else {
                                statEncoderStatus.textContent = 'NVENC OK';
                                statEncoderStatus.style.color = 'var(--accent-green)';
                            }
                        }

                        const statKeyframesEl = document.getElementById('statKeyframes');
                        if (statKeyframesEl) {
                            const kf = report.keyFramesEncoded !== undefined ? report.keyFramesEncoded : (state.keyFramesGenerated || 0);
                            statKeyframesEl.textContent = `${kf} IDRs`;
                        }

                        if (report.frameWidth && report.frameHeight && statRes) {
                            statRes.textContent = `${report.frameWidth}x${report.frameHeight}`;
                        }
                    }

                    // Network RTT Latency
                    if ((report.type === 'candidate-pair' || report.type === 'remote-candidate') && report.currentRoundTripTime !== undefined) {
                        if (!rttFound && report.currentRoundTripTime > 0) {
                            rttFound = true;
                            const ms = Math.round(report.currentRoundTripTime * 1000);
                            if (statRtt) statRtt.textContent = `${ms} ms (LAN)`;
                        }
                    }
                });

                // Check dropped video frames
                if (previewVideo && typeof previewVideo.getVideoPlaybackQuality === 'function') {
                    const quality = previewVideo.getVideoPlaybackQuality();
                    if (statDroppedFrames && quality) {
                        statDroppedFrames.textContent = `${quality.droppedVideoFrames}`;
                    }
                }
            } catch (e) {}
        }, 1000);
    }

    function stopStatsMonitor() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        if (statLiveThroughput) {
            statLiveThroughput.textContent = `${state.lanBitrate} Mbps (Standby)`;
        }
    }

    function loadSavedCalibration() {
        try {
            const saved = localStorage.getItem('winvr_calibration');
            if (saved) {
                const calib = JSON.parse(saved);
                if (calib.shiftX !== undefined && rangeShiftX) {
                    state.vr.shiftX = parseFloat(calib.shiftX);
                    rangeShiftX.value = state.vr.shiftX.toFixed(1);
                    if (valShiftX) valShiftX.textContent = (state.vr.shiftX >= 0 ? '+' : '') + state.vr.shiftX.toFixed(1) + ' mm';
                }
                if (calib.shiftY !== undefined && rangeShiftY) {
                    state.vr.shiftY = parseFloat(calib.shiftY);
                    rangeShiftY.value = state.vr.shiftY.toFixed(1);
                    if (valShiftY) valShiftY.textContent = (state.vr.shiftY >= 0 ? '+' : '') + state.vr.shiftY.toFixed(1) + ' mm';
                }
                if (calib.dividerRatio !== undefined && rangeCenterSplit) {
                    state.vr.dividerRatio = parseFloat(calib.dividerRatio);
                    rangeCenterSplit.value = (state.vr.dividerRatio * 100).toFixed(1);
                    if (valCenterSplit) valCenterSplit.textContent = rangeCenterSplit.value + '%';
                }
                if (calib.ipd !== undefined && rangeHostIpd) {
                    state.vr.ipd = parseInt(calib.ipd, 10);
                    rangeHostIpd.value = state.vr.ipd;
                    if (valHostIpd) valHostIpd.textContent = state.vr.ipd + ' mm';
                }
                if (calib.fov !== undefined && rangeFpvFov) {
                    state.vr.fov = parseInt(calib.fov, 10);
                    rangeFpvFov.value = state.vr.fov;
                    if (valFpvFov) valFpvFov.textContent = state.vr.fov + '°';
                }
                if (calib.mode !== undefined) {
                    state.vr.mode = calib.mode;
                    modeButtons.forEach(b => {
                        if (b.el) b.el.classList.toggle('active', b.mode === calib.mode);
                    });
                    const found = modeButtons.find(b => b.mode === calib.mode);
                    if (found && valVrMode) valVrMode.textContent = found.name;
                }
                if ((calib.distance !== undefined || calib.screenDistance !== undefined) && rangeCinemaDistance) {
                    const rawDist = calib.distance !== undefined ? calib.distance : calib.screenDistance;
                    state.vr.distance = parseFloat(rawDist);
                    rangeCinemaDistance.value = state.vr.distance.toFixed(1);
                    if (valCinemaDistance) valCinemaDistance.textContent = state.vr.distance.toFixed(1) + ' m';
                }
                if ((calib.scale !== undefined || calib.screenScale !== undefined) && rangeCinemaScale) {
                    const rawScale = calib.scale !== undefined ? calib.scale : calib.screenScale;
                    state.vr.scale = parseFloat(rawScale);
                    rangeCinemaScale.value = Math.round(state.vr.scale * 100);
                    if (valCinemaScale) valCinemaScale.textContent = Math.round(state.vr.scale * 100) + '%';
                }
                if ((calib.elevation !== undefined || calib.screenElevation !== undefined) && rangeCinemaElevation) {
                    const rawElev = calib.elevation !== undefined ? calib.elevation : calib.screenElevation;
                    state.vr.elevation = parseFloat(rawElev);
                    rangeCinemaElevation.value = state.vr.elevation.toFixed(1);
                    if (valCinemaElevation) valCinemaElevation.textContent = (state.vr.elevation >= 0 ? '+' : '') + state.vr.elevation.toFixed(1) + ' m';
                }
                if (calib.curved !== undefined && btnToggleCurved) {
                    state.vr.curved = Boolean(calib.curved);
                    btnToggleCurved.classList.toggle('active', state.vr.curved);
                    btnToggleCurved.innerHTML = state.vr.curved ? '🌐 Curved IMAX Screen' : '▭ Flat Screen';
                }
                if (calib.gamma !== undefined && rangeGamma) {
                    state.vr.gamma = parseFloat(calib.gamma);
                    rangeGamma.value = state.vr.gamma.toFixed(2);
                    if (valGamma) valGamma.textContent = state.vr.gamma.toFixed(2) + (state.vr.gamma > 1.05 ? ' (Deep Road)' : '');
                }
                if (calib.brightness !== undefined && rangeBrightness) {
                    state.vr.brightness = parseFloat(calib.brightness);
                    rangeBrightness.value = state.vr.brightness.toFixed(2);
                    const bPct = Math.round(state.vr.brightness * 100);
                    if (valBrightness) valBrightness.textContent = (bPct >= 0 ? '+' : '') + bPct + '% (Anti-Washout)';
                }
                if (calib.contrast !== undefined && rangeContrast) {
                    state.vr.contrast = parseFloat(calib.contrast);
                    rangeContrast.value = state.vr.contrast.toFixed(2);
                    const cPct = Math.round((state.vr.contrast - 1.0) * 100);
                    if (valContrast) valContrast.textContent = (cPct >= 0 ? '+' : '') + cPct + '%';
                }
                if (calib.saturation !== undefined && rangeSaturation) {
                    state.vr.saturation = parseFloat(calib.saturation);
                    rangeSaturation.value = state.vr.saturation.toFixed(2);
                    const sPct = Math.round((state.vr.saturation - 1.0) * 100);
                    if (valSaturation) valSaturation.textContent = (sPct >= 0 ? '+' : '') + sPct + '%';
                }
            }
        } catch (e) {}
    }

    // Preset Tracking & Game Latency Profiles
    document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
        btn.addEventListener('click', function() {
            const preset = this.dataset.preset;
            if (!preset) return;
            document.querySelectorAll('.preset-btn[data-preset]').forEach(b => b.classList.toggle('active', b === this));

            if (preset === 'fps') {
                rangeYawSens.value = 2.4;
                rangePitchSens.value = 2.0;
                rangeSmoothing.value = 5;
                rangeDeadzone.value = 0.003;
                chkEnableMouseLook.checked = true;
            } else if (preset === 'sim') {
                // Instant zero-lag head tracking for Euro Truck Simulator & driving sims
                rangeYawSens.value = 2.0;
                rangePitchSens.value = 1.8;
                rangeSmoothing.value = 0; // 0ms Raw Instant Tracking
                rangeDeadzone.value = 0.003;
                chkEnableMouseLook.checked = true;
            } else if (preset === 'cinema') {
                chkEnableMouseLook.checked = false;
            }

            rangeYawSens.dispatchEvent(new Event('input'));
            rangePitchSens.dispatchEvent(new Event('input'));
            rangeSmoothing.dispatchEvent(new Event('input'));
            rangeDeadzone.dispatchEvent(new Event('input'));
            chkEnableMouseLook.dispatchEvent(new Event('change'));
        });
    });

    // Quick Smoothing Buttons (0ms Raw, 5% Game, 20% Balanced, 50% Cinema)
    document.querySelectorAll('[data-smooth]').forEach(btn => {
        btn.addEventListener('click', function() {
            const sVal = parseInt(this.dataset.smooth, 10);
            if (rangeSmoothing) {
                rangeSmoothing.value = sVal;
                rangeSmoothing.dispatchEvent(new Event('input'));
            }
            document.querySelectorAll('[data-smooth]').forEach(b => b.classList.toggle('active', b === this));
        });
    });

    // --- Gyroscope Visualizer Animation ---
    function resizeCanvas() {
        if (!gyroCanvas) return;
        const rect = gyroCanvas.getBoundingClientRect();
        const w = rect.width || gyroCanvas.clientWidth || 300;
        const h = rect.height || gyroCanvas.clientHeight || 105;
        if (gyroCanvas.width !== w || gyroCanvas.height !== h) {
            gyroCanvas.width = w;
            gyroCanvas.height = h;
        }
    }

    function drawVisualizer() {
        requestAnimationFrame(drawVisualizer);
        if (!gyroCtx || !gyroCanvas) return;

        resizeCanvas();

        const w = gyroCanvas.width;
        const h = gyroCanvas.height;
        if (w === 0 || h === 0) return;

        const cx = w / 2;
        const cy = h / 2;

        gyroCtx.clearRect(0, 0, w, h);

        gyroCtx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        gyroCtx.lineWidth = 1;

        gyroCtx.beginPath();
        gyroCtx.arc(cx, cy, 35, 0, Math.PI * 2);
        gyroCtx.stroke();

        gyroCtx.beginPath();
        gyroCtx.moveTo(cx - 50, cy);
        gyroCtx.lineTo(cx + 50, cy);
        gyroCtx.moveTo(cx, cy - 35);
        gyroCtx.lineTo(cx, cy + 35);
        gyroCtx.stroke();

        const offsetX = Math.max(-45, Math.min(45, (state.gyro.yaw % 360) * 0.8));
        const offsetY = Math.max(-30, Math.min(30, (state.gyro.pitch % 360) * 0.8));

        gyroCtx.strokeStyle = '#00f2fe';
        gyroCtx.fillStyle = 'rgba(0, 242, 254, 0.25)';
        gyroCtx.lineWidth = 2;

        gyroCtx.beginPath();
        gyroCtx.arc(cx + offsetX, cy + offsetY, 7, 0, Math.PI * 2);
        gyroCtx.fill();
        gyroCtx.stroke();

        gyroCtx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        gyroCtx.font = '10px ui-monospace, monospace';
        gyroCtx.fillText(`YAW: ${(state.gyro.yaw % 360).toFixed(1)}°  PITCH: ${(state.gyro.pitch % 360).toFixed(1)}°`, 10, h - 10);
    }

    // --- Theme Switcher (Dark / Light Mode) ---
    const btnThemeToggle = document.getElementById('btnThemeToggle');
    const themeIconDark = document.getElementById('themeIconDark');
    const themeIconLight = document.getElementById('themeIconLight');
    const themeToggleText = document.getElementById('themeToggleText');

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        const isDark = theme === 'dark';
        if (themeIconDark) themeIconDark.style.display = isDark ? 'inline-block' : 'none';
        if (themeIconLight) themeIconLight.style.display = isDark ? 'none' : 'inline-block';
        if (themeToggleText) themeToggleText.textContent = isDark ? 'Theme: Dark' : 'Theme: Light';
        try {
            localStorage.setItem('winvr_theme', theme);
        } catch (e) {}
    }

    function initTheme() {
        let savedTheme = 'dark';
        try {
            savedTheme = localStorage.getItem('winvr_theme') || 'dark';
        } catch (e) {}
        applyTheme(savedTheme);

        if (btnThemeToggle) {
            btnThemeToggle.addEventListener('click', function(e) {
                e.preventDefault();
                const current = document.documentElement.getAttribute('data-theme') || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                applyTheme(next);
            });
        }
    }

    // --- Collapsible Sections with Chevron Arrows ---
    function initCollapsibleSections() {
        const collapsibleHeaders = document.querySelectorAll('.card-header.is-collapsible, .subcard-header.is-collapsible');

        collapsibleHeaders.forEach(header => {
            const targetId = header.dataset.target;
            const container = targetId ? document.getElementById(targetId) : header.closest('.card, .collapsible-subcard');
            if (!container) return;

            // Restore saved state (default is expanded / false)
            if (targetId) {
                try {
                    const isCollapsed = localStorage.getItem('winvr_collapse_' + targetId) === '1';
                    if (isCollapsed) {
                        container.classList.add('is-collapsed');
                    }
                } catch (e) {}
            }

            // Click listener
            header.addEventListener('click', function(e) {
                if (e.target.closest('.card-action-btn') || e.target.closest('.card-drag-handle') || e.target.closest('#btnToggleCurved') || e.target.closest('input') || e.target.closest('select')) {
                    return;
                }
                const nowCollapsed = container.classList.toggle('is-collapsed');
                if (targetId) {
                    try {
                        localStorage.setItem('winvr_collapse_' + targetId, nowCollapsed ? '1' : '0');
                    } catch (e) {}
                }
            });
        });
    }

    // --- Card Rearrangement (Drag & Drop + Up/Down/Swap Buttons) ---
    function initCardReordering() {
        const colStream = document.getElementById('colStream');
        const colControls = document.getElementById('colControls');
        const btnResetLayout = document.getElementById('btnResetLayout');

        const defaultLayout = {
            left: ['cardStream', 'cardFpsEngine', 'cardResolutionEngine', 'cardLanEngine'],
            right: ['cardVrCalibration', 'cardGyro']
        };

        function saveLayout() {
            if (!colStream || !colControls) return;
            const left = Array.from(colStream.children).filter(el => el.classList.contains('card')).map(el => el.id);
            const right = Array.from(colControls.children).filter(el => el.classList.contains('card')).map(el => el.id);
            try {
                localStorage.setItem('winvr_card_layout', JSON.stringify({ left, right }));
            } catch (e) {}
        }

        function restoreLayout() {
            if (!colStream || !colControls) return;
            let layout = null;
            try {
                const raw = localStorage.getItem('winvr_card_layout');
                if (raw) layout = JSON.parse(raw);
            } catch (e) {}
            if (!layout || !Array.isArray(layout.left) || !Array.isArray(layout.right)) {
                layout = defaultLayout;
            }

            layout.left.forEach(id => {
                const el = document.getElementById(id);
                if (el) colStream.appendChild(el);
            });
            layout.right.forEach(id => {
                const el = document.getElementById(id);
                if (el) colControls.appendChild(el);
            });
        }

        // Apply saved layout immediately
        restoreLayout();

        // 1. Reorder buttons (▲ Up, ▼ Down, ⇄ Swap Column)
        document.querySelectorAll('.card-header-actions .card-action-btn').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const card = this.closest('.card');
                if (!card) return;
                const parentCol = card.parentElement;
                if (!parentCol) return;

                if (this.classList.contains('btn-reorder-up')) {
                    const prev = card.previousElementSibling;
                    if (prev && prev.classList.contains('card')) {
                        parentCol.insertBefore(card, prev);
                        saveLayout();
                    }
                } else if (this.classList.contains('btn-reorder-down')) {
                    const next = card.nextElementSibling;
                    if (next && next.classList.contains('card')) {
                        parentCol.insertBefore(next, card);
                        saveLayout();
                    }
                } else if (this.classList.contains('btn-reorder-side')) {
                    const targetCol = (parentCol === colStream) ? colControls : colStream;
                    if (targetCol) {
                        targetCol.appendChild(card);
                        saveLayout();
                    }
                }
            });
        });

        // 2. Safe HTML5 Drag & Drop (Handle-Only to Prevent Slider / Input Collision)
        let draggedCard = null;
        let activeHandleCard = null;

        document.querySelectorAll('.card').forEach(card => {
            // Cards must NEVER have draggable="true" by default so sliders, buttons, inputs work natively
            card.removeAttribute('draggable');
            card.classList.remove('is-dragging', 'drag-over');

            const handle = card.querySelector('.card-drag-handle');
            if (handle) {
                // Drag is ONLY armed when explicitly pressing mouse/touch down on the 6-dots handle icon
                handle.addEventListener('mousedown', function(e) {
                    activeHandleCard = card;
                    card.setAttribute('draggable', 'true');
                });
                handle.addEventListener('touchstart', function(e) {
                    activeHandleCard = card;
                    card.setAttribute('draggable', 'true');
                }, { passive: true });
            }

            // Guard all inputs, sliders, and controls so mousedown on them disarms any card drag immediately
            card.querySelectorAll('input, select, button, textarea, canvas, .presets-row, .slider-row, .slider-group').forEach(ctrl => {
                ctrl.addEventListener('mousedown', function(e) {
                    activeHandleCard = null;
                    card.removeAttribute('draggable');
                    e.stopPropagation();
                }, { passive: true });
            });

            card.addEventListener('dragstart', function(e) {
                // Reject drag immediately if it did not originate from the 6-dots drag handle
                if (!activeHandleCard || activeHandleCard !== this || e.target.closest('input, select, button, textarea, canvas, .presets-row, .slider-row, .slider-group')) {
                    e.preventDefault();
                    this.removeAttribute('draggable');
                    activeHandleCard = null;
                    return false;
                }
                draggedCard = this;
                this.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', this.id);
            });

            card.addEventListener('dragend', function() {
                this.classList.remove('is-dragging');
                this.removeAttribute('draggable');
                document.querySelectorAll('.card.drag-over').forEach(c => c.classList.remove('drag-over'));
                draggedCard = null;
                activeHandleCard = null;
                saveLayout();
            });

            card.addEventListener('dragover', function(e) {
                if (!draggedCard || draggedCard === this) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                this.classList.add('drag-over');
            });

            card.addEventListener('dragleave', function() {
                this.classList.remove('drag-over');
            });

            card.addEventListener('drop', function(e) {
                e.preventDefault();
                this.classList.remove('drag-over');
                this.removeAttribute('draggable');
                if (draggedCard) draggedCard.removeAttribute('draggable');
                activeHandleCard = null;
                if (!draggedCard || draggedCard === this) return;

                const parent = this.parentElement;
                const rect = this.getBoundingClientRect();
                const isAfter = (e.clientY - rect.top) > (rect.height / 2);

                if (isAfter) {
                    parent.insertBefore(draggedCard, this.nextSibling);
                } else {
                    parent.insertBefore(draggedCard, this);
                }
                saveLayout();
            });
        });

        // Global mouseup/touchend cleanup to ensure cards are always disarmed
        window.addEventListener('mouseup', function() {
            if (activeHandleCard) {
                activeHandleCard.removeAttribute('draggable');
                activeHandleCard = null;
            }
        });
        window.addEventListener('touchend', function() {
            if (activeHandleCard) {
                activeHandleCard.removeAttribute('draggable');
                activeHandleCard = null;
            }
        });

        // Allow dropping directly onto empty space in columns
        [colStream, colControls].forEach(col => {
            if (!col) return;
            col.addEventListener('dragover', function(e) {
                if (!draggedCard) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            col.addEventListener('drop', function(e) {
                if (!draggedCard) return;
                if (e.target === col) {
                    col.appendChild(draggedCard);
                    saveLayout();
                }
            });
        });

        // 3. Reset Layout Button
        if (btnResetLayout) {
            btnResetLayout.addEventListener('click', function(e) {
                e.preventDefault();
                defaultLayout.left.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && colStream) colStream.appendChild(el);
                });
                defaultLayout.right.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && colControls) colControls.appendChild(el);
                });
                try {
                    localStorage.removeItem('winvr_card_layout');
                } catch (err) {}
            });
        }
    }

    // Initialize
    initTheme();
    initCollapsibleSections();
    initCardReordering();
    loadSavedCalibration();
    loadNetworkInfo();
    connectServer();
    requestAnimationFrame(drawVisualizer);

})();
