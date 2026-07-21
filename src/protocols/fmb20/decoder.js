const { crc16IBM } = require('./crc');
const { createNormalizedGpsData } = require('../../core/DataModel');

/**
 * Teltonika Codec8 / Codec8 Extended (FMB20 and most FMB/FMC/FMM family
 * devices). Verified against every worked hex example in the vendor wiki
 * PDF - see validate.js.
 *
 * IMPORTANT - this protocol's wire format is structurally different from
 * GT06/OB22 in three ways that matter for integration:
 *
 * 1. No 0x7878-style start marker and no stop bytes. Frame boundaries are
 *    determined purely by length fields (AVL packets are preamble
 *    0x00000000 + 4-byte length; the login handshake is a bare 2-byte
 *    length + ASCII IMEI, no CRC, no footer).
 *
 * 2. The login handshake and its ACK are NOT a framed packet at all -
 *    it's just [imeiLength(2)][imei ascii] in, and a single byte 0x01
 *    (accept) or 0x00 (reject) out. `parsed.ack` still works fine with
 *    your existing `socket.write(parsed.ack)` in tcpServer.js since it's
 *    just whatever bytes you hand it - no changes needed there for login.
 *
 * 3. **A single AVL data packet can contain multiple GPS records batched
 *    together** (Number of Data 1 > 1 - normal, e.g. after a reconnect
 *    the device flushes its buffer). GT06/OB22 both map 1 frame -> 1
 *    location update, so tcpServer.js currently only calls
 *    `LocationService.processLocation` once per parsed frame. That
 *    doesn't work here - see the `type: 'LOCATION_BATCH'` return shape
 *    below and the README for the (small, one `else if` branch)
 *    tcpServer.js change this requires.
 */

const PROTOCOL = 'FMB20'; // matches the enum already on your Device model
const DEFAULT_PORT = Number(process.env.FMB20_TCP_PORT || 5027);

const CODEC_ID = {
    CODEC8: 0x08,
    CODEC8_EXT: 0x8e,
};

const PRIORITY = { 0: 'low', 1: 'high', 2: 'panic' };

// A handful of AVL IDs the PDF itself names in its worked examples. Not
// exhaustive - Teltonika publishes a much larger "AVL ID" reference doc
// separately. Attaching names here is purely for readability/debugging;
// LocationService should key off the numeric `ioProperties` map, not this.
const AVL_ID_NAMES = {
    1: 'DIN1', 3: 'DIN3', 11: 'ICCID1', 14: 'ICCID2', 16: 'Total Odometer',
    17: 'Axis X', 21: 'GSM Signal', 66: 'External Voltage', 78: 'iButton',
    180: 'DOUT2', 239: 'Ignition', 241: 'Active GSM Operator',
};

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/**
 * Splits a byte stream into complete frames. Two frame shapes to
 * disambiguate, purely from the bytes (no per-socket state needed, so this
 * stays a pure function like your other decoders' extractFrames):
 *   - AVL data packet: first 4 bytes are the zero preamble (0x00000000)
 *   - IMEI login packet: first 2 bytes are a length prefix (always 0x000F
 *     in every real-world Teltonika device, i.e. 15), never zero
 * These can't collide: a genuine IMEI packet's first 4 bytes are always
 * `00 0F <first-two-ASCII-digits>`, never `00 00 00 00`.
 */
function extractFrames(buffer) {
    const frames = [];
    let offset = 0;

    while (offset < buffer.length) {
        const remaining = buffer.length - offset;
        const looksLikeAvlPreamble = remaining >= 8 && buffer.readUInt32BE(offset) === 0;

        if (looksLikeAvlPreamble) {
            const dataFieldLength = buffer.readUInt32BE(offset + 4);
            // total = preamble(4) + lengthField(4) + [codecId..numberOfData2](dataFieldLength) + crcField(4)
            const totalLength = 8 + dataFieldLength + 4;
            if (remaining < totalLength) break; // wait for more bytes
            frames.push(buffer.subarray(offset, offset + totalLength));
            offset += totalLength;
            continue;
        }

        // Otherwise: IMEI handshake packet - 2-byte length prefix + ASCII IMEI.
        if (remaining < 2) break;
        const imeiLength = buffer.readUInt16BE(offset);
        if (imeiLength === 0 || imeiLength > 32) {
            // Doesn't look like a plausible IMEI length and isn't a zero-preamble
            // AVL packet either - resync one byte at a time instead of getting stuck.
            offset += 1;
            continue;
        }
        const totalLength = 2 + imeiLength;
        if (remaining < totalLength) break;
        frames.push(buffer.subarray(offset, offset + totalLength));
        offset += totalLength;
    }

    return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Login handshake
// ---------------------------------------------------------------------------

function buildImeiAck(accept = true) {
    return Buffer.from([accept ? 0x01 : 0x00]);
}

function parseImeiPacket(frame) {
    const imeiLength = frame.readUInt16BE(0);
    const imei = frame.slice(2, 2 + imeiLength).toString('ascii');
    return {
        type: 'LOGIN',
        imei,
        serial: null,
        crcValid: true, // no CRC on the IMEI handshake per spec - nothing to validate
        protocolNumberHex: null,
        ack: buildImeiAck(true),
        normalized: null,
    };
}

// ---------------------------------------------------------------------------
// AVL data packet
// ---------------------------------------------------------------------------

function buildAvlAck(recordCount) {
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(recordCount, 0);
    return ack;
}

/**
 * IO element parsing, parameterized by codec ID since Codec8 uses 1-byte
 * widths throughout and Codec8 Extended uses 2-byte widths plus a trailing
 * "NX" variable-length property group that Codec8 doesn't have.
 */
function parseIoElement(buf, offset, codecId) {
    const isExtended = codecId === CODEC_ID.CODEC8_EXT;
    let o = offset;

    const readId = () => {
        const v = isExtended ? buf.readUInt16BE(o) : buf.readUInt8(o);
        o += isExtended ? 2 : 1;
        return v;
    };
    const readCount = () => {
        const v = isExtended ? buf.readUInt16BE(o) : buf.readUInt8(o);
        o += isExtended ? 2 : 1;
        return v;
    };

    const eventIoId = readId();
    const totalIoCount = readCount(); // N = N1+N2+N4+N8(+NX) - sanity info only, not otherwise used

    const properties = {};

    const n1 = readCount();
    for (let i = 0; i < n1; i++) {
        const id = readId();
        const value = buf.readUInt8(o); o += 1;
        properties[id] = value;
    }

    const n2 = readCount();
    for (let i = 0; i < n2; i++) {
        const id = readId();
        const value = buf.readUInt16BE(o); o += 2;
        properties[id] = value;
    }

    const n4 = readCount();
    for (let i = 0; i < n4; i++) {
        const id = readId();
        const value = buf.readUInt32BE(o); o += 4;
        properties[id] = value;
    }

    const n8 = readCount();
    for (let i = 0; i < n8; i++) {
        const id = readId();
        const value = buf.readBigUInt64BE(o); o += 8;
        // Kept as a string (e.g. ICCID, iButton IDs) to avoid BigInt/Number mixing downstream.
        properties[id] = value.toString();
    }

    let nx = 0;
    if (isExtended) {
        nx = readCount();
        for (let i = 0; i < nx; i++) {
            const id = readId();
            const length = buf.readUInt16BE(o); o += 2;
            const value = buf.slice(o, o + length); o += length;
            properties[id] = value.toString('hex');
        }
    }

    return { eventIoId, totalIoCount, properties, nextOffset: o };
}

/**
 * One AVL Data record: 8-byte timestamp + 1-byte priority + 15-byte GPS
 * element + variable IO element.
 */
function parseAvlRecord(buf, offset, codecId) {
    let o = offset;

    const timestampMs = Number(buf.readBigUInt64BE(o)); o += 8;
    const priorityRaw = buf.readUInt8(o); o += 1;

    // Longitude/latitude: signed 32-bit, degrees * 10,000,000. The PDF's
    // "check the first bit for sign" note is just describing two's
    // complement, so a plain signed big-endian read already does the right
    // thing - no manual sign-bit handling needed.
    const longitude = buf.readInt32BE(o) / 10000000; o += 4;
    const latitude = buf.readInt32BE(o) / 10000000; o += 4;
    const altitude = buf.readUInt16BE(o); o += 2;
    const angle = buf.readUInt16BE(o); o += 2;
    const satellites = buf.readUInt8(o); o += 1;
    const speedKmh = buf.readUInt16BE(o); o += 2;

    const io = parseIoElement(buf, o, codecId);
    o = io.nextOffset;

    const ignition = io.properties[239] !== undefined ? Boolean(io.properties[239]) : null;

    const record = {
        gpsTimestamp: new Date(timestampMs),
        priority: PRIORITY[priorityRaw] || `unknown(${priorityRaw})`,
        longitude,
        latitude,
        altitude,
        heading: angle,
        satellites,
        speedKmh,
        ignition,
        eventIoId: io.eventIoId,
        ioProperties: io.properties, // { avlId: rawValue }
    };

    return { record, nextOffset: o };
}

/**
 * Full AVL data packet: preamble(4) + dataFieldLength(4) + codecId(1) +
 * numberOfData1(1) + [records...] + numberOfData2(1) + crc(4, only the
 * trailing 2 bytes are the meaningful CRC-16 value per every worked example
 * in the doc, e.g. "00 00 C7 CF").
 */
function parseAvlPacket(frame) {
    const dataFieldLength = frame.readUInt32BE(4);
    const codecId = frame.readUInt8(8);
    const numberOfData1 = frame.readUInt8(9);

    const crcOffset = 8 + dataFieldLength; // right after numberOfData2
    const crcInput = frame.slice(8, crcOffset); // "calculated from Codec ID to Number of Data 2" per spec
    const crcField = frame.slice(crcOffset, crcOffset + 4);
    const expectedCrc = crcField.readUInt16BE(2);
    const computedCrc = crc16IBM(crcInput);
    const crcValid = expectedCrc === computedCrc;

    const records = [];
    let offset = 10; // right after codecId(1) + numberOfData1(1)
    for (let i = 0; i < numberOfData1; i++) {
        const { record, nextOffset } = parseAvlRecord(frame, offset, codecId);
        const protocolNumberHexForRecord = `0x${codecId.toString(16).padStart(2, '0')}`;
        records.push(createNormalizedGpsData({
            protocol: PROTOCOL,
            ...record,
            raw: { protocolNumberHex: protocolNumberHexForRecord, codecId },
        }));
        offset = nextOffset;
    }

    const numberOfData2 = frame.readUInt8(offset); offset += 1;
    const protocolNumberHex = `0x${codecId.toString(16).padStart(2, '0')}`;

    return {
        type: 'LOCATION_BATCH',
        imei: null, // not present in AVL packets - comes from the session's login IMEI
        serial: null, // Codec8 has no per-packet serial number field (unlike GT06/OB22)
        crcValid,
        protocolNumberHex,
        codecId,
        recordCount: numberOfData1,
        recordCountMismatch: numberOfData1 !== numberOfData2,
        records,
        ack: crcValid ? buildAvlAck(numberOfData1) : buildAvlAck(0), // 0 accepted if CRC failed - device will resend
    };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function parseFrame(frame) {
    if (frame.length >= 4 && frame.readUInt32BE(0) === 0) {
        return parseAvlPacket(frame);
    }
    return parseImeiPacket(frame);
}

/**
 * Attaches human-readable names to known AVL IDs for logging/debugging.
 * Does not replace the raw numeric `ioProperties` map - LocationService /
 * VehicleStatusEngine should key off AVL ID numbers, not these labels.
 */
function nameIoProperties(ioProperties) {
    const named = {};
    for (const [id, value] of Object.entries(ioProperties)) {
        named[AVL_ID_NAMES[id] || `AVL_${id}`] = value;
    }
    return named;
}

module.exports = {
    PROTOCOL,
    DEFAULT_PORT,
    CODEC_ID,
    AVL_ID_NAMES,
    extractFrames,
    parseFrame,
    parseImeiPacket,
    parseAvlPacket,
    parseAvlRecord,
    parseIoElement,
    buildImeiAck,
    buildAvlAck,
    nameIoProperties,
};