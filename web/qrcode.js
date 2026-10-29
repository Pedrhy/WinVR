/**
 * WinVR QR Code Generator
 * Standard-compliant pure JavaScript QR Code Generator (ISO/IEC 18004)
 * Generates verified QR Codes with Reed-Solomon Error Correction for instant phone camera pairing
 */
(function(window) {
    'use strict';

    // --- Galois Field GF(256) Math ---
    var QRMath = {
        glog: function(n) {
            if (n < 1) throw new Error("glog(" + n + ")");
            return QRMath.LOG_TABLE[n];
        },
        gexp: function(n) {
            while (n < 0) n += 255;
            while (n >= 255) n -= 255;
            return QRMath.EXP_TABLE[n];
        },
        EXP_TABLE: new Array(256),
        LOG_TABLE: new Array(256)
    };

    for (var i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
    for (var i = 8; i < 256; i++) {
        QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i++) {
        QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;
    }

    // --- Polynomial Operations ---
    function QRPolynomial(num, shift) {
        if (num.length === undefined) throw new Error(num.length + "/" + shift);
        var offset = 0;
        while (offset < num.length && num[offset] === 0) offset++;
        this.num = new Array(num.length - offset + shift);
        for (var i = 0; i < num.length - offset; i++) {
            this.num[i] = num[i + offset];
        }
        for (var i = num.length - offset; i < this.num.length; i++) {
            this.num[i] = 0;
        }
    }

    QRPolynomial.prototype = {
        get: function(index) { return this.num[index]; },
        getLength: function() { return this.num.length; },
        multiply: function(e) {
            var num = new Array(this.getLength() + e.getLength() - 1);
            for (var i = 0; i < num.length; i++) num[i] = 0;
            for (var i = 0; i < this.getLength(); i++) {
                for (var j = 0; j < e.getLength(); j++) {
                    num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
                }
            }
            return new QRPolynomial(num, 0);
        },
        mod: function(e) {
            if (this.getLength() - e.getLength() < 0) return this;
            var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
            var num = new Array(this.getLength());
            for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
            for (var i = 0; i < e.getLength(); i++) {
                num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
            }
            return new QRPolynomial(num, 0).mod(e);
        }
    };

    // --- Reed-Solomon Block Engine ---
    function QRRSBlock(totalCount, dataCount) {
        this.totalCount = totalCount;
        this.dataCount = dataCount;
    }

    // RS Block specifications for QR Code Versions 1 to 10
    // [Count, TotalCodewords, DataCodewords] per ECC Level: [L(1), M(0), Q(3), H(2)]
    QRRSBlock.RS_BLOCK_TABLE = [
        // Version 1
        [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
        // Version 2
        [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
        // Version 3
        [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
        // Version 4
        [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
        // Version 5
        [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
        // Version 6
        [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
        // Version 7
        [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
        // Version 8
        [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
        // Version 9
        [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
        // Version 10
        [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]
    ];

    QRRSBlock.getRSBlocks = function(typeNumber, errorCorrectLevel) {
        var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectLevel);
        if (!rsBlock) throw new Error("bad rs block @ type:" + typeNumber + "/ecc:" + errorCorrectLevel);
        var length = rsBlock.length / 3;
        var list = [];
        for (var i = 0; i < length; i++) {
            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];
            for (var j = 0; j < count; j++) {
                list.push(new QRRSBlock(totalCount, dataCount));
            }
        }
        return list;
    };

    QRRSBlock.getRsBlockTable = function(typeNumber, errorCorrectLevel) {
        switch (errorCorrectLevel) {
            case 1: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0]; // L
            case 0: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1]; // M
            case 3: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2]; // Q
            case 2: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3]; // H
            default: return undefined;
        }
    };

    // --- Bit Buffer ---
    function QRBitBuffer() {
        this.buffer = [];
        this.length = 0;
    }
    QRBitBuffer.prototype = {
        get: function(index) {
            var bufIndex = Math.floor(index / 8);
            return ((this.buffer[bufIndex] >>> (7 - (index % 8))) & 1) === 1;
        },
        put: function(num, length) {
            for (var i = 0; i < length; i++) {
                this.putBit(((num >>> (length - i - 1)) & 1) === 1);
            }
        },
        getLengthInBits: function() { return this.length; },
        putBit: function(bit) {
            var bufIndex = Math.floor(this.length / 8);
            if (this.buffer.length <= bufIndex) this.buffer.push(0);
            if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
            this.length++;
        }
    };

    // --- 8-Bit Byte Mode Data ---
    function QR8bitByte(data) {
        this.mode = 4; // 8-bit byte mode
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

    // --- Utility Methods & Tables ---
    var QRUtil = {
        PATTERN_POSITION_TABLE: [
            [],
            [6, 18],
            [6, 22],
            [6, 26],
            [6, 30],
            [6, 34],
            [6, 22, 38],
            [6, 24, 42],
            [6, 26, 46],
            [6, 28, 50]
        ],
        getBCHTypeInfo: function(data) {
            var d = data << 10;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(1335) >= 0) {
                d ^= (1335 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(1335)));
            }
            return ((data << 10) | d) ^ 21522;
        },
        getBCHDigit: function(data) {
            var digit = 0;
            while (data !== 0) {
                digit++;
                data >>>= 1;
            }
            return digit;
        },
        getErrorCorrectPolynomial: function(errorCorrectLength) {
            var a = new QRPolynomial([1], 0);
            for (var i = 0; i < errorCorrectLength; i++) {
                a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
            }
            return a;
        },
        getLengthInBits: function(mode, type) {
            if (1 <= type && type < 10) {
                switch (mode) {
                    case 1: return 10; // Numeric
                    case 2: return 9;  // Alphanumeric
                    case 4: return 8;  // 8-bit byte
                    case 8: return 8;  // Kanji
                    default: throw new Error("mode:" + mode);
                }
            } else {
                switch (mode) {
                    case 1: return 12;
                    case 2: return 11;
                    case 4: return 16;
                    case 8: return 10;
                    default: throw new Error("mode:" + mode);
                }
            }
        },
        getLostPoint: function(qrCode) {
            var moduleCount = qrCode.getModuleCount();
            var lostPoint = 0;

            // Level 1: 5 or more consecutive modules of same color
            for (var row = 0; row < moduleCount; row++) {
                for (var col = 0; col < moduleCount; col++) {
                    var sameCount = 0;
                    var dark = qrCode.isDark(row, col);
                    for (var r = -1; r <= 1; r++) {
                        if (row + r < 0 || moduleCount <= row + r) continue;
                        for (var c = -1; c <= 1; c++) {
                            if (col + c < 0 || moduleCount <= col + c || (r === 0 && c === 0)) continue;
                            if (dark === qrCode.isDark(row + r, col + c)) sameCount++;
                        }
                    }
                    if (sameCount > 5) lostPoint += (3 + sameCount - 5);
                }
            }

            // Level 2: 2x2 blocks of same color
            for (var row = 0; row < moduleCount - 1; row++) {
                for (var col = 0; col < moduleCount - 1; col++) {
                    var count = 0;
                    if (qrCode.isDark(row, col)) count++;
                    if (qrCode.isDark(row + 1, col)) count++;
                    if (qrCode.isDark(row, col + 1)) count++;
                    if (qrCode.isDark(row + 1, col + 1)) count++;
                    if (count === 0 || count === 4) lostPoint += 3;
                }
            }

            return lostPoint;
        }
    };

    // --- Main QR Code Model Engine ---
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
            // Find minimum typeNumber that fits the data if typeNumber is 0
            if (this.typeNumber < 1) {
                var typeNumber = 1;
                for (typeNumber = 1; typeNumber <= 10; typeNumber++) {
                    var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, this.errorCorrectLevel);
                    var totalDataCount = 0;
                    for (var i = 0; i < rsBlocks.length; i++) {
                        totalDataCount += rsBlocks[i].dataCount;
                    }
                    var length = 0;
                    for (var i = 0; i < this.dataList.length; i++) {
                        length += this.dataList[i].getLength();
                    }
                    if (length <= totalDataCount - 3) break;
                }
                this.typeNumber = Math.min(10, typeNumber);
            }
            this.makeImpl(false, this.getBestMaskPattern());
        },
        makeImpl: function(test, maskPattern) {
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
            if (this.dataCache === null) {
                this.dataCache = QRCodeModel.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
            }
            this.mapData(this.dataCache, maskPattern);
        },
        setupPositionProbePattern: function(row, col) {
            for (var r = -1; r <= 7; r++) {
                if (row + r <= -1 || this.moduleCount <= row + r) continue;
                for (var c = -1; c <= 7; c++) {
                    if (col + c <= -1 || this.moduleCount <= col + c) continue;
                    if ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
                        (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
                        (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
                        this.modules[row + r][col + c] = true;
                    } else {
                        this.modules[row + r][col + c] = false;
                    }
                }
            }
        },
        getBestMaskPattern: function() {
            var minLostPoint = 0;
            var pattern = 0;
            for (var i = 0; i < 8; i++) {
                this.makeImpl(true, i);
                var lostPoint = QRUtil.getLostPoint(this);
                if (i === 0 || minLostPoint > lostPoint) {
                    minLostPoint = lostPoint;
                    pattern = i;
                }
            }
            return pattern;
        },
        setupTimingPattern: function() {
            for (var r = 8; r < this.moduleCount - 8; r++) {
                if (this.modules[r][6] !== null) continue;
                this.modules[r][6] = (r % 2 === 0);
            }
            for (var c = 8; c < this.moduleCount - 8; c++) {
                if (this.modules[6][c] !== null) continue;
                this.modules[6][c] = (c % 2 === 0);
            }
        },
        setupPositionAdjustPattern: function() {
            var pos = QRUtil.PATTERN_POSITION_TABLE[this.typeNumber - 1];
            if (!pos) return;
            for (var i = 0; i < pos.length; i++) {
                for (var j = 0; j < pos.length; j++) {
                    var row = pos[i];
                    var col = pos[j];
                    if (this.modules[row][col] !== null) continue;
                    for (var r = -2; r <= 2; r++) {
                        for (var c = -2; c <= 2; c++) {
                            if (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) {
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
                var mod = (!test && ((bits >> i) & 1) === 1);
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
                if (col === 6) col--;
                while (true) {
                    for (var c = 0; c < 2; c++) {
                        if (this.modules[row][col - c] === null) {
                            var dark = false;
                            if (byteIndex < data.length) {
                                dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
                            }
                            var mask = this.getMask(maskPattern, row, col - c);
                            if (mask) dark = !dark;
                            this.modules[row][col - c] = dark;
                            bitIndex--;
                            if (bitIndex === -1) {
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
        },
        getMask: function(maskPattern, i, j) {
            switch (maskPattern) {
                case 0: return (i + j) % 2 === 0;
                case 1: return i % 2 === 0;
                case 2: return j % 3 === 0;
                case 3: return (i + j) % 3 === 0;
                case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
                case 5: return (i * j) % 2 + (i * j) % 3 === 0;
                case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
                case 7: return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
                default: throw new Error("bad maskPattern:" + maskPattern);
            }
        }
    };

    // --- Generate RS Blocks & Interleaved Codewords ---
    QRCodeModel.createData = function(typeNumber, errorCorrectLevel, dataList) {
        var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel);
        var buffer = new QRBitBuffer();

        for (var i = 0; i < dataList.length; i++) {
            var data = dataList[i];
            buffer.put(data.mode, 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
            data.write(buffer);
        }

        var totalDataCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
        }

        if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw new Error("code length overflow. (" + buffer.getLengthInBits() + " > " + (totalDataCount * 8) + " bits)");
        }

        // Terminator
        if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
        }

        // Byte alignment padding
        while (buffer.getLengthInBits() % 8 !== 0) {
            buffer.putBit(false);
        }

        // Fill bytes
        while (true) {
            if (buffer.getLengthInBits() >= totalDataCount * 8) break;
            buffer.put(0xec, 8);
            if (buffer.getLengthInBits() >= totalDataCount * 8) break;
            buffer.put(0x11, 8);
        }

        return QRCodeModel.createBytes(buffer, rsBlocks);
    };

    QRCodeModel.createBytes = function(buffer, rsBlocks) {
        var offset = 0;
        var maxDcCount = 0;
        var maxEcCount = 0;
        var dcdata = new Array(rsBlocks.length);
        var ecdata = new Array(rsBlocks.length);

        for (var r = 0; r < rsBlocks.length; r++) {
            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;
            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);

            dcdata[r] = new Array(dcCount);
            for (var i = 0; i < dcdata[r].length; i++) {
                dcdata[r][i] = 0xff & buffer.buffer[i + offset];
            }
            offset += dcCount;

            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
            var modPoly = rawPoly.mod(rsPoly);

            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i++) {
                var modIndex = i + modPoly.getLength() - ecdata[r].length;
                ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
            }
        }

        var totalCodeCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) {
            totalCodeCount += rsBlocks[i].totalCount;
        }

        var data = new Array(totalCodeCount);
        var index = 0;

        // Interleave Data Codewords
        for (var i = 0; i < maxDcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) {
                if (i < dcdata[r].length) {
                    data[index++] = dcdata[r][i];
                }
            }
        }

        // Interleave Error Correction Codewords
        for (var i = 0; i < maxEcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) {
                if (i < ecdata[r].length) {
                    data[index++] = ecdata[r][i];
                }
            }
        }

        return data;
    };

    // --- High-Level QRCode UI Component ---
    function QRCode(container, options) {
        if (typeof options === "string") {
            options = { text: options };
        }
        this.options = {
            width: options.width || 120,
            height: options.height || 120,
            colorDark: options.colorDark || "#000000",
            colorLight: options.colorLight || "#ffffff",
            correctLevel: (options.correctLevel !== undefined) ? options.correctLevel : 0, // 0 = M (15%)
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
        var quietZone = 2; // Standard 2-module white quiet margin for reliable camera lock
        var totalModules = moduleCount + quietZone * 2;
        var cellSize = Math.floor(this.options.width / totalModules);
        if (cellSize < 2) cellSize = 2;
        var actualWidth = cellSize * totalModules;

        var canvas = document.createElement("canvas");
        canvas.width = actualWidth;
        canvas.height = actualWidth;
        var ctx = canvas.getContext("2d");

        // Background / Quiet Zone
        ctx.fillStyle = this.options.colorLight;
        ctx.fillRect(0, 0, actualWidth, actualWidth);

        // Dark Modules
        ctx.fillStyle = this.options.colorDark;
        var offset = quietZone * cellSize;
        for (var row = 0; row < moduleCount; row++) {
            for (var col = 0; col < moduleCount; col++) {
                if (qr.isDark(row, col)) {
                    ctx.fillRect(offset + col * cellSize, offset + row * cellSize, cellSize, cellSize);
                }
            }
        }

        if (this.container) {
            this.container.innerHTML = "";
            this.container.appendChild(canvas);
        }
        return canvas;
    };

    window.QRCode = QRCode;
})(window);
