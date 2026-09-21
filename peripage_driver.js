// =========================================================================
// DRIVER PERIPAGE A6 V2 - WEB BLUETOOTH
// OSCURIDAD + VELOCIDAD + LOGO PERSONALIZADO + SALTO DE LÍNEA INTELIGENTE
// =========================================================================

const PERIPAGE_SERVICE_UUID = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
const PERIPAGE_CHAR_UUID    = "49535343-8841-43f4-a8d4-ecbe34729bb3";

let bleDevice = null;
let bleServer = null;
let bleCharacteristic = null;
let printerConnected = false;
let onPrinterStatusChangeCallback = null;

// ---------------------------------------------------------
// AJUSTES DE CALIDAD DE IMPRESIÓN (Configurables desde el Editor)
// Oscuridad : 1=muy claro · 3=claro · 4=normal · 6=oscuro · 8=máximo negro
// Sin ESP32 no hay riesgo de brownout → máximo negro por defecto
// ---------------------------------------------------------
let printDarkness = 8;        // ← MÁXIMO NEGRO (sin limitación de hardware)
let chunkDelayMs  = 10;   // Entre paquetes de 20 bytes (imagen)
let blockDelayMs  = 25;   // Entre bloques de 24 líneas
let fontDelayMs   = 8;    // Entre paquetes de texto

function setPrintQuality(darkness, speed) {
    printDarkness = Math.max(1, Math.min(8, Math.round(Number(darkness))));
    if (speed === 'fast')      { chunkDelayMs = 5;  blockDelayMs = 15; fontDelayMs = 4;  }
    else if (speed === 'safe') { chunkDelayMs = 18; blockDelayMs = 45; fontDelayMs = 14; }
    else                       { chunkDelayMs = 10; blockDelayMs = 25; fontDelayMs = 8;  }
}

function setPrinterStatusCallback(cb) {
    onPrinterStatusChangeCallback = cb;
}

function updateStatus(connected) {
    printerConnected = connected;
    if (onPrinterStatusChangeCallback) {
        onPrinterStatusChangeCallback(connected);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------
// 1. CONEXIÓN BLE NATIVA MEDIANTE CHROME
// ---------------------------------------------------------
async function connectPrinter() {
    if (printerConnected && bleDevice && bleDevice.gatt.connected && bleCharacteristic) {
        return true;
    }

    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [PERIPAGE_SERVICE_UUID]
        });

        bleDevice.addEventListener('gattserverdisconnected', () => {
            console.warn("PeriPage desconectada");
            updateStatus(false);
        });

        bleServer = await bleDevice.gatt.connect();
        const service = await bleServer.getPrimaryService(PERIPAGE_SERVICE_UUID);
        bleCharacteristic = await service.getCharacteristic(PERIPAGE_CHAR_UUID);

        // Despertar la impresora
        await writeBLEChunk(new Uint8Array([0x10, 0xFF, 0xFE, 0x01]));
        await sleep(100);

        // Inicializar ESC/POS (ESC @)
        await writeBLEChunk(new Uint8Array([0x1B, 0x40]));
        await sleep(50);

        updateStatus(true);
        return true;
    } catch (err) {
        console.warn("Error al conectar con PeriPage:", err);
        updateStatus(false);
        return false;
    }
}

async function writeBLEChunk(data) {
    if (!bleCharacteristic) throw new Error("Impresora no conectada");
    if (bleCharacteristic.writeValueWithoutResponse) {
        await bleCharacteristic.writeValueWithoutResponse(data);
    } else {
        await bleCharacteristic.writeValue(data);
    }
}

// ---------------------------------------------------------
// 2. COMANDO DE OSCURIDAD DE IMPRESIÓN (Propietario PeriPage)
// 0x10 0xFF 0xFE 0x03 [nivel 1-8]
// Se envía antes de cada trabajo de impresión.
// ---------------------------------------------------------
async function applyPrintDarkness() {
    if (!bleCharacteristic || !bleDevice || !bleDevice.gatt.connected) return;
    const cmd = new Uint8Array([0x10, 0xFF, 0xFE, 0x03, printDarkness]);
    await writeBLEChunk(cmd);
    await sleep(50);
}

// ---------------------------------------------------------
// 3. MOTOR GRÁFICO TÉRMICO (con tiempos configurables)
// ---------------------------------------------------------
async function printRasterImage(data, widthBytes, height) {
    if (!bleCharacteristic || !bleDevice || !bleDevice.gatt.connected) return false;

    const linesPerBlock = 24;
    for (let blockStart = 0; blockStart < height; blockStart += linesPerBlock) {
        if (!bleDevice.gatt.connected) return false;

        const currentBlockHeight = (blockStart + linesPerBlock > height) ? height - blockStart : linesPerBlock;
        const header = new Uint8Array([
            0x1D, 0x76, 0x30, 0x00,
            widthBytes & 0xFF, 0x00,
            currentBlockHeight & 0xFF, 0x00
        ]);
        await writeBLEChunk(header);

        const blockDataStart = blockStart * widthBytes;
        const totalBytes = widthBytes * currentBlockHeight;

        for (let i = 0; i < totalBytes; i += 20) {
            if (!bleDevice.gatt.connected) return false;
            const chunkSize = Math.min(20, totalBytes - i);
            const chunk = data.subarray(blockDataStart + i, blockDataStart + i + chunkSize);
            await writeBLEChunk(chunk);
            await sleep(chunkDelayMs);   // <- Velocidad configurable
        }
        await sleep(blockDelayMs);       // <- Velocidad configurable
    }
    return true;
}

function convertToAscii(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function imprimirTextoGrafico(texto, scale = 2, spacing = 25) {
    if (!bleCharacteristic || !bleDevice || !bleDevice.gatt.connected) return false;

    const asciiText = convertToAscii(texto);
    const len = asciiText.length;
    const pixelHeight = 8 * scale;
    const pixelWidth = len * 6 * scale;
    const widthBytes = Math.floor((pixelWidth + 7) / 8);

    const header = new Uint8Array([
        0x1D, 0x76, 0x30, 0x00,
        widthBytes & 0xFF, 0x00,
        pixelHeight & 0xFF, 0x00
    ]);
    await writeBLEChunk(header);

    const bleChunk = new Uint8Array(20);
    let chunkIdx = 0;

    for (let y = 0; y < pixelHeight; y++) {
        const yFont = Math.floor(y / scale);
        for (let bx = 0; bx < widthBytes; bx++) {
            if (!bleDevice.gatt.connected) return false;

            let oneByte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const cx = bx * 8 + bit;
                if (cx < pixelWidth) {
                    const charIdx = Math.floor(Math.floor(cx / scale) / 6);
                    const colInChar = Math.floor(cx / scale) % 6;
                    if (charIdx < len && colInChar < 5) {
                        const code = asciiText.charCodeAt(charIdx);
                        const fontCol = getFontCol(code - 32, colInChar);
                        if ((fontCol & (1 << yFont)) !== 0) {
                            oneByte |= (1 << (7 - bit));
                        }
                    }
                }
            }
            bleChunk[chunkIdx++] = oneByte;
            if (chunkIdx >= 20) {
                await writeBLEChunk(new Uint8Array(bleChunk));
                chunkIdx = 0;
                await sleep(fontDelayMs);  // <- Velocidad configurable
            }
        }
    }

    if (chunkIdx > 0 && bleDevice.gatt.connected) {
        await writeBLEChunk(bleChunk.subarray(0, chunkIdx));
    }
    if (spacing > 0 && bleDevice.gatt.connected) {
        const feed = new Uint8Array([0x1B, 0x4A, spacing & 0xFF]);
        await writeBLEChunk(feed);
    }
    return bleDevice.gatt.connected;
}

async function printTextLine(texto, scale = 2, spacing = 25) {
    return await imprimirTextoGrafico(texto, scale, spacing);
}

// ---------------------------------------------------------
// 4. IMPRESIÓN COMPLETA CON OSCURIDAD, LOGO Y SALTO DE LÍNEA
// ---------------------------------------------------------
async function printReceiptV2(carta, code, itemLookup, options = {}) {
    if (!printerConnected) {
        const ok = await connectPrinter();
        if (!ok) return false;
    }

    try {
        // Aplicar oscuridad configurada justo antes de imprimir
        await applyPrintDarkness();

        // 1. Logo (Personalizado o por defecto)
        let okLogo = false;
        if (options.customLogo && options.customLogo.data && options.customLogo.height > 0) {
            okLogo = await printRasterImage(options.customLogo.data, options.customLogo.widthBytes || 48, options.customLogo.height);
        } else if (carta === 'jutama') {
            okLogo = await printRasterImage(logo_jutama_bitmap, LOGO_JUTAMA_WIDTH_BYTES, LOGO_JUTAMA_HEIGHT);
        } else {
            okLogo = await printRasterImage(logo_gabip_bitmap, LOGO_GABIP_WIDTH_BYTES, LOGO_GABIP_HEIGHT);
        }
        if (!okLogo) return false;

        // 2. Cabecera
        const lineOp   = options.headerLineOp   || "No Op.: Pendiente";
        const lineSala = options.headerLineSala  || "Sala: 101      EMP: 1";

        if (!await printTextLine("--------------------------------", 2, 30)) return false;
        if (!await printTextLine(lineOp,   2, 25)) return false;
        if (!await printTextLine(lineSala, 2, 25)) return false;
        if (!await printTextLine("--------------------------------", 2, 30)) return false;
        if (!await printTextLine("Uds  PRODUCTO             TOTAL", 2, 35)) return false;
        if (!await printTextLine("--------------------------------", 1, 20)) return false;

        // 3. Platos con salto de línea inteligente para nombres >28 caracteres
        let totalVenta = 0.0;
        for (let i = 0; i < code.length; i += 2) {
            const key  = code.substring(i, i + 2);
            const item = itemLookup[key];
            if (item) {
                const price    = Number(item.price);
                const pStr     = price.toFixed(2).replace('.', ',');
                const pStrConE = pStr + " e";
                const name     = convertToAscii(item.name);

                if (name.length <= 28) {
                    if (!await printTextLine("1 x " + name, 2, 10)) return false;
                } else {
                    // Divide en 2 líneas sin cortar palabras si es posible
                    let splitAt = 28;
                    const spaceIdx = name.lastIndexOf(' ', 28);
                    if (spaceIdx > 18) splitAt = spaceIdx;
                    const line1 = "1 x " + name.substring(0, splitAt);
                    const line2 = "    " + name.substring(splitAt).trim();
                    if (!await printTextLine(line1, 2, 10)) return false;
                    if (!await printTextLine(line2, 2, 10)) return false;
                }

                // Precio alineado a la derecha
                const espacios  = Math.max(0, 28 - pStrConE.length);
                const filaPrecio = " ".repeat(espacios) + pStrConE;
                if (!await printTextLine(filaPrecio, 2, 30)) return false;

                totalVenta += price;
                await sleep(30);
            }
        }

        // 4. Total y pie
        if (!await printTextLine("--------------------------------", 2, 30)) return false;
        const totStr = totalVenta.toFixed(2).replace('.', ',');
        if (!await printTextLine("TOTAL: " + totStr + " EUR", 3, 60)) return false;

        const footerText = options.footerText || "Gracias por su visita!";
        if (!await printTextLine(footerText, 2, 30)) return false;

        // 5. Avance de papel para corte cómodo
        for (let i = 0; i < 3; i++) {
            await writeBLEChunk(new Uint8Array([0x1B, 0x4A, 0x40]));
            await sleep(100);
        }

        return true;
    } catch (e) {
        console.error("Fallo durante la impresión:", e);
        return false;
    }
}
