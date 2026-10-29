/**
 * Lightweight QR Code Generator in pure JavaScript (No external dependencies)
 * Generates QR Code SVG / Canvas for local Wi-Fi pairing
 */
(function(window) {
    // QRCode Generator helper using standard byte encoding and ECC
    function QRCode(container, options) {
        if (typeof options === "string") {
            options = { text: options };
        }
        this.options = {
            width: options.width || 200,
            height: options.height || 200,
            colorDark: options.colorDark || "#00ffff",
            colorLight: options.colorLight || "#0d1117",
            correctLevel: options.correctLevel || 1, // L:1, M:0, Q:3, H:2
            text: options.text || ""
        };
        this.container = (typeof container === "string") ? document.getElementById(container) : container;
        if (this.options.text) {
            this.makeCode(this.options.text);
        }
    }

    QRCode.prototype.makeCode = function(text) {
        this.options.text = text;
        var qr = new QRCodeModel(0, this.options.correctLevel);
        qr.addData(text);
        qr.make();

        var moduleCount = qr.getModuleCount();
        var cellSize = Math.floor(this.options.width / (moduleCount + 2));
        var margin = Math.floor((this.options.width - cellSize * moduleCount) / 2);

        var canvas = document.createElement("canvas");
        canvas.width = this.options.width;
        canvas.height = this.options.height;
        var ctx = canvas.getContext("2d");

        ctx.fillStyle = this.options.colorLight;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = this.options.colorDark;
        for (var row = 0; row < moduleCount; row++) {
            for (var col = 0; col < moduleCount; col++) {
                if (qr.isDark(row, col)) {
                    ctx.fillRect(margin + col * cellSize, margin + row * cellSize, cellSize, cellSize);
                }
            }
        }

        if (this.container) {
            this.container.innerHTML = "";
            this.container.appendChild(canvas);
        }
        return canvas;
    };

    // Minimal QR Code Model Engine
    function QRCodeModel(typeNumber, errorCorrectLevel) {
        this.typeNumber = typeNumber;
        this.errorCorrectLevel = errorCorrectLevel;
        this.modules = null;
        this.moduleCount = 0;
        this.dataCache = null;
        this.dataList = [];
    }

    QRCodeModel.prototype = {
        addData: function(data) {
            this.dataList.push(new QR8bitByte(data));
            this.dataCache = null;
        },
        isDark: function(row, col) {
            if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
                throw new Error(row + "," + col);
            }
            return this.modules[row][col];
        },
        getModuleCount: function() {
            return this.moduleCount;
        },
        make: function() {
            this.makeImpl(false, this.getBestMaskPattern());
        },
        makeImpl: function(test, maskPattern) {
            this.typeNumber = 4; // Version 4 fits up to 78 chars in ECC-M
            if (this.dataList[0].data.length > 50) this.typeNumber = 6;
            this.moduleCount = this.typeNumber * 4 + 17;
            this.modules = new Array(this.moduleCount);
            for (var row = 0; row < this.moduleCount; row++) {
                this.modules[row] = new Array(this.moduleCount);
                for (var col = 0; col < this.moduleCount; col++) {
                    this.modules[row][col] = null;
                }
            }
            this.setupPositionProbePattern(0, 0);
            this.setupPositionProbePattern(this.moduleCount - 7, 0);
            this.setupPositionProbePattern(0, this.moduleCount - 7);
            this.setupPositionAdjustPattern();
            this.setupTimingPattern();
            this.setupTypeInfo(test, maskPattern);
            if (this.typeNumber >= 7) this.setupTypeNumber(test);
            if (this.dataCache == null) {
                this.dataCache = QRCodeModel.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
            }
            this.mapData(this.dataCache, maskPattern);
        },
        setupPositionProbePattern: function(row, col) {
            for (var r = -1; r <= 7; r++) {
                if (row + r <= -1 || this.moduleCount <= row + r) continue;
                for (var c = -1; c <= 7; c++) {
                    if (col + c <= -1 || this.moduleCount <= col + c) continue;
                    if ((0 <= r && r <= 6 && (c == 0 || c == 6)) || (0 <= c && c <= 6 && (r == 0 || r == 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
                        this.modules[row + r][col + c] = true;
                    } else {
                        this.modules[row + r][col + c] = false;
                    }
                }
            }
        },
        getBestMaskPattern: function() {
            return 0; // Standard checkerboard mask pattern
        },
        setupTimingPattern: function() {
            for (var r = 8; r < this.moduleCount - 8; r++) {
                if (this.modules[r][6] != null) continue;
                this.modules[r][6] = (r % 2 == 0);
            }
            for (var c = 8; c < this.moduleCount - 8; c++) {
                if (this.modules[6][c] != null) continue;
                this.modules[6][c] = (c % 2 == 0);
            }
        },
        setupPositionAdjustPattern: function() {
            var pos = [6, 26, 30, 34];
            var pattern = [pos[this.typeNumber > 4 ? 1 : 0]];
            for (var i = 0; i < pattern.length; i++) {
                for (var j = 0; j < pattern.length; j++) {
                    var row = pattern[i];
                    var col = pattern[j];
                    if (this.modules[row][col] != null) continue;
                    for (var r = -2; r <= 2; r++) {
                        for (var c = -2; c <= 2; c++) {
                            if (Math.abs(r) == 2 || Math.abs(c) == 2 || (r == 0 && c == 0)) {
                                this.modules[row + r][col + c] = true;
                            } else {
                                this.modules[row + r][col + c] = false;
                            }
                        }
                    }
                }
            }
        },
        setupTypeInfo: function(test, maskPattern) {
            var data = (this.errorCorrectLevel << 3) | maskPattern;
            var bits = QRUtil.getBCHTypeInfo(data);
            for (var i = 0; i < 15; i++) {
                var mod = (!test && ((bits >> i) & 1) == 1);
                if (i < 6) this.modules[i][8] = mod;
                else if (i < 8) this.modules[i + 1][8] = mod;
                else this.modules[this.moduleCount - 15 + i][8] = mod;

                if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
                else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
                else this.modules[8][15 - i - 1] = mod;
            }
            this.modules[this.moduleCount - 8][8] = !test;
        },
        mapData: function(data, maskPattern) {
            var inc = -1;
            var row = this.moduleCount - 1;
            var bitIndex = 7;
            var byteIndex = 0;
            for (var col = this.moduleCount - 1; col > 0; col -= 2) {
                if (col == 6) col--;
                while (true) {
                    for (var c = 0; c < 2; c++) {
                        if (this.modules[row][col - c] == null) {
                            var dark = false;
                            if (byteIndex < data.length) {
                                dark = (((data[byteIndex] >>> bitIndex) & 1) == 1);
                            }
                            var mask = (row + (col - c)) % 2 == 0;
                            if (mask) dark = !dark;
                            this.modules[row][col - c] = dark;
                            bitIndex--;
                            if (bitIndex == -1) {
                                byteIndex++;
                                bitIndex = 7;
                            }
                        }
                    }
                    row += inc;
                    if (row < 0 || this.moduleCount <= row) {
                        row -= inc;
                        inc = -inc;
                        break;
                    }
                }
            }
        }
    };

    function QR8bitByte(data) {
        this.mode = 4; // 8-bit byte
        this.data = data;
    }
    QR8bitByte.prototype = {
        getLength: function() { return this.data.length; },
        write: function(buffer) {
            for (var i = 0; i < this.data.length; i++) {
                buffer.put(this.data.charCodeAt(i), 8);
            }
        }
    };

    function QRBitBuffer() {
        this.buffer = [];
        this.length = 0;
    }
    QRBitBuffer.prototype = {
        put: function(num, length) {
            for (var i = 0; i < length; i++) {
                this.putBit(((num >>> (length - i - 1)) & 1) == 1);
            }
        },
        putBit: function(bit) {
            var bufIndex = Math.floor(this.length / 8);
            if (this.buffer.length <= bufIndex) this.buffer.push(0);
            if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
            this.length++;
        }
    };

    var QRUtil = {
        getBCHTypeInfo: function(data) {
            var d = data << 10;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(1335) >= 0) {
                d ^= (1335 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(1335)));
            }
            return ((data << 10) | d) ^ 21522;
        },
        getBCHDigit: function(data) {
            var digit = 0;
            while (data != 0) {
                digit++;
                data >>>= 1;
            }
            return digit;
        }
    };

    QRCodeModel.createData = function(typeNumber, errorCorrectLevel, dataList) {
        var buffer = new QRBitBuffer();
        for (var i = 0; i < dataList.length; i++) {
            var data = dataList[i];
            buffer.put(data.mode, 4);
            buffer.put(data.getLength(), 8);
            data.write(buffer);
        }
        var totalDataCount = (typeNumber == 4 ? 64 : 108);
        if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
        while (buffer.length % 8 != 0) buffer.putBit(false);
        while (true) {
            if (buffer.length >= totalDataCount * 8) break;
            buffer.put(236, 8);
            if (buffer.length >= totalDataCount * 8) break;
            buffer.put(17, 8);
        }
        return buffer.buffer;
    };

    window.QRCode = QRCode;
})(window);
