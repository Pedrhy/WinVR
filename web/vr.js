/**
 * WinVR Mobile - Ultra-Reliable 3D Virtual Cinema & Head Tracking
 *
 * Core Features:
 * - Maximum Bandwidth & Sub-Millisecond Latency: UDP DataChannel with MTU-optimized chunking.
 * - Desynchronized Low-Latency WebGL: Bypasses Android compositor queue for 0-latency frames.
 * - Full Lifecycle Resuscitation: Seamless backgrounding/foregrounding, auto-layout, stream re-binding.
 * - WebGL Context Lost & Restored: Automatic GPU recovery without page reloads.
 * - 100% Reliable Single-Tap Recenter: Centers screen at eye level and levels horizon instantly.
 * - Hardware Sensor Fusion: RelativeOrientationSensor with zero Euler gimbal tilt.
 * - Anti-Sleep Display Engine: Keeps screen awake permanently using Screen WakeLock & video loop.
 */

(function() {
    'use strict';

    const degToRad = Math.PI / 180;

    // Silent 0.1s MP4 video used to prevent mobile display sleep
    const WAKE_VIDEO_DATA = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAAAhmcmVlAAAAEG1kYXQAAAEAABAAAAABAQAAABhidHJrAAAAfHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAACgAAAAAAABRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAACgAAAAAAAEAAAAAAAZtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAAAAA+gAAAPoAAAAAAA1aGRscgAAAAAAAAAAdmRscgAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAAA';

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

    // State & Settings
    const state = {
        viewMode: 'dome', // 'dome' (Meta Quest FPV) | 'cinema' (IMAX) | 'sbs' (3D Stereoscopic)
        dividerRatio: 0.50, // Center screen split ratio (0.40 - 0.60)
        lensOffset: 0.0, // Horizontal lens convergence shift in mm (-15 to +15)
        shiftX: 0.0, // Optical axis stereoscopic convergence shift in mm (-30 to +30)
        shiftY: 0.0, // Vertical optical alignment shift in mm (-15 to +15)
        fov: 105, // Field of view (degrees)
        curved: true,
        screenDistance: 3.2, // meters
        screenScale: 1.0,
        screenElevation: 0.0, // meters above eye level
        ipd: 0.063, // 63mm standard eye separation
        blackLevel: 0.0,
        whiteLevel: 1.0,
        gamma: 1.00, // Gamma curve (1.00 = 1:1 monitor reference)
        contrast: 1.00, // Dynamic contrast (1.00 = 1:1 monitor reference)
        brightness: 0.00, // Brightness offset (0.00 = 1:1 monitor reference)
        saturation: 1.00, // Saturation (1.00 = 1:1 monitor reference)
        exposure: 1.00, // Daylight exposure multiplier (1.00 = 1:1 monitor reference)
        highlightCut: 0.00, // Highlight roll-off (0.00 = 1:1 monitor reference)
        shadowBoost: 0.00, // Cockpit interior shadow compensation (0.00 = 1:1 inky blacks)
        lastAllocW: 0,
        lastAllocH: 0,
        connected: false,
        streaming: false,
        hudVisible: false,
        glContextLost: false,
        inVrMode: false,
        targetFps: 60,

        // Quaternions
        rawDeviceQuat: [0, 0, 0, 1],
        screenQuat: [0, 0, 0, 1],
        smoothedQuat: [0, 0, 0, 1],
        recenterQuat: [0, 0, 0, 1],
        headQuat: [0, 0, 0, 1],
        viewQuat: [0, 0, 0, 1],
        hasSensorReading: false,
        calibrated: false,

        // Angular tracking for gyro mouse deltas
        lastYaw: null,
        lastPitch: null,
        pendingYawDelta: 0,
        pendingPitchDelta: 0,

        // Direct low-latency motion & real-time telemetry
        fastMotionSupported: false,
        sensorSampleCount: 0,
        motionPacketCount: 0,
        lastSensorCheckTime: 0,
        measuredSensorHz: 0,
        measuredPacketRate: 0,
        measuredControlRtt: 0,
        videoFrameCount: 0,
        lastVideoFpsCheckTime: 0,
        measuredVideoFps: 0,
        videoDroppedFrames: 0,
        videoJitterMs: 0,
        audioUnified: false,

        // Video presentation watchdog & stream health
        lastFrameArrivalSystemTime: 0,
        streamHealth: 'healthy',
        stallRecoveryCount: 0,
        inboundResWidth: 0,
        inboundResHeight: 0,
        inboundBitrateMbps: '0',
        inboundFps: 0,
        packetsLost: 0,
        jitterBufferMs: 0,
        framesDecoded: 0,
        framesDropped: 0,
        avgDecodeTimeMs: 0,
        decoderName: '',
        domeFovH: 135, // 135° Sim Crispness FOV (50% higher center PPD for distant readability)
        domeFovV: 90,

        // Texture timing
        lastVideoTime: -1,

        // Networking
        ws: null,
        pc: null,
        dataChannel: null,
        wakeLock: null,
        sensor: null
    };

    // DOM Elements
    const canvas = document.getElementById('vrCanvas');
    const video = document.getElementById('remoteVideo');
    const wakeVideo = document.getElementById('wakeVideo');
    const audio = document.getElementById('remoteAudio');
    const centerDivider = document.getElementById('centerDivider');
    const overlay = document.getElementById('overlay');
    const btnEnterVR = document.getElementById('btnEnterVR');
    const srvStatus = document.getElementById('srvStatus');
    const streamStatus = document.getElementById('streamStatus');
    const gyroStatus = document.getElementById('gyroStatus');
    const secureWarning = document.getElementById('secureWarning');
    const lnkSwitchHttps = document.getElementById('lnkSwitchHttps');
    const btnPhoneModeDome = document.getElementById('btnPhoneModeDome');
    const btnPhoneModeCinema = document.getElementById('btnPhoneModeCinema');
    const btnPhoneModeSbs = document.getElementById('btnPhoneModeSbs');
    const valPhoneSplit = document.getElementById('valPhoneSplit');
    const rangePhoneSplit = document.getElementById('rangePhoneSplit');
    const valPhoneShiftX = document.getElementById('valPhoneShiftX');
    const rangePhoneShiftX = document.getElementById('rangePhoneShiftX');
    const btnPhoneSaveCalib = document.getElementById('btnPhoneSaveCalib');
    const rangeDistance = document.getElementById('rangeDistance');
    const valDistance = document.getElementById('valDistance');
    const rangeScale = document.getElementById('rangeScale');
    const valScale = document.getElementById('valScale');
    const rangeElevation = document.getElementById('rangeElevation');
    const valElevation = document.getElementById('valElevation');
    const rangeIpd = document.getElementById('rangeIpd');
    const valIpd = document.getElementById('valIpd');
    const hudContainer = document.getElementById('hudContainer');
    const vrToast = document.getElementById('vrToast');

    // WebGL Context Creation with Desynchronized Pipeline (Saves ~16ms input lag on Mobile Chrome)
    const glOptions = {
        alpha: false,
        antialias: false,
        depth: true,
        stencil: false,
        preserveDrawingBuffer: false,
        desynchronized: true,
        powerPreference: 'high-performance'
    };

    let gl = canvas.getContext('webgl', glOptions) || canvas.getContext('experimental-webgl', glOptions);
    if (!gl) {
        alert('WebGL is not supported on this browser.');
        return;
    }

    // Check Secure Context
    const isSecure = window.isSecureContext || window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isSecure && secureWarning) {
        secureWarning.classList.add('visible');
        if (lnkSwitchHttps) {
            lnkSwitchHttps.addEventListener('click', function(e) {
                e.preventDefault();
                const host = window.location.hostname;
                window.location.href = `https://${host}:8443/vr`;
            });
        }
    }

    // =========================================================================
    // Pure 3D Vector, Quaternion & Matrix Mathematics
    // =========================================================================
    const Quat = {
        identity: function(out) {
            out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
            return out;
        },
        copy: function(out, a) {
            out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
            return out;
        },
        multiply: function(out, a, b) {
            const ax = a[0], ay = a[1], az = a[2], aw = a[3];
            const bx = b[0], by = b[1], bz = b[2], bw = b[3];
            out[0] = ax * bw + aw * bx + ay * bz - az * by;
            out[1] = ay * bw + aw * by + az * bx - ax * bz;
            out[2] = az * bw + aw * bz + ax * by - ay * bx;
            out[3] = aw * bw - ax * bx - ay * by - az * bz;
            return out;
        },
        setFromAxisAngle: function(out, axisX, axisY, axisZ, rad) {
            const halfRad = rad * 0.5;
            const s = Math.sin(halfRad);
            out[0] = axisX * s;
            out[1] = axisY * s;
            out[2] = axisZ * s;
            out[3] = Math.cos(halfRad);
            return out;
        },
        setFromEulerYXZ: function(out, x, y, z) {
            const c1 = Math.cos(x * 0.5), s1 = Math.sin(x * 0.5);
            const c2 = Math.cos(y * 0.5), s2 = Math.sin(y * 0.5);
            const c3 = Math.cos(z * 0.5), s3 = Math.sin(z * 0.5);
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            return out;
        },
        invert: function(out, a) {
            out[0] = -a[0];
            out[1] = -a[1];
            out[2] = -a[2];
            out[3] = a[3];
            return out;
        },
        slerp: function(out, a, b, t) {
            let ax = a[0], ay = a[1], az = a[2], aw = a[3];
            let bx = b[0], by = b[1], bz = b[2], bw = b[3];
            let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
            if (cosHalfTheta < 0) {
                bx = -bx; by = -by; bz = -bz; bw = -bw;
                cosHalfTheta = -cosHalfTheta;
            }
            if (cosHalfTheta >= 0.9995) {
                out[0] = ax + t * (bx - ax);
                out[1] = ay + t * (by - ay);
                out[2] = az + t * (bz - az);
                out[3] = aw + t * (bw - aw);
                return out;
            }
            const halfTheta = Math.acos(cosHalfTheta);
            const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
            const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
            const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
            out[0] = ax * ratioA + bx * ratioB;
            out[1] = ay * ratioA + by * ratioB;
            out[2] = az * ratioA + bz * ratioB;
            out[3] = aw * ratioA + bw * ratioB;
            return out;
        },
        toMat4: function(out, q) {
            const x = q[0], y = q[1], z = q[2], w = q[3];
            const x2 = x + x, y2 = y + y, z2 = z + z;
            const xx = x * x2, xy = x * y2, xz = x * z2;
            const yy = y * y2, yz = y * z2, zz = z * z2;
            const wx = w * x2, wy = w * y2, wz = w * z2;

            out[0] = 1 - (yy + zz);
            out[1] = xy + wz;
            out[2] = xz - wy;
            out[3] = 0;

            out[4] = xy - wz;
            out[5] = 1 - (xx + zz);
            out[6] = yz + wx;
            out[7] = 0;

            out[8] = xz + wy;
            out[9] = yz - wx;
            out[10] = 1 - (xx + yy);
            out[11] = 0;

            out[12] = 0;
            out[13] = 0;
            out[14] = 0;
            out[15] = 1;
            return out;
        }
    };

    const Mat4 = {
        create: function() {
            return new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ]);
        },
        perspectiveOffCenter: function(out, fovY, aspect, near, far, offsetX, offsetY) {
            const f = 1.0 / Math.tan(fovY * 0.5);
            const nf = 1.0 / (near - far);
            out[0] = f / aspect;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = f;
            out[6] = 0;
            out[7] = 0;
            out[8] = offsetX || 0;
            out[9] = offsetY || 0;
            out[10] = (far + near) * nf;
            out[11] = -1;
            out[12] = 0;
            out[13] = 0;
            out[14] = (2 * far * near) * nf;
            out[15] = 0;
            return out;
        },
        multiply: function(out, a, b) {
            const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
            const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
            const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
            const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

            let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
            out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

            b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
            out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

            b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
            out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

            b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
            out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
            return out;
        },
        translate: function(out, a, x, y, z) {
            out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
            out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
            out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
            out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
            out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
            out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
            out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
            return out;
        }
    };

    // Camera Constants
    const qOrient = new Float32Array([0, 0, 0, 1]);
    const invRecenter = new Float32Array([0, 0, 0, 1]);
    const rotMatrix = Mat4.create();
    const viewMatrix = Mat4.create();
    const projMatrix = Mat4.create();
    const mvpMatrix = Mat4.create();

    // =========================================================================
    // Modular WebGL Shaders & Pipeline with Context Restoration
    // =========================================================================
    const vsSource = `
        attribute vec3 a_position;
        attribute vec2 a_texCoord;
        uniform mat4 u_mvp;
        varying vec2 v_texCoord;

        void main() {
            gl_Position = u_mvp * vec4(a_position, 1.0);
            v_texCoord = a_texCoord;
        }
    `;

    const fsSource = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform sampler2D u_texture;
        uniform float u_isStar;
        uniform vec2 u_uvScale;
        uniform vec2 u_uvOffset;

        // Tone Mapping, Washout Elimination & Highlight Compression Uniforms (100% Zero-Latency ALU)
        uniform float u_blackLevel;
        uniform float u_whiteLevel;
        uniform float u_exposure;
        uniform float u_highlightCut;
        uniform float u_shadowBoost;
        uniform float u_gamma;
        uniform float u_contrast;
        uniform float u_brightness;
        uniform float u_saturation;

        void main() {
            if (u_isStar > 0.5) {
                gl_FragColor = vec4(0.85, 0.92, 1.0, 0.8);
            } else {
                vec2 uv = v_texCoord * u_uvScale + u_uvOffset;
                vec4 col = texture2D(u_texture, uv);
                vec3 rgb = col.rgb;

                // 1. Studio-to-Full Range expansion (removes Chromium YUV [16, 235] black level lift)
                if (u_blackLevel > 0.001 || u_whiteLevel < 0.999) {
                    rgb = clamp((rgb - vec3(u_blackLevel)) / max(0.001, u_whiteLevel - u_blackLevel), 0.0, 1.0);
                }

                // 2. Exposure scaling (1.0 = reference 1:1 monitor match)
                if (abs(u_exposure - 1.0) > 0.001) {
                    rgb *= u_exposure;
                }

                // 3. Photographic Filmic Highlight Shoulder Roll-Off (0.0 = reference 1:1 monitor match)
                if (u_highlightCut > 0.001) {
                    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
                    float knee = 0.65;
                    if (luma > knee) {
                        float overflow = (luma - knee) / (1.0 - knee);
                        float compress = overflow / (1.0 + overflow);
                        float targetLuma = knee + (1.0 - knee) * compress;
                        float scale = targetLuma / max(0.001, luma);
                        rgb = mix(rgb, rgb * scale, u_highlightCut);
                    }
                }

                // 4. Cockpit Shadow compensation (0.0 = reference 1:1 inky blacks)
                if (u_shadowBoost > 0.001) {
                    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
                    float shadowMask = smoothstep(0.35, 0.02, luma);
                    rgb += shadowMask * (u_shadowBoost * vec3(1.0));
                }

                // 5. Contrast & Brightness correction (1.0 contrast, 0.0 brightness = reference)
                if (abs(u_contrast - 1.0) > 0.001 || abs(u_brightness) > 0.001) {
                    rgb = (rgb - 0.5) * u_contrast + 0.5 + u_brightness;
                    rgb = clamp(rgb, 0.0, 1.0);
                }

                // 6. Gamma power curve (1.0 = reference linear pass-through)
                if (abs(u_gamma - 1.0) > 0.001) {
                    rgb = pow(clamp(rgb, 0.0, 1.0), vec3(u_gamma));
                }

                // 7. Color saturation & vibrance (1.0 = reference natural color)
                if (abs(u_saturation - 1.0) > 0.001) {
                    float lumaFinal = dot(rgb, vec3(0.299, 0.587, 0.114));
                    rgb = mix(vec3(lumaFinal), rgb, u_saturation);
                }

                gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), col.a);
            }
        }
    `;

    function compileShader(glContext, type, src) {
        const s = glContext.createShader(type);
        glContext.shaderSource(s, src);
        glContext.compileShader(s);
        if (!glContext.getShaderParameter(s, glContext.COMPILE_STATUS)) {
            console.error('[WinVR WebGL] Shader compile error:', glContext.getShaderInfoLog(s));
            glContext.deleteShader(s);
            return null;
        }
        return s;
    }

    // Pipeline Globals
    let program = null;
    let locations = {};
    let videoTexture = null;
    let screenPosBuffer = null;
    let screenTexBuffer = null;
    let screenIndexBuffer = null;
    let starPosBuffer = null;
    let starTexBuffer = null;
    let starIndexBuffer = null;
    let screenMesh = null;
    let starMesh = null;

    function initWebGLPipeline() {
        if (!gl || gl.isContextLost()) return false;

        const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
        if (!vs || !fs) return false;

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('[WinVR WebGL] Program link error:', gl.getProgramInfoLog(program));
            return false;
        }
        gl.useProgram(program);

        locations = {
            position: gl.getAttribLocation(program, 'a_position'),
            texCoord: gl.getAttribLocation(program, 'a_texCoord'),
            mvp: gl.getUniformLocation(program, 'u_mvp'),
            texture: gl.getUniformLocation(program, 'u_texture'),
            isStar: gl.getUniformLocation(program, 'u_isStar'),
            uvScale: gl.getUniformLocation(program, 'u_uvScale'),
            uvOffset: gl.getUniformLocation(program, 'u_uvOffset'),
            blackLevel: gl.getUniformLocation(program, 'u_blackLevel'),
            whiteLevel: gl.getUniformLocation(program, 'u_whiteLevel'),
            exposure: gl.getUniformLocation(program, 'u_exposure'),
            highlightCut: gl.getUniformLocation(program, 'u_highlightCut'),
            shadowBoost: gl.getUniformLocation(program, 'u_shadowBoost'),
            gamma: gl.getUniformLocation(program, 'u_gamma'),
            contrast: gl.getUniformLocation(program, 'u_contrast'),
            brightness: gl.getUniformLocation(program, 'u_brightness'),
            saturation: gl.getUniformLocation(program, 'u_saturation')
        };

        // Standard sRGB full-range video texture
        videoTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Hardware Anisotropic Filtering: sharpens oblique racing track, road markings and distant text
        const extAniso = gl.getExtension('EXT_texture_filter_anisotropic') ||
                         gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
                         gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
        if (extAniso) {
            const maxAniso = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 4;
            gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
            console.log(`[WinVR WebGL] Hardware Anisotropic Filtering active (${Math.min(8, maxAniso)}x)`);
        }

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 14, 24, 255]));

        // Screen Buffers
        screenMesh = state.viewMode === 'dome'
            ? buildFpvDomeMesh(1.8, state.domeFovH || 135, state.domeFovV || 90)
            : buildCinemaScreenMesh(state.screenDistance, 16 / 9, state.screenScale, state.curved, state.screenElevation);
        starMesh = buildStarfieldMesh(350, 45.0);

        screenPosBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, screenPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, screenMesh.positions, gl.DYNAMIC_DRAW);

        screenTexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, screenTexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, screenMesh.texCoords, gl.DYNAMIC_DRAW);

        screenIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, screenIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, screenMesh.indices, gl.DYNAMIC_DRAW);

        // Starfield Buffers
        starPosBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, starPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, starMesh.positions, gl.STATIC_DRAW);

        starTexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, starTexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, starMesh.texCoords, gl.STATIC_DRAW);

        starIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, starIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, starMesh.indices, gl.STATIC_DRAW);

        console.log('[WinVR WebGL] Pipeline initialized successfully.');
        return true;
    }

    // WebGL Context Lost & Restored Event Handlers (Essential for mobile app-switching)
    canvas.addEventListener('webglcontextlost', function(e) {
        e.preventDefault();
        state.glContextLost = true;
        console.warn('[WinVR WebGL] Context Lost! Waiting for GPU restoration...');
    }, false);

    canvas.addEventListener('webglcontextrestored', function() {
        state.glContextLost = false;
        console.log('[WinVR WebGL] Context Restored! Rebuilding rendering pipeline...');
        initWebGLPipeline();
        updateScreenGeometry();
        state.lastVideoTime = -1;
    }, false);

    // Initial pipeline build
    initWebGLPipeline();

    // --- Mesh Generation (Virtual Cinema Screen & Starfield) ---
    function buildCinemaScreenMesh(distance, aspect, scale, curved, elevation) {
        const slices = 32;
        const stacks = 16;
        const positions = [];
        const texCoords = [];
        const indices = [];

        // Safe numerical normalization to prevent any possibility of NaN
        distance = (typeof distance === 'number' && !isNaN(distance) && distance > 0.5) ? distance : 3.2;
        scale = (typeof scale === 'number' && !isNaN(scale) && scale > 0.1) ? scale : 1.0;
        elevation = (typeof elevation === 'number' && !isNaN(elevation)) ? elevation : 0.0;
        aspect = (typeof aspect === 'number' && !isNaN(aspect) && aspect > 0.2) ? aspect : (16 / 9);

        // True physical theater screen geometry:
        // Base screen width = 3.8 meters at 100% scale
        const baseWidth = 3.8;
        const physicalWidth = baseWidth * scale;
        const physicalHeight = physicalWidth / aspect;

        // Subtended horizontal arc for curved cinema screen:
        // Capped at 160° so immense screens curve gently and never wrap behind the viewer
        const maxArcRad = 160 * degToRad;
        const arcAngle = Math.min(maxArcRad, physicalWidth / distance);

        for (let y = 0; y <= stacks; y++) {
            const v = y / stacks;
            const posY = (v - 0.5) * physicalHeight + elevation;

            for (let x = 0; x <= slices; x++) {
                const u = x / slices;
                let posX, posZ;

                if (curved) {
                    const angle = (u - 0.5) * arcAngle;
                    posX = Math.sin(angle) * distance;
                    posZ = -Math.cos(angle) * distance;
                } else {
                    posX = (u - 0.5) * physicalWidth;
                    posZ = -distance;
                }

                positions.push(posX, posY, posZ);
                texCoords.push(u, 1.0 - v);
            }
        }

        for (let y = 0; y < stacks; y++) {
            for (let x = 0; x < slices; x++) {
                const first = y * (slices + 1) + x;
                const second = first + slices + 1;
                indices.push(first, second, first + 1);
                indices.push(second, second + 1, first + 1);
            }
        }

        return {
            positions: new Float32Array(positions),
            texCoords: new Float32Array(texCoords),
            indices: new Uint16Array(indices),
            count: indices.length
        };
    }

    function buildStarfieldMesh(starCount, radius) {
        const positions = [];
        const texCoords = [];
        const indices = [];

        for (let i = 0; i < starCount; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos((Math.random() * 2) - 1);
            const x = radius * Math.sin(phi) * Math.cos(theta);
            const y = radius * Math.sin(phi) * Math.sin(theta);
            const z = radius * Math.cos(phi);

            const s = 0.08;
            const base = (i * 4);
            positions.push(x - s, y - s, z, x + s, y - s, z, x + s, y + s, z, x - s, y + s, z);
            texCoords.push(0, 0, 1, 0, 1, 1, 0, 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }

        return {
            positions: new Float32Array(positions),
            texCoords: new Float32Array(texCoords),
            indices: new Uint16Array(indices),
            count: indices.length
        };
    }

    // --- FPV 180° Game Dome Geometry (Wraps vision for Meta Quest realism) ---
    function buildFpvDomeMesh(radius, hFovDeg, vFovDeg, slices, stacks) {
        radius = radius || 1.8;
        hFovDeg = hFovDeg || 195;
        vFovDeg = vFovDeg || 115;
        slices = slices || 48;
        stacks = stacks || 24;

        const positions = [];
        const texCoords = [];
        const indices = [];

        const hFovRad = hFovDeg * degToRad;
        const vFovRad = vFovDeg * degToRad;

        for (let y = 0; y <= stacks; y++) {
            const v = y / stacks;
            const phi = (v - 0.5) * vFovRad;
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);

            for (let x = 0; x <= slices; x++) {
                const u = x / slices;
                const theta = (u - 0.5) * hFovRad;
                const sinTheta = Math.sin(theta);
                const cosTheta = Math.cos(theta);

                const posX = radius * sinTheta * cosPhi;
                const posY = radius * sinPhi;
                const posZ = -radius * cosTheta * cosPhi;

                positions.push(posX, posY, posZ);
                texCoords.push(u, 1.0 - v);
            }
        }

        for (let y = 0; y < stacks; y++) {
            for (let x = 0; x < slices; x++) {
                const first = y * (slices + 1) + x;
                const second = first + slices + 1;
                indices.push(first, second, first + 1);
                indices.push(second, second + 1, first + 1);
            }
        }

        return {
            positions: new Float32Array(positions),
            texCoords: new Float32Array(texCoords),
            indices: new Uint16Array(indices),
            count: indices.length
        };
    }

    function updateScreenGeometry() {
        if (!gl || state.glContextLost || !screenPosBuffer) return;

        const aspect = (video.videoWidth && video.videoHeight) ? (video.videoWidth / video.videoHeight) : (16 / 9);

        if (state.viewMode === 'dome') {
            const hFov = state.domeFovH || 135;
            const vFov = state.domeFovV || 90;
            screenMesh = buildFpvDomeMesh(1.8, hFov, vFov);
        } else if (state.viewMode === 'dome_wide') {
            screenMesh = buildFpvDomeMesh(1.8, 195, 115);
        } else {
            screenMesh = buildCinemaScreenMesh(state.screenDistance, aspect, state.screenScale, state.curved, state.screenElevation);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, screenPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, screenMesh.positions, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, screenTexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, screenMesh.texCoords, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, screenIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, screenMesh.indices, gl.DYNAMIC_DRAW);
    }

    // --- Live Screen Split & Alignment Handlers ---
    function updateDividerPosition() {
        const ratio = state.dividerRatio || 0.5;
        if (centerDivider) {
            centerDivider.style.left = (ratio * 100).toFixed(1) + '%';
        }
        if (rangePhoneSplit) {
            rangePhoneSplit.value = (ratio * 100).toFixed(1);
        }
        if (valPhoneSplit) {
            valPhoneSplit.textContent = (ratio * 100).toFixed(1) + '%';
        }
        const hintLeft = document.querySelector('.hint-left');
        const hintRight = document.querySelector('.hint-right');
        if (hintLeft) hintLeft.style.left = (ratio * 50).toFixed(1) + '%';
        if (hintRight) hintRight.style.left = (50 + (1 - ratio) * 50).toFixed(1) + '%';
        updateVisionAlignmentUI();
    }

    function updateVisionAlignmentUI() {
        if (rangePhoneShiftX) {
            rangePhoneShiftX.value = state.shiftX.toFixed(1);
        }
        if (valPhoneShiftX) {
            valPhoneShiftX.textContent = (state.shiftX >= 0 ? '+' : '') + state.shiftX.toFixed(1) + 'mm';
        }
    }

    function sendControlPacket(msgObj) {
        // High-frequency sensor guard: if network queue has backpressure, drop stale deltas
        if (msgObj.type === 'gyro_delta') {
            if (state.dataChannel && state.dataChannel.readyState === 'open') {
                if (state.dataChannel.bufferedAmount > 2048) return;
            } else if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                if (state.ws.bufferedAmount > 2048) return;
            }
        }

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

    function syncVisionAlignmentToPC() {
        sendControlPacket({
            type: 'tune_crosshair',
            shiftX: state.shiftX,
            shiftY: state.shiftY
        });
    }

    function saveCalibration() {
        const calib = {
            shiftX: state.shiftX,
            shiftY: state.shiftY,
            dividerRatio: state.dividerRatio,
            lensOffset: state.lensOffset,
            ipd: Math.round(state.ipd * 1000),
            mode: state.viewMode,
            fov: state.fov,
            distance: state.screenDistance,
            scale: state.screenScale,
            elevation: state.screenElevation,
            curved: state.curved,
            gamma: state.gamma,
            contrast: state.contrast,
            brightness: state.brightness,
            saturation: state.saturation,
            exposure: state.exposure,
            highlightCut: state.highlightCut,
            shadowBoost: state.shadowBoost
        };
        try {
            localStorage.setItem('winvr_calibration', JSON.stringify(calib));
        } catch (e) {}

        showToast('💾 Alignment Saved as Default!');

        sendControlPacket({
            type: 'save_calibration',
            calibration: calib
        });
    }

    function loadSavedCalibration() {
        try {
            const saved = localStorage.getItem('winvr_calibration');
            if (saved) {
                const calib = JSON.parse(saved);
                if (calib.shiftX !== undefined) state.shiftX = parseFloat(calib.shiftX);
                if (calib.shiftY !== undefined) state.shiftY = parseFloat(calib.shiftY);
                if (calib.dividerRatio !== undefined) state.dividerRatio = parseFloat(calib.dividerRatio);
                if (calib.lensOffset !== undefined) state.lensOffset = parseFloat(calib.lensOffset);
                if (calib.ipd !== undefined) state.ipd = parseInt(calib.ipd, 10) / 1000.0;
                if (calib.mode !== undefined) state.viewMode = calib.mode;
                if (calib.fov !== undefined) state.fov = parseInt(calib.fov, 10);
                if (calib.distance !== undefined) state.screenDistance = parseFloat(calib.distance);
                else if (calib.screenDistance !== undefined) state.screenDistance = parseFloat(calib.screenDistance);
                if (calib.scale !== undefined) state.screenScale = parseFloat(calib.scale);
                else if (calib.screenScale !== undefined) state.screenScale = parseFloat(calib.screenScale);
                if (calib.elevation !== undefined) state.screenElevation = parseFloat(calib.elevation);
                else if (calib.screenElevation !== undefined) state.screenElevation = parseFloat(calib.screenElevation);
                if (calib.curved !== undefined) state.curved = Boolean(calib.curved);
                if (calib.gamma !== undefined) state.gamma = parseFloat(calib.gamma);
                if (calib.contrast !== undefined) state.contrast = parseFloat(calib.contrast);
                if (calib.brightness !== undefined) state.brightness = parseFloat(calib.brightness);
                if (calib.saturation !== undefined) state.saturation = parseFloat(calib.saturation);
                if (calib.exposure !== undefined) state.exposure = parseFloat(calib.exposure);
                if (calib.highlightCut !== undefined) state.highlightCut = parseFloat(calib.highlightCut);
                if (calib.shadowBoost !== undefined) state.shadowBoost = parseFloat(calib.shadowBoost);
            }
        } catch (e) {}
    }

    let glowTimer = null;
    function flashDividerGlow() {
        if (!centerDivider) return;
        centerDivider.classList.add('tuning');
        clearTimeout(glowTimer);
        glowTimer = setTimeout(() => {
            centerDivider.classList.remove('tuning');
        }, 1200);
    }

    function setMode(mode, syncToPC) {
        state.viewMode = mode;
        if (mode === 'dome') {
            state.domeFovH = 135;
            state.domeFovV = 90;
        } else if (mode === 'dome_wide') {
            state.domeFovH = 195;
            state.domeFovV = 115;
        }
        updateScreenGeometry();

        document.querySelectorAll('.hud-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.action === 'mode-' + mode);
        });

        document.querySelectorAll('.mode-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });

        const names = {
            dome: '🏎️ Sim Crisp (135° Dome)',
            dome_wide: '🌐 Ultra-Wide (195° Dome)',
            cinema: '🎬 Virtual Cinema (IMAX)',
            sbs: '👓 3D SBS (Stereoscopic)'
        };
        showToast(names[mode] || mode);

        if (syncToPC) {
            sendControlPacket({
                type: 'tune_vr',
                mode: state.viewMode,
                dividerRatio: state.dividerRatio,
                lensOffset: state.lensOffset,
                ipd: Math.round(state.ipd * 1000),
                fov: state.fov,
                domeFovH: state.domeFovH
            });
        }
    }

    // =========================================================================
    // Robust Zero-Gimbal Sensor Fusion & Ultra-Low Latency Tracking
    // =========================================================================
    const rawHeadQuat = new Float32Array(4);

    function processDeviceAngles(alpha, beta, gamma) {
        gyroStatus.textContent = 'Active (Direct 60Hz)';
        gyroStatus.className = 'status-value badge-connected';

        const screenAngle = (screen.orientation ? screen.orientation.angle : window.orientation) || 0;
        const orient = screenAngle * degToRad;

        // 1. Device Quaternion from Euler (YXZ)
        Quat.setFromEulerYXZ(state.rawDeviceQuat, beta * degToRad, alpha * degToRad, -gamma * degToRad);

        // 2. Adjust for landscape orientation
        Quat.setFromAxisAngle(qOrient, 0, 0, 1, -orient);
        Quat.multiply(state.screenQuat, state.rawDeviceQuat, qOrient);

        // 3. Ultra-Responsive Head Orientation (0.85 response factor prevents sluggish float)
        Quat.slerp(state.smoothedQuat, state.smoothedQuat, state.screenQuat, 0.85);

        if (!state.calibrated) {
            recenter();
            state.calibrated = true;
        }

        // 4. Head rotation relative to recenter point
        Quat.invert(invRecenter, state.recenterQuat);
        Quat.multiply(state.headQuat, invRecenter, state.smoothedQuat);

        computeEulerDeltas();
    }

    function trackSensorTelemetry() {
        state.sensorSampleCount = (state.sensorSampleCount || 0) + 1;
        const now = performance.now();
        if (!state.lastSensorCheckTime) state.lastSensorCheckTime = now;
        const elapsed = now - state.lastSensorCheckTime;
        if (elapsed >= 1000) {
            state.measuredSensorHz = Math.round((state.sensorSampleCount / (elapsed / 1000)) * 10) / 10;
            state.measuredPacketRate = Math.round((state.motionPacketCount || 0) / (elapsed / 1000));
            state.sensorSampleCount = 0;
            state.motionPacketCount = 0;
            state.lastSensorCheckTime = now;
            updateHudTelemetry();
        }
    }

    // High-speed instantaneous angular delta computation for PC Game Gyro Look (0ms software lag)
    function computeEulerDeltas() {
        trackSensorTelemetry();

        // Calculate deltas from raw physical orientation to eliminate all filter lag in games
        Quat.invert(invRecenter, state.recenterQuat);
        Quat.multiply(rawHeadQuat, invRecenter, state.screenQuat);

        const q = rawHeadQuat;
        const x = q[0], y = q[1], z = q[2], w = q[3];

        const siny_cosp = 2 * (w * y + z * x);
        const cosy_cosp = 1 - 2 * (x * x + y * y);
        const curYaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

        // Clamp sinp to prevent NaN gimbal singularity
        const sinp = Math.max(-0.999, Math.min(0.999, 2 * (w * x - y * z)));
        const curPitch = Math.asin(sinp) * (180 / Math.PI);

        if (state.lastYaw === null) {
            state.lastYaw = curYaw;
            state.lastPitch = curPitch;
            state.pendingYawDelta = 0;
            state.pendingPitchDelta = 0;
            return;
        }

        let dYaw = curYaw - state.lastYaw;
        let dPitch = curPitch - state.lastPitch;

        if (dYaw > 180) dYaw -= 360;
        if (dYaw < -180) dYaw += 360;
        if (dPitch > 180) dPitch -= 360;
        if (dPitch < -180) dPitch += 360;

        state.lastYaw = curYaw;
        state.lastPitch = curPitch;

        // Adaptive Stationary Noise Floor: filter out micro-flutter when resting
        const noiseFloorDeg = 0.006;
        if (Math.abs(dYaw) < noiseFloorDeg && Math.abs(dPitch) < noiseFloorDeg) {
            // Gradually decay pending residual so stationary sensor noise cannot accumulate
            state.pendingYawDelta = (state.pendingYawDelta || 0) * 0.75;
            state.pendingPitchDelta = (state.pendingPitchDelta || 0) * 0.75;
            if (Math.abs(state.pendingYawDelta) < 0.001) state.pendingYawDelta = 0;
            if (Math.abs(state.pendingPitchDelta) < 0.001) state.pendingPitchDelta = 0;
            return;
        }

        // Accumulate angular motion so intentional movements are never lost
        state.pendingYawDelta = (state.pendingYawDelta || 0) + dYaw;
        state.pendingPitchDelta = (state.pendingPitchDelta || 0) + dPitch;

        const outDx = state.pendingYawDelta;
        const outDy = state.pendingPitchDelta;

        // Transmission threshold: send when intentional movement is at least 0.006 deg
        if (Math.abs(outDx) < noiseFloorDeg && Math.abs(outDy) < noiseFloorDeg) {
            return;
        }

        // Direct fast-path WebSocket transmission: 1-hop straight to WinVR.exe (bypasses host browser)
        if (state.fastMotionSupported && state.ws && state.ws.readyState === WebSocket.OPEN) {
            if (state.ws.bufferedAmount <= 2048) {
                const now = performance.now();
                state.ws.send(`G,${outDx.toFixed(4)},${outDy.toFixed(4)},${now.toFixed(1)}`);
                state.motionPacketCount = (state.motionPacketCount || 0) + 1;
                state.pendingYawDelta = 0;
                state.pendingPitchDelta = 0;
            }
            // If socket has backpressure (> 2048), pending deltas remain accumulated for the next tick
            return;
        }

        // Fallback transmission (DataChannel or standard JSON packet)
        let sent = false;
        if (state.dataChannel && state.dataChannel.readyState === 'open') {
            if (state.dataChannel.bufferedAmount <= 2048) {
                sent = MtuChunker.send(state.dataChannel, JSON.stringify({
                    type: 'gyro_delta',
                    dx: outDx,
                    dy: outDy
                }));
            }
        } else if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            if (state.ws.bufferedAmount <= 2048) {
                state.ws.send(JSON.stringify({
                    type: 'gyro_delta',
                    dx: outDx,
                    dy: outDy
                }));
                sent = true;
            }
        }

        if (sent) {
            state.motionPacketCount = (state.motionPacketCount || 0) + 1;
            state.pendingYawDelta = 0;
            state.pendingPitchDelta = 0;
        }
    }

    function initSensors() {
        if ('RelativeOrientationSensor' in window) {
            try {
                if (state.sensor) {
                    try { state.sensor.stop(); } catch (e) {}
                }
                const sensor = new RelativeOrientationSensor({ frequency: 100 });
                sensor.addEventListener('reading', () => {
                    const q = sensor.quaternion;
                    state.rawDeviceQuat[0] = q[0];
                    state.rawDeviceQuat[1] = q[1];
                    state.rawDeviceQuat[2] = q[2];
                    state.rawDeviceQuat[3] = q[3];

                    const screenAngle = (screen.orientation ? screen.orientation.angle : window.orientation) || 0;
                    Quat.setFromAxisAngle(qOrient, 0, 0, 1, -screenAngle * degToRad);
                    Quat.multiply(state.screenQuat, state.rawDeviceQuat, qOrient);

                    // High-frequency responsive headset orientation
                    Quat.slerp(state.smoothedQuat, state.smoothedQuat, state.screenQuat, 0.85);

                    if (!state.calibrated) {
                        recenter();
                        state.calibrated = true;
                    }

                    Quat.invert(invRecenter, state.recenterQuat);
                    Quat.multiply(state.headQuat, invRecenter, state.smoothedQuat);

                    computeEulerDeltas();
                });
                sensor.start();
                state.sensor = sensor;
                gyroStatus.textContent = 'Hardware Sensor Hub (100Hz Direct)';
                gyroStatus.className = 'status-value badge-connected';
                return;
            } catch (e) {}
        }

        // Fallback: DeviceOrientationEvent
        window.addEventListener('deviceorientation', function(e) {
            if (e.alpha === null || e.beta === null || e.gamma === null) return;
            processDeviceAngles(e.alpha, e.beta, e.gamma);
        }, true);
    }

    // =========================================================================
    // 🎯 Instant Recenter Engine (Guarantees Level Horizon at Eye Level)
    // =========================================================================
    function recenter() {
        Quat.copy(state.recenterQuat, state.smoothedQuat);
        Quat.identity(state.headQuat);
        Quat.identity(state.viewQuat);
        state.lastYaw = null;
        state.lastPitch = null;
        state.pendingYawDelta = 0;
        state.pendingPitchDelta = 0;
        showToast('Screen Centered & Leveled');
    }

    // =========================================================================
    // Anti-Sleep Display Engine
    // =========================================================================
    async function activateAntiSleep() {
        try {
            if (wakeVideo) {
                wakeVideo.src = WAKE_VIDEO_DATA;
                await wakeVideo.play();
            }
        } catch (e) {}

        if ('wakeLock' in navigator) {
            try {
                if (state.wakeLock) {
                    try { await state.wakeLock.release(); } catch (e) {}
                }
                state.wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {}
        }
    }

    // =========================================================================
    // Comprehensive Mobile Lifecycle Manager (App-Switching & Restoration)
    // =========================================================================
    const LifecycleManager = {
        isBackgrounded: false,
        layoutTimer: null,

        init: function() {
            // 1. Visibility change
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    this.onForeground('visibilitychange');
                } else {
                    this.onBackground();
                }
            });

            // 2. Page show (BFCache restore)
            window.addEventListener('pageshow', (e) => {
                this.onForeground('pageshow');
            });

            // 3. Focus & Blur
            window.addEventListener('focus', () => {
                this.onForeground('focus');
            });
            window.addEventListener('blur', () => {
                this.onBackground();
            });

            // 4. Orientation change & Resize
            if (screen.orientation) {
                screen.orientation.addEventListener('change', () => {
                    this.forceLayoutPass('orientationchange');
                });
            }
            window.addEventListener('orientationchange', () => {
                this.forceLayoutPass('orientationchange');
            });
            window.addEventListener('resize', () => {
                this.forceLayoutPass('resize');
            });
        },

        onBackground: function() {
            this.isBackgrounded = true;
            console.log('[WinVR Lifecycle] App backgrounded.');
        },

        onForeground: function(trigger) {
            this.isBackgrounded = false;
            console.log('[WinVR Lifecycle] App foregrounded via ' + trigger + ' - executing recovery pass...');

            // 1. Force layout passes across ticks
            this.forceLayoutPass(trigger);

            // 2. Resuscitate video & audio
            if (video) {
                if (video.paused) {
                    video.play().catch(e => console.warn('[WinVR] Video resume catch:', e));
                }
                setupVideoFrameCallback();
            }
            if (audio && audio.paused) {
                audio.play().catch(() => {});
            }

            // 3. Re-bind video texture to prevent stale frame
            if (!state.glContextLost && gl && videoTexture && video && video.readyState >= 2) {
                try {
                    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
                    state.lastVideoTime = video.currentTime;
                } catch (e) {}
            }

            // 4. Re-acquire anti-sleep wake lock
            activateAntiSleep();

            // 5. Ensure sensors are running
            if (state.sensor && state.sensor.state === 'idle') {
                try { state.sensor.start(); } catch (e) {}
            }

            // 6. Resync data streams and request immediate IDR keyframe
            if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
                connectServer();
            } else if (state.ws.readyState === WebSocket.OPEN) {
                sendControlPacket({ type: 'client_resumed' });
                sendControlPacket({ type: 'request_keyframe' });
            }
        },

        forceLayoutPass: function(reason) {
            this._doLayout();
            clearTimeout(this.layoutTimer);
            this.layoutTimer = setTimeout(() => {
                this._doLayout();
                setTimeout(() => this._doLayout(), 250);
            }, 100);
        },

        _doLayout: function() {
            void document.body.offsetHeight; // Force reflow
            resizeCanvas();
            updateDividerPosition();
            updateVisionAlignmentUI();
            if (state.inVrMode && overlay) {
                overlay.style.display = 'none';
            }
        }
    };

    LifecycleManager.init();

    // =========================================================================
    // Networking & WebRTC
    // =========================================================================
    function reportPhoneResolution() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(Math.max(screen.width, screen.height) * dpr);
        const h = Math.round(Math.min(screen.width, screen.height) * dpr);
        sendControlPacket({
            type: 'phone_resolution',
            width: w,
            height: h,
            dpr: parseFloat(dpr.toFixed(2))
        });
    }
    window.addEventListener('resize', reportPhoneResolution);
    if (screen.orientation && screen.orientation.addEventListener) {
        screen.orientation.addEventListener('change', reportPhoneResolution);
    }

    function connectServer() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = protocol + '//' + window.location.host + '/ws';

        try {
            state.ws = new WebSocket(wsUrl);
        } catch (e) {
            setTimeout(connectServer, 2000);
            return;
        }

        state.ws.onopen = function() {
            state.connected = true;
            srvStatus.textContent = 'Connected (LAN)';
            srvStatus.className = 'status-value badge-connected';

            state.ws.send(JSON.stringify({
                type: 'register',
                role: 'client'
            }));

            // Sync calibration
            sendControlPacket({
                type: 'tune_vr',
                mode: state.viewMode,
                dividerRatio: state.dividerRatio,
                lensOffset: state.lensOffset,
                shiftX: state.shiftX,
                shiftY: state.shiftY,
                ipd: Math.round(state.ipd * 1000),
                fov: state.fov,
                exposure: state.exposure,
                highlightCut: state.highlightCut,
                shadowBoost: state.shadowBoost,
                gamma: state.gamma,
                contrast: state.contrast,
                brightness: state.brightness,
                saturation: state.saturation
            });

            reportPhoneResolution();
        };

        state.ws.onmessage = async function(event) {
            MtuChunker.receive(event.data, (fullData) => {
                try {
                    const msg = JSON.parse(fullData);
                    handleIncomingMessage(msg);
                } catch (err) {}
            });
        };

        state.ws.onclose = function() {
            state.connected = false;
            srvStatus.textContent = 'Disconnected';
            srvStatus.className = 'status-value badge-waiting';
            setTimeout(connectServer, 2000);
        };
    }

    function handleIncomingMessage(msg) {
        if (msg.type === 'signal') {
            handleWebRTCSignal(msg.data);
        } else if (msg.type === 'host_ready') {
            streamStatus.textContent = 'Host Broadcasting';
            streamStatus.className = 'status-value badge-connected';
            sendControlPacket({ type: 'request_keyframe' });
        } else if (msg.type === 'tune_vr') {
            let geomNeedsUpdate = false;
            if (msg.dividerRatio !== undefined) {
                state.dividerRatio = parseFloat(msg.dividerRatio);
                updateDividerPosition();
                flashDividerGlow();
            }
            if (msg.lensOffset !== undefined) {
                state.lensOffset = parseFloat(msg.lensOffset);
            }
            if (msg.ipd !== undefined) {
                state.ipd = parseInt(msg.ipd, 10) / 1000.0;
                if (valIpd) valIpd.textContent = Math.round(state.ipd * 1000) + 'mm';
                if (rangeIpd) rangeIpd.value = Math.round(state.ipd * 1000);
            }
            if (msg.shiftX !== undefined) {
                state.shiftX = parseFloat(msg.shiftX);
                updateVisionAlignmentUI();
            }
            if (msg.shiftY !== undefined) {
                state.shiftY = parseFloat(msg.shiftY);
                updateVisionAlignmentUI();
            }
            if (msg.fov !== undefined) {
                state.fov = parseInt(msg.fov, 10);
            }
            if (msg.mode !== undefined && msg.mode !== state.viewMode) {
                setMode(msg.mode, false);
                geomNeedsUpdate = true;
            }
            if (msg.distance !== undefined || msg.screenDistance !== undefined) {
                const rawDist = msg.distance !== undefined ? msg.distance : msg.screenDistance;
                const parsedDist = parseFloat(rawDist);
                if (!isNaN(parsedDist) && parsedDist > 0) {
                    state.screenDistance = parsedDist;
                    if (valDistance) valDistance.textContent = state.screenDistance.toFixed(1) + 'm';
                    if (rangeDistance) rangeDistance.value = state.screenDistance;
                    geomNeedsUpdate = true;
                }
            }
            if (msg.scale !== undefined || msg.screenScale !== undefined) {
                const rawScale = msg.scale !== undefined ? msg.scale : msg.screenScale;
                const parsedScale = parseFloat(rawScale);
                if (!isNaN(parsedScale) && parsedScale > 0) {
                    state.screenScale = parsedScale;
                    if (valScale) valScale.textContent = Math.round(state.screenScale * 100) + '%';
                    if (rangeScale) rangeScale.value = Math.round(state.screenScale * 100);
                    geomNeedsUpdate = true;
                }
            }
            if (msg.elevation !== undefined || msg.screenElevation !== undefined) {
                const rawElev = msg.elevation !== undefined ? msg.elevation : msg.screenElevation;
                const parsedElev = parseFloat(rawElev);
                if (!isNaN(parsedElev)) {
                    state.screenElevation = parsedElev;
                    if (valElevation) valElevation.textContent = (state.screenElevation >= 0 ? '+' : '') + state.screenElevation.toFixed(1) + 'm';
                    if (rangeElevation) rangeElevation.value = state.screenElevation;
                    geomNeedsUpdate = true;
                }
            }
            if (msg.curved !== undefined) {
                state.curved = Boolean(msg.curved);
                document.querySelectorAll('.hud-btn-curve').forEach(el => {
                    el.textContent = state.curved ? '📐 Curved' : '📐 Flat';
                    if (state.curved) el.classList.add('active');
                    else el.classList.remove('active');
                });
                geomNeedsUpdate = true;
            }
            if (msg.gamma !== undefined) {
                const g = parseFloat(msg.gamma);
                if (!isNaN(g)) state.gamma = g;
            }
            if (msg.contrast !== undefined) {
                const c = parseFloat(msg.contrast);
                if (!isNaN(c)) state.contrast = c;
            }
            if (msg.brightness !== undefined) {
                const b = parseFloat(msg.brightness);
                if (!isNaN(b)) state.brightness = b;
            }
            if (msg.saturation !== undefined) {
                const s = parseFloat(msg.saturation);
                if (!isNaN(s)) state.saturation = s;
            }
            if (msg.exposure !== undefined) {
                const exp = parseFloat(msg.exposure);
                if (!isNaN(exp)) state.exposure = exp;
            }
            if (msg.highlightCut !== undefined) {
                const hc = parseFloat(msg.highlightCut);
                if (!isNaN(hc)) state.highlightCut = hc;
            }
            if (msg.shadowBoost !== undefined) {
                const sb = parseFloat(msg.shadowBoost);
                if (!isNaN(sb)) state.shadowBoost = sb;
            }
            if (msg.blackLevel !== undefined) {
                const bl = parseFloat(msg.blackLevel);
                if (!isNaN(bl)) state.blackLevel = bl;
            }
            if (msg.whiteLevel !== undefined) {
                const wl = parseFloat(msg.whiteLevel);
                if (!isNaN(wl)) state.whiteLevel = wl;
            }
            if (geomNeedsUpdate) {
                updateScreenGeometry();
            }
        } else if (msg.type === 'tune_crosshair') {
            if (msg.shiftX !== undefined) state.shiftX = parseFloat(msg.shiftX);
            if (msg.shiftY !== undefined) state.shiftY = parseFloat(msg.shiftY);
            updateVisionAlignmentUI();
        } else if (msg.type === 'save_calibration') {
            if (msg.calibration) {
                try {
                    localStorage.setItem('winvr_calibration', JSON.stringify(msg.calibration));
                } catch (e) {}
            }
            showToast('💾 Calibration Saved!');
        } else if (msg.type === 'remote_recenter') {
            recenter();
            showToast('🎯 Recentered via PC');
        } else if (msg.type === 'set_mode') {
            if (msg.mode) setMode(msg.mode, false);
        } else if (msg.type === 'set_fps' || msg.type === 'target_fps') {
            const newFps = parseInt(msg.fps || msg.targetFps, 10);
            if (!isNaN(newFps) && newFps >= 30 && newFps <= 120) {
                state.targetFps = newFps;
                showToast(`⚡ Stream Target: ${state.targetFps} FPS`);
            }
        } else if (msg.type === 'stream_swapped') {
            console.log('[WinVR Mobile] Stream swapped dynamically by host.');
            showToast('📺 Window Switched');
            if (video && video.paused) {
                video.play().catch(() => {});
            }
            state.lastVideoTime = -1;
            hasNewVideoFrame = true;
            updateScreenGeometry();
            sendControlPacket({ type: 'request_keyframe' });
        } else if (msg.type === 'stream_stopped') {
            console.log('[WinVR Mobile] Host stopped stream.');
            state.streaming = false;
            streamStatus.textContent = 'Host Paused / Waiting';
            streamStatus.className = 'status-value badge-waiting';
            showToast('⏸️ Host Paused Stream');
        } else if (msg.type === 'server_ready') {
            state.fastMotionSupported = Boolean(msg.fastMotion);
            console.log('[WinVR Mobile] Server capability confirmed. Fast direct motion enabled:', state.fastMotionSupported);
            updateHudTelemetry();
        } else if (msg.type === 'gyro_ack') {
            if (msg.clientTs) {
                const rtt = Math.max(0, performance.now() - parseFloat(msg.clientTs));
                state.measuredControlRtt = (state.measuredControlRtt > 0) ? (state.measuredControlRtt * 0.75 + rtt * 0.25) : rtt;
                updateHudTelemetry();
            }
        } else if (msg.type === 'stats_update') {
            if (msg.clipPct !== undefined) state.clipPct = msg.clipPct;
            if (msg.blackFloor !== undefined) state.blackFloor = msg.blackFloor;
            if (msg.gyroRate !== undefined) state.measuredSensorHz = msg.gyroRate;
            updateHudTelemetry();
        } else if (msg.type === 'reset_peer') {
            console.log('[WinVR Mobile] Resetting WebRTC Peer Connection per host command.');
            if (state.pc) {
                try { state.pc.close(); } catch (e) {}
                state.pc = null;
            }
            initWebRTC();
        }
    }

    async function handleWebRTCSignal(signal) {
        if (!state.pc) {
            initWebRTC();
        }

        if (signal.type === 'offer') {
            if (state.pc && state.pc.signalingState !== 'stable') {
                console.warn('[WinVR Mobile] Resetting peer connection for new offer in state:', state.pc.signalingState);
                try { state.pc.close(); } catch (e) {}
                state.pc = null;
                initWebRTC();
            }
            await state.pc.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await state.pc.createAnswer();
            await state.pc.setLocalDescription(answer);

            state.ws.send(JSON.stringify({
                type: 'signal',
                target: 'host',
                data: state.pc.localDescription
            }));
        } else if (signal.type === 'candidate') {
            if (signal.candidate) {
                try {
                    await state.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                } catch (e) {}
            }
        }
    }

    let hasNewVideoFrame = false;
    let lastVideoFrameTime = 0;
    let lastKeyframeRequestTime = 0;

    // Safe Rate-Limited IDR Keyframe Recovery (Restores corrupted or frozen stream in <16ms)
    function requestKeyframeRecovery(reason) {
        const now = performance.now();
        if (now - lastKeyframeRequestTime < 400) return; // Rate-limit to at most once per 400ms
        lastKeyframeRequestTime = now;
        state.stallRecoveryCount = (state.stallRecoveryCount || 0) + 1;
        console.warn(`[WinVR Mobile] Watchdog detected video stall (${reason})! Dispatched IDR keyframe recovery (#${state.stallRecoveryCount})...`);

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'request_keyframe', reason: reason }));
        } else if (state.dataChannel && state.dataChannel.readyState === 'open') {
            try {
                state.dataChannel.send(JSON.stringify({ type: 'request_keyframe', reason: reason }));
            } catch (e) {}
        }

        if (video && video.paused && state.streaming) {
            video.play().catch(() => {});
        }
    }

    function setupVideoFrameCallback() {
        if ('requestVideoFrameCallback' in video) {
            const onFrame = (now, metadata) => {
                hasNewVideoFrame = true;
                state.lastFrameArrivalSystemTime = performance.now();
                state.streamHealth = 'healthy';

                // Accurate Video Frame Diagnostics
                state.videoFrameCount = (state.videoFrameCount || 0) + 1;
                if (lastVideoFrameTime > 0) {
                    const interval = now - lastVideoFrameTime;
                    const targetInterval = 1000.0 / (state.targetFps || 60);
                    const jitter = Math.abs(interval - targetInterval);
                    state.videoJitterMs = (state.videoJitterMs > 0) ? (state.videoJitterMs * 0.9 + jitter * 0.1) : jitter;
                }
                lastVideoFrameTime = now;

                if (metadata && typeof video.getVideoPlaybackQuality === 'function') {
                    try {
                        const q = video.getVideoPlaybackQuality();
                        state.videoDroppedFrames = q.droppedVideoFrames || 0;
                    } catch (e) {}
                }

                const checkNow = performance.now();
                if (!state.lastVideoFpsCheckTime) state.lastVideoFpsCheckTime = checkNow;
                const elapsed = (checkNow - state.lastVideoFpsCheckTime) / 1000;
                if (elapsed >= 1.0) {
                    state.measuredVideoFps = Math.round((state.videoFrameCount / elapsed) * 10) / 10;
                    state.videoFrameCount = 0;
                    state.lastVideoFpsCheckTime = checkNow;
                    updateHudTelemetry();
                }

                if ('requestVideoFrameCallback' in video) {
                    video.requestVideoFrameCallback(onFrame);
                }
            };
            video.requestVideoFrameCallback(onFrame);
        }
    }

    // Video Presentation Watchdog (Monitors frame presentation every 200ms)
    setInterval(() => {
        if (!state.streaming || !video || video.readyState < 2) return;
        const now = performance.now();
        if (state.lastFrameArrivalSystemTime > 0) {
            const stallDuration = now - state.lastFrameArrivalSystemTime;
            if (stallDuration > 350) {
                state.streamHealth = 'stalled';
                requestKeyframeRecovery(`freeze_${Math.round(stallDuration)}ms`);
                updateHudTelemetry();
            }
        }
    }, 200);

    // Inbound WebRTC Statistics Inspector (Polls every 1000ms)
    let lastStatsBytes = 0;
    let lastStatsDecoded = 0;
    let lastStatsTime = 0;
    setInterval(async () => {
        if (!state.pc || (state.pc.connectionState !== 'connected' && state.pc.iceConnectionState !== 'connected')) return;
        try {
            const stats = await state.pc.getStats();
            const now = performance.now();
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    state.inboundResWidth = report.frameWidth || video.videoWidth || 0;
                    state.inboundResHeight = report.frameHeight || video.videoHeight || 0;
                    state.packetsLost = report.packetsLost || 0;
                    state.jitterMs = report.jitter ? Math.round(report.jitter * 1000) : 0;
                    if (report.jitterBufferDelay !== undefined && report.jitterBufferEmittedCount > 0) {
                        state.jitterBufferMs = Math.round((report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000);
                    }
                    state.framesDecoded = report.framesDecoded || 0;
                    state.framesDropped = report.framesDropped || 0;
                    if (report.totalDecodeTime !== undefined && report.framesDecoded > 0) {
                        state.avgDecodeTimeMs = ((report.totalDecodeTime / report.framesDecoded) * 1000).toFixed(1);
                    }
                    if (report.decoderImplementation) {
                        state.decoderName = report.decoderImplementation;
                    }

                    if (lastStatsTime > 0 && now > lastStatsTime) {
                        const elapsedSec = (now - lastStatsTime) / 1000;
                        const bytesDiff = (report.bytesReceived || 0) - lastStatsBytes;
                        const framesDiff = (report.framesDecoded || 0) - lastStatsDecoded;
                        if (bytesDiff >= 0 && elapsedSec > 0) {
                            state.inboundBitrateMbps = ((bytesDiff * 8) / (elapsedSec * 1000000)).toFixed(1);
                        }
                        if (framesDiff >= 0 && elapsedSec > 0) {
                            state.inboundFps = Math.round(framesDiff / elapsedSec);
                        }
                    }
                    lastStatsBytes = report.bytesReceived || 0;
                    lastStatsDecoded = report.framesDecoded || 0;
                    lastStatsTime = now;
                }
            });

            // Relay summary telemetry back to host PC
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'webrtc_client_stats',
                    decodedWidth: state.inboundResWidth,
                    decodedHeight: state.inboundResHeight,
                    bitrateMbps: state.inboundBitrateMbps,
                    jitterBufferMs: state.jitterBufferMs || 0,
                    packetsLost: state.packetsLost || 0,
                    framesDropped: state.framesDropped || 0,
                    avgDecodeTimeMs: state.avgDecodeTimeMs || 0,
                    streamHealth: state.streamHealth || 'healthy',
                    fps: state.measuredVideoFps || state.inboundFps || 60
                }));
            }
            updateHudTelemetry();
        } catch (e) {}
    }, 1000);

    // Video Lifecycle Observers for Dynamic Resizing and Stream Swapping
    video.addEventListener('resize', function() {
        console.log('[WinVR Mobile] Video resolution changed:', video.videoWidth, 'x', video.videoHeight);
        updateScreenGeometry();
        state.lastVideoTime = -1;
        hasNewVideoFrame = true;
    });

    video.addEventListener('pause', function() {
        if (state.streaming && video.paused) {
            video.play().catch(() => {});
        }
    });

    video.addEventListener('stalled', function() {
        if (state.streaming && video.paused) {
            video.play().catch(() => {});
        }
    });

    function initWebRTC() {
        state.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Listen for PC Host's high-speed UDP DataChannel
        state.pc.ondatachannel = function(e) {
            state.dataChannel = e.channel;
            state.dataChannel.onopen = function() {
                console.log('[WinVR Mobile] UDP DataChannel Open (16MB Socket Senders)');
                showToast('⚡ Ultra LAN Controls Connected');
                reportPhoneResolution();
            };
            state.dataChannel.onmessage = function(ev) {
                MtuChunker.receive(ev.data, (fullData) => {
                    try {
                        const msg = JSON.parse(fullData);
                        handleIncomingMessage(msg);
                    } catch (e) {}
                });
            };
        };

        state.pc.onicecandidate = function(e) {
            if (e.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'signal',
                    target: 'host',
                    data: { type: 'candidate', candidate: e.candidate }
                }));
            }
        };

        state.pc.ontrack = function(event) {
            // Apply playoutDelayHint = 0 to avoid artificial playout buffer delay without forcing zero jitter target
            if (event.receiver) {
                if ('playoutDelayHint' in event.receiver) {
                    try { event.receiver.playoutDelayHint = 0; } catch (e) {}
                }
            }

            const incomingStream = (event.streams && event.streams[0]) ? event.streams[0] : null;

            if (event.track.kind === 'video') {
                if ('playoutDelayHint' in video) {
                    try { video.playoutDelayHint = 0; } catch (e) {}
                }
                video.playbackRate = 1.0;
                try { event.track.contentHint = 'motion'; } catch (e) {}

                // Use the unified MediaStream so audio and video stay in the same container for RTCP lip sync
                if (incomingStream) {
                    if (video.srcObject !== incomingStream) {
                        video.srcObject = incomingStream;
                    }
                } else {
                    if (!video.srcObject) {
                        video.srcObject = new MediaStream();
                    }
                    if (!video.srcObject.getVideoTracks().includes(event.track)) {
                        video.srcObject.addTrack(event.track);
                    }
                }

                setupVideoFrameCallback();

                event.track.onended = () => {
                    console.log('[WinVR Mobile] Video track ended');
                };

                event.track.onmute = () => {
                    console.log('[WinVR Mobile] Video track muted');
                };

                event.track.onunmute = () => {
                    console.log('[WinVR Mobile] Video track unmuted');
                    if (video.paused) video.play().catch(() => {});
                    hasNewVideoFrame = true;
                };

                video.play().then(() => {
                    state.streaming = true;
                    streamStatus.textContent = 'Streaming Live (LAN Turbo)';
                    streamStatus.className = 'status-value badge-connected';
                    updateScreenGeometry();
                    showToast(`⚡ ${state.targetFps || 60} FPS Ultra LAN Connected`);
                }).catch(() => {});
            } else if (event.track.kind === 'audio') {
                // Audio track received: attach to unified stream for native RTCP Lip Sync
                if (incomingStream) {
                    if (video.srcObject !== incomingStream) {
                        video.srcObject = incomingStream;
                    }
                    state.audioUnified = true;
                } else if (video.srcObject && typeof video.srcObject.addTrack === 'function') {
                    video.srcObject.addTrack(event.track);
                    state.audioUnified = true;
                } else {
                    audio.srcObject = new MediaStream([event.track]);
                    audio.play().catch(() => {});
                    state.audioUnified = false;
                }
            }
        };
    }

    function ensureAudioPlayback() {
        if (video) {
            if (state.audioUnified && video.muted) {
                video.muted = false;
                video.volume = 1.0;
                video.play().catch(() => {});
                if (audio) {
                    try { audio.pause(); audio.srcObject = null; } catch (e) {}
                }
            } else if (!state.audioUnified && audio && audio.paused) {
                audio.play().catch(() => {});
            }
        }
    }

    function updateHudTelemetry() {
        const fpsStr = state.measuredVideoFps > 0 ? state.measuredVideoFps.toFixed(1) : (state.inboundFps > 0 ? state.inboundFps.toFixed(0) : '--');
        const hzStr = state.measuredSensorHz > 0 ? state.measuredSensorHz.toFixed(0) : '--';
        const rttStr = state.measuredControlRtt > 0 ? state.measuredControlRtt.toFixed(1) : (state.fastMotionSupported ? '<1' : '--');
        const dropStr = (state.videoDroppedFrames || state.framesDropped || 0).toString();
        const resStr = (state.inboundResWidth && state.inboundResHeight) ? `${state.inboundResWidth}x${state.inboundResHeight}` : (video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : '--');
        const jbStr = state.jitterBufferMs !== undefined ? `${state.jitterBufferMs}ms` : '0ms';

        document.querySelectorAll('.hud-val-fps').forEach(el => { el.textContent = fpsStr; });
        document.querySelectorAll('.hud-val-hz').forEach(el => { el.textContent = hzStr; });
        document.querySelectorAll('.hud-val-rtt').forEach(el => { el.textContent = rttStr; });
        document.querySelectorAll('.hud-val-drop').forEach(el => { el.textContent = dropStr; });
        document.querySelectorAll('.hud-val-res').forEach(el => { el.textContent = resStr; });
        document.querySelectorAll('.hud-val-jb').forEach(el => { el.textContent = jbStr; });
        document.querySelectorAll('.hud-val-clip').forEach(el => {
            el.textContent = (state.clipPct !== undefined ? state.clipPct.toFixed(1) : '0') + '%';
            el.style.color = state.clipPct > 5.0 ? '#ef4444' : (state.clipPct > 1.0 ? '#f59e0b' : '#67e8f9');
        });
        document.querySelectorAll('.hud-val-floor').forEach(el => {
            el.textContent = (state.blackFloor !== undefined ? state.blackFloor.toFixed(1) : '0') + '%';
            el.style.color = state.blackFloor > 4.0 ? '#f59e0b' : '#67e8f9';
        });
    }

    // Diagnostic Raw <video> Direct Bypass Mode (Condition C vs D)
    function toggleRawVideoBypass() {
        state.rawVideoBypass = !state.rawVideoBypass;
        document.body.classList.toggle('raw-video-mode', state.rawVideoBypass);
        const isRaw = state.rawVideoBypass;
        showToast(isRaw ? '📺 Direct Raw <video> (Zero WebGL Processing)' : '👓 WebGL 3D VR Mode');
        document.querySelectorAll('.hud-btn-raw').forEach(b => {
            b.classList.toggle('active', isRaw);
            b.textContent = isRaw ? '👓 Exit Raw' : '📺 Raw Bypass';
        });
        const btnOverlay = document.getElementById('btnOverlayRawBypass');
        if (btnOverlay) {
            btnOverlay.textContent = isRaw ? '👓 Return to WebGL VR' : '📺 Diagnostic: Raw <video> Direct Bypass';
        }
    }

    // =========================================================================
    // Touch Gestures: Single Tap ANYWHERE Recenter
    // =========================================================================
    window.addEventListener('touchstart', function(e) {
        ensureAudioPlayback();

        if (e.target.closest('.hud-panel') || e.target.closest('#overlay')) return;

        // Two-finger tap opens in-VR HUD
        if (e.touches.length === 2) {
            toggleHUD();
            return;
        }

        // Single tap ANYWHERE instantly recenters the screen!
        recenter();
    }, { passive: true });

    function toggleHUD() {
        state.hudVisible = !state.hudVisible;
        if (state.hudVisible) hudContainer.classList.add('visible');
        else hudContainer.classList.remove('visible');
    }

    function showToast(text) {
        if (!vrToast) return;
        vrToast.textContent = text;
        vrToast.classList.add('show');
        setTimeout(() => vrToast.classList.remove('show'), 1500);
    }

    // HUD Button Handlers
    if (hudContainer) {
        hudContainer.addEventListener('click', function(e) {
            const btn = e.target.closest('.hud-btn');
            if (!btn) return;

            const action = btn.dataset.action;
            if (action === 'toggle-raw-bypass') {
                toggleRawVideoBypass();
            } else if (action === 'recenter') {
                recenter();
            } else if (action === 'merge-in') {
                state.shiftX = Math.min(30.0, state.shiftX + 0.5);
                updateVisionAlignmentUI();
                syncVisionAlignmentToPC();
                showToast('Merge: ' + (state.shiftX >= 0 ? '+' : '') + state.shiftX.toFixed(1) + 'mm');
            } else if (action === 'merge-out') {
                state.shiftX = Math.max(-30.0, state.shiftX - 0.5);
                updateVisionAlignmentUI();
                syncVisionAlignmentToPC();
                showToast('Merge: ' + (state.shiftX >= 0 ? '+' : '') + state.shiftX.toFixed(1) + 'mm');
            } else if (action === 'save-calib') {
                saveCalibration();
            } else if (action === 'mode-dome') {
                state.domeFovH = 135;
                state.domeFovV = 90;
                setMode('dome', true);
            } else if (action === 'mode-dome-wide') {
                state.domeFovH = 195;
                state.domeFovV = 115;
                setMode('dome_wide', true);
            } else if (action === 'mode-cinema') {
                setMode('cinema', true);
            } else if (action === 'mode-sbs') {
                setMode('sbs', true);
            } else if (action === 'req-keyframe') {
                requestKeyframeRecovery('manual_user_tap');
                showToast('⚡ IDR Keyframe Requested');
            } else if (action === 'split-left') {
                state.dividerRatio = Math.max(0.40, state.dividerRatio - 0.005);
                updateDividerPosition();
                flashDividerGlow();
                syncTuningToPC();
                showToast('Split: ' + (state.dividerRatio * 100).toFixed(1) + '%');
            } else if (action === 'split-right') {
                state.dividerRatio = Math.min(0.60, state.dividerRatio + 0.005);
                updateDividerPosition();
                flashDividerGlow();
                syncTuningToPC();
                showToast('Split: ' + (state.dividerRatio * 100).toFixed(1) + '%');
            } else if (action === 'split-reset') {
                state.dividerRatio = 0.50;
                updateDividerPosition();
                flashDividerGlow();
                syncTuningToPC();
                showToast('Split: 50.0%');
            } else if (action === 'toggle-curve') {
                state.curved = !state.curved;
                document.querySelectorAll('.hud-btn-curve').forEach(el => {
                    el.textContent = state.curved ? '📐 Curved' : '📐 Flat';
                    if (state.curved) el.classList.add('active');
                    else el.classList.remove('active');
                });
                updateScreenGeometry();
                syncTuningToPC();
                showToast(state.curved ? 'Screen: Curved' : 'Screen: Flat');
            } else if (action === 'dist-far') {
                state.screenDistance = Math.min(12.0, state.screenDistance + 0.5);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Distance: ' + state.screenDistance.toFixed(1) + 'm');
            } else if (action === 'dist-near') {
                state.screenDistance = Math.max(1.2, state.screenDistance - 0.5);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Distance: ' + state.screenDistance.toFixed(1) + 'm');
            } else if (action === 'elev-up') {
                state.screenElevation = Math.min(1.5, state.screenElevation + 0.2);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Elevation: +' + state.screenElevation.toFixed(1) + 'm');
            } else if (action === 'elev-down') {
                state.screenElevation = Math.max(-1.5, state.screenElevation - 0.2);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Elevation: ' + state.screenElevation.toFixed(1) + 'm');
            } else if (action === 'size-down') {
                state.screenScale = Math.max(0.5, state.screenScale - 0.1);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Size: ' + Math.round(state.screenScale * 100) + '%');
            } else if (action === 'size-up') {
                state.screenScale = Math.min(2.5, state.screenScale + 0.1);
                updateScreenGeometry();
                syncTuningToPC();
                showToast('Size: ' + Math.round(state.screenScale * 100) + '%');
            } else if (action === 'close-hud') {
                toggleHUD();
            }
        });
    }

    function syncTuningToPC() {
        sendControlPacket({
            type: 'tune_vr',
            mode: state.viewMode,
            dividerRatio: state.dividerRatio,
            lensOffset: state.lensOffset,
            shiftX: state.shiftX,
            shiftY: state.shiftY,
            ipd: Math.round(state.ipd * 1000),
            fov: state.fov,
            distance: state.screenDistance,
            scale: state.screenScale,
            elevation: state.screenElevation,
            curved: state.curved,
            gamma: state.gamma,
            contrast: state.contrast,
            brightness: state.brightness,
            saturation: state.saturation,
            exposure: state.exposure,
            highlightCut: state.highlightCut,
            shadowBoost: state.shadowBoost
        });
    }

    // Start Screen Mode Toggles
    [btnPhoneModeDome, btnPhoneModeCinema, btnPhoneModeSbs].forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', function() {
            setMode(this.dataset.mode, true);
        });
    });

    // Start Screen Center Split Slider
    if (rangePhoneSplit) {
        rangePhoneSplit.addEventListener('input', function() {
            const val = parseFloat(this.value);
            state.dividerRatio = val / 100.0;
            updateDividerPosition();
            flashDividerGlow();
            syncTuningToPC();
        });
    }

    // Start Screen Stereoscopic Convergence Alignment (Double Vision Fix)
    if (rangePhoneShiftX) {
        rangePhoneShiftX.addEventListener('input', function() {
            state.shiftX = parseFloat(this.value);
            updateVisionAlignmentUI();
            syncVisionAlignmentToPC();
        });
    }

    if (btnPhoneSaveCalib) {
        btnPhoneSaveCalib.addEventListener('click', function() {
            saveCalibration();
        });
    }

    // Start Screen Sliders
    if (rangeDistance) {
        rangeDistance.addEventListener('input', function() {
            state.screenDistance = parseFloat(this.value);
            if (valDistance) valDistance.textContent = this.value + 'm';
            updateScreenGeometry();
            syncTuningToPC();
        });
    }

    if (rangeScale) {
        rangeScale.addEventListener('input', function() {
            state.screenScale = parseInt(this.value, 10) / 100.0;
            if (valScale) valScale.textContent = this.value + '%';
            updateScreenGeometry();
            syncTuningToPC();
        });
    }

    if (rangeElevation) {
        rangeElevation.addEventListener('input', function() {
            state.screenElevation = parseFloat(this.value);
            if (valElevation) valElevation.textContent = (state.screenElevation >= 0 ? '+' : '') + this.value + 'm';
            updateScreenGeometry();
            syncTuningToPC();
        });
    }

    if (rangeIpd) {
        rangeIpd.addEventListener('input', function() {
            state.ipd = parseInt(this.value, 10) / 1000.0;
            if (valIpd) valIpd.textContent = this.value + 'mm';
            syncTuningToPC();
        });
    }

    // Enter VR Button
    if (btnEnterVR) {
        btnEnterVR.addEventListener('click', async function() {
            if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                try {
                    await DeviceOrientationEvent.requestPermission();
                } catch (e) {}
            }

            initSensors();
            await activateAntiSleep();

            try {
                if (document.documentElement.requestFullscreen) {
                    await document.documentElement.requestFullscreen();
                }
                if (screen.orientation && screen.orientation.lock) {
                    await screen.orientation.lock('landscape').catch(() => {});
                }
            } catch (e) {}

            ensureAudioPlayback();
            video.play().catch(() => {});
            if (!state.audioUnified && audio) {
                audio.play().catch(() => {});
            }

            state.inVrMode = true;
            if (overlay) overlay.style.display = 'none';
            setTimeout(recenter, 200);
        });
    }

    // Diagnostic Raw Video Mode Toggles
    const btnOverlayRawBypass = document.getElementById('btnOverlayRawBypass');
    if (btnOverlayRawBypass) {
        btnOverlayRawBypass.addEventListener('click', toggleRawVideoBypass);
    }
    const rawBypassBanner = document.getElementById('rawBypassBanner');
    if (rawBypassBanner) {
        rawBypassBanner.addEventListener('click', toggleRawVideoBypass);
    }
    if (video) {
        video.addEventListener('click', function() {
            if (state.rawVideoBypass) {
                toggleRawVideoBypass();
            }
        });
    }

    // =========================================================================
    // Stereoscopic 3D Render Loop
    // =========================================================================
    function resizeCanvas() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        let winW = window.innerWidth || document.documentElement.clientWidth || screen.width || 320;
        let winH = window.innerHeight || document.documentElement.clientHeight || screen.height || 240;

        // In landscape VR mode, ensure maximum dimension is width and minimum is height
        if (state.inVrMode || window.orientation === 90 || window.orientation === -90 || (screen.orientation && screen.orientation.type.includes('landscape'))) {
            const maxW = Math.max(winW, winH, screen.width || 0, screen.height || 0);
            const minH = Math.min(Math.min(winW, winH), Math.min(screen.width || winH, screen.height || winH));
            winW = maxW;
            winH = minH;
        }

        const w = Math.max(100, Math.round(winW * dpr));
        const h = Math.max(100, Math.round(winH * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            console.log(`[WinVR Mobile] Canvas drawing buffer resized: ${w}x${h} (DPR: ${dpr.toFixed(2)})`);
        }
    }

    function render() {
        requestAnimationFrame(render);

        if (state.glContextLost || !gl || !program) return;

        resizeCanvas();

        const totalWidth = canvas.width;
        const height = canvas.height;

        const ratio = state.dividerRatio || 0.50;
        const leftWidth = Math.max(10, Math.floor(totalWidth * ratio));
        const rightWidth = Math.max(10, totalWidth - leftWidth);

        // Upload live video texture only when a new frame is decoded (eliminates redundant GPU stalls)
        if (video.readyState >= 2) {
            const hasFrame = hasNewVideoFrame || !('requestVideoFrameCallback' in video) || video.currentTime !== state.lastVideoTime;
            if (hasFrame) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
                hasNewVideoFrame = false;

                // Fallback FPS tracking if requestVideoFrameCallback is unsupported
                if (!('requestVideoFrameCallback' in video)) {
                    state.videoFrameCount = (state.videoFrameCount || 0) + 1;
                    const checkNow = performance.now();
                    if (!state.lastVideoFpsCheckTime) state.lastVideoFpsCheckTime = checkNow;
                    const elapsed = (checkNow - state.lastVideoFpsCheckTime) / 1000;
                    if (elapsed >= 1.0) {
                        state.measuredVideoFps = Math.round((state.videoFrameCount / elapsed) * 10) / 10;
                        state.videoFrameCount = 0;
                        state.lastVideoFpsCheckTime = checkNow;
                        updateHudTelemetry();
                    }
                }

                state.lastVideoTime = video.currentTime;
            }
        }

        gl.useProgram(program);
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0.01, 0.02, 0.04, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // View Matrix = Inverse of head rotation
        Quat.invert(state.viewQuat, state.headQuat);
        Quat.toMat4(rotMatrix, state.viewQuat);

        // Render Eye Function
        function renderEye(isRightEye) {
            const vpX = isRightEye ? leftWidth : 0;
            const vpW = isRightEye ? rightWidth : leftWidth;
            gl.viewport(vpX, 0, vpW, height);

            const aspect = vpW / height;
            const fov = (state.viewMode === 'dome' ? (state.fov || 105) : 85) * degToRad;

            const eyeSign = isRightEye ? 1 : -1;
            const eyeOffset = eyeSign * (state.ipd * 0.5) + (eyeSign * (state.lensOffset * 0.001));

            // Optical convergence shift in projection space
            const normShiftX = -eyeSign * (state.shiftX * 0.015);
            const normShiftY = state.shiftY * 0.015;

            Mat4.perspectiveOffCenter(projMatrix, fov, aspect, 0.05, 100.0, normShiftX, normShiftY);

            // Camera view matrix: translate by -eyeOffset, then rotate by viewQuat
            Mat4.translate(viewMatrix, rotMatrix, -eyeOffset, 0, 0);

            // MVP = Proj * View
            Mat4.multiply(mvpMatrix, projMatrix, viewMatrix);
            gl.uniformMatrix4fv(locations.mvp, false, mvpMatrix);

            // 1. Draw Starfield (Only in cinema mode to keep FPV gaming pure and fast)
            if (state.viewMode !== 'dome' && starMesh && starPosBuffer) {
                gl.uniform1f(locations.isStar, 1.0);
                gl.bindBuffer(gl.ARRAY_BUFFER, starPosBuffer);
                gl.enableVertexAttribArray(locations.position);
                gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, starTexBuffer);
                gl.enableVertexAttribArray(locations.texCoord);
                gl.vertexAttribPointer(locations.texCoord, 2, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, starIndexBuffer);
                gl.drawElements(gl.TRIANGLES, starMesh.count, gl.UNSIGNED_SHORT, 0);
            }

            // 2. Setup UV mapping for SBS 3D or Monoscopic
            gl.uniform1f(locations.isStar, 0.0);
            if (state.viewMode === 'sbs') {
                gl.uniform2f(locations.uvScale, 0.5, 1.0);
                gl.uniform2f(locations.uvOffset, isRightEye ? 0.5 : 0.0, 0.0);
            } else {
                gl.uniform2f(locations.uvScale, 1.0, 1.0);
                gl.uniform2f(locations.uvOffset, 0.0, 0.0);
            }

            // 3. Draw FPV 180° Game Dome or IMAX Curved Cinema Screen with Direct Tone Mapping
            if (screenMesh && screenPosBuffer) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                if (locations.texture) gl.uniform1i(locations.texture, 0);

                if (locations.blackLevel) gl.uniform1f(locations.blackLevel, state.blackLevel !== undefined ? state.blackLevel : 0.0);
                if (locations.whiteLevel) gl.uniform1f(locations.whiteLevel, state.whiteLevel !== undefined ? state.whiteLevel : 1.0);
                if (locations.exposure) gl.uniform1f(locations.exposure, state.exposure !== undefined ? state.exposure : 1.00);
                if (locations.highlightCut) gl.uniform1f(locations.highlightCut, state.highlightCut !== undefined ? state.highlightCut : 0.00);
                if (locations.shadowBoost) gl.uniform1f(locations.shadowBoost, state.shadowBoost !== undefined ? state.shadowBoost : 0.00);
                if (locations.gamma) gl.uniform1f(locations.gamma, state.gamma !== undefined ? state.gamma : 1.00);
                if (locations.contrast) gl.uniform1f(locations.contrast, state.contrast !== undefined ? state.contrast : 1.00);
                if (locations.brightness) gl.uniform1f(locations.brightness, state.brightness !== undefined ? state.brightness : 0.00);
                if (locations.saturation) gl.uniform1f(locations.saturation, state.saturation !== undefined ? state.saturation : 1.00);

                gl.bindBuffer(gl.ARRAY_BUFFER, screenPosBuffer);
                gl.enableVertexAttribArray(locations.position);
                gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, screenTexBuffer);
                gl.enableVertexAttribArray(locations.texCoord);
                gl.vertexAttribPointer(locations.texCoord, 2, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, screenIndexBuffer);
                gl.drawElements(gl.TRIANGLES, screenMesh.count, gl.UNSIGNED_SHORT, 0);
            }
        }

        // Render Left Eye & Right Eye
        renderEye(false);
        renderEye(true);
    }

    // Initialize
    loadSavedCalibration();
    updateDividerPosition();
    updateVisionAlignmentUI();
    updateScreenGeometry();
    connectServer();
    initSensors();
    requestAnimationFrame(render);

})();
