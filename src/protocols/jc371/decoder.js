'use strict';

const { FLAG, xorChecksum, extractFrames, escapeFrame } = require('./utils');
const { parseHeader, buildHeader } = require('./header');
const body = require('./bodyDecoders');

const PROTOCOL = 'JC371';
const DEFAULT_PORT = Number(process.env.JC371_TCP_PORT || 5031);

const MSG_ID = {
    GENERAL_TERMINAL_RESPONSE: 0x0001,
    GENERAL_PLATFORM_RESPONSE: 0x8001,
    TERMINAL_HEARTBEAT: 0x0002,
    TERMINAL_DEREGISTRATION: 0x0003,
    SEGMENT_RETRANSMIT_REQUEST_TERMINAL: 0x0005,
    TERMINAL_REGISTRATION: 0x0100,
    REGISTRATION_RESPONSE: 0x8100,
    TERMINAL_AUTHENTICATION: 0x0102,
    PARAMETER_QUERY_RESPONSE: 0x0104,
    PARAMETER_SETUP: 0x8103,
    PARAMETER_QUERY: 0x8104,
    SPECIFIED_PARAMETER_QUERY: 0x8106,
    TERMINAL_CONTROL: 0x8105,
    TTS_MESSAGE_DELIVERY: 0x8300,
    PASSTHROUGH_DOWNLINK: 0x8900,
    PASSTHROUGH_UPLINK: 0x0900,
    LOCATION_REPORT: 0x0200,
    LOCATION_QUERY: 0x8201,
    LOCATION_QUERY_RESPONSE: 0x0201,
    BATCH_LOCATION_UPLOAD: 0x0704,
    MULTIMEDIA_EVENT_UPLOAD: 0x0800,
    MULTIMEDIA_DATA_UPLOAD: 0x0801,
    MULTIMEDIA_DATA_UPLOAD_RESPONSE: 0x8800,
    IMMEDIATE_CAPTURE_COMMAND: 0x8801,
    IMMEDIATE_CAPTURE_RESPONSE: 0x0805,
    MULTIMEDIA_DATA_RETRIEVAL: 0x8802,
    MULTIMEDIA_DATA_RETRIEVAL_RESPONSE: 0x0802,
    SINGLE_MULTIMEDIA_RETRIEVAL_UPLOAD: 0x8805,
    AV_REALTIME_TRANSMISSION_REQUEST: 0x9101,
    AV_REALTIME_TRANSMISSION_CONTROL: 0x9102,
    RESOURCE_LIST_QUERY: 0x9205,
    RESOURCE_LIST_UPLOAD: 0x1205,
    REMOTE_PLAYBACK_REQUEST: 0x9201,
    FILE_UPLOAD_COMMAND: 0x9206,
    FILE_UPLOAD_COMPLETE: 0x1206,
    FILE_UPLOAD_CONTROL: 0x9207,
};

const MSG_ID_NAMES = Object.fromEntries(Object.entries(MSG_ID).map(([k, v]) => [v, k]));

/**
 * Parse ONE unescaped frame (header+body+checksum, no 0x7E flags) into a
 * structured result. Returns { ok:false, error } on checksum failure so
 * callers can decide whether to drop / request retransmission.
 */
function parseFrame(rawFrame) {
    if (rawFrame.length < 3) {
        return { ok: false, error: 'Frame too short' };
    }

    const payload = rawFrame.slice(0, rawFrame.length - 1);
    const receivedChecksum = rawFrame[rawFrame.length - 1];
    const computedChecksum = xorChecksum(payload);

    if (computedChecksum !== receivedChecksum) {
        return {
            ok: false,
            error: 'Checksum mismatch',
            receivedChecksum,
            computedChecksum,
        };
    }

    const { header, offset: bodyStart } = parseHeader(payload, 0);
    const bodyBuf = payload.slice(bodyStart);

    // Segmented messages: caller (tcpServer) is expected to buffer segments
    // by header.packetInfo and reassemble the body before calling
    // decodeBody() again on the concatenated body bytes; we still return the
    // raw segment body here so the caller can do that.
    const result = {
        crcValid: true,
        protocol: PROTOCOL,

        msgId: header.msgId,
        msgIdHex: header.msgIdHex,

        imei: header.imei,
        msgSeq: header.msgSeq,
        isV2019: header.attrs.isV2019,
        segmented: header.attrs.segmented,
        packetInfo: header.packetInfo,
        rawBody: bodyBuf,
    };

    if (!header.attrs.segmented) {
        try {
            Object.assign(result, decodeBody(header.msgId, bodyBuf, header));
        } catch (err) {
            // Some real-world devices send shorter/non-standard bodies than the
            // spec tables describe (see README "Known deviations"). Never let a
            // malformed/truncated body crash the whole connection - surface it
            // as UNHANDLED with the decode error attached instead.
            result.type = 'UNHANDLED';
            result.decodeError = err.message;
        }
    } else {
        result.type = 'SEGMENT';
        result.needsReassembly = true;
    }

    return result;
}

/** Decode a (fully reassembled) message body by msgId. */
function decodeBody(msgId, bodyBuf, header) {
    switch (msgId) {
        case MSG_ID.GENERAL_TERMINAL_RESPONSE:
        case MSG_ID.GENERAL_PLATFORM_RESPONSE:
            return { type: 'GENERAL_RESPONSE', data: body.decodeGeneralResponse(bodyBuf) };

        case MSG_ID.TERMINAL_HEARTBEAT:
            return { type: 'HEARTBEAT', data: {} };

        case MSG_ID.TERMINAL_DEREGISTRATION:
            return { type: 'DEREGISTRATION', data: {} };

        case MSG_ID.TERMINAL_REGISTRATION:
            return { type: 'REGISTRATION', data: body.decodeRegistration(bodyBuf, header.attrs.isV2019) };

        case MSG_ID.TERMINAL_AUTHENTICATION:
            return { type: 'AUTHENTICATION', data: body.decodeAuthentication(bodyBuf, header.attrs.isV2019) };

        case MSG_ID.REGISTRATION_RESPONSE:
            return { type: 'REGISTRATION_RESPONSE', data: body.decodeRegistrationResponse(bodyBuf) };

        case MSG_ID.PASSTHROUGH_DOWNLINK:
        case MSG_ID.PASSTHROUGH_UPLINK:
            return { type: 'PASSTHROUGH', data: body.decodePassThrough(bodyBuf) };

        case MSG_ID.LOCATION_REPORT:
            return { type: 'LOCATION', data: body.decodeLocationReport(bodyBuf) };

        case MSG_ID.LOCATION_QUERY_RESPONSE: {
            const replySeq = bodyBuf.readUInt16BE(0);
            const data = body.decodeLocationReport(bodyBuf.slice(2));
            return { type: 'LOCATION_QUERY_RESPONSE', data: { replySeq, ...data } };
        }

        case MSG_ID.BATCH_LOCATION_UPLOAD:
            return { type: 'LOCATION_BATCH', data: decodeBatchLocation(bodyBuf) };

        default:
            return { type: 'UNHANDLED', data: { raw: bodyBuf } };
    }
}

/** 4.3.4 Batch Location Data Upload (0x0704) */
function decodeBatchLocation(buf) {
    const count = buf.readUInt16BE(0);
    const dataType = buf.readUInt8(2); // 0 regular, 2 buffered (dead-zone)
    const records = [];
    let o = 3;
    for (let i = 0; i < count && o + 2 <= buf.length; i++) {
        const len = buf.readUInt16BE(o); o += 2;
        const recordBuf = buf.slice(o, o + len); o += len;
        records.push(body.decodeLocationReport(recordBuf));
    }
    return { count, dataType: dataType === 2 ? 'buffered (dead-zone)' : 'regular', records };
}

/**
 * Process a raw TCP chunk. Returns { messages, remainder } - remainder
 * should be prepended to the next chunk (handles frames split across
 * multiple TCP reads).
 */
function decode(streamBuffer) {
    const { frames, remainder } = extractFrames(streamBuffer);
    const messages = frames.map(parseFrame);
    return { messages, remainder };
}

// -----------------------------------------------------------------------
// Outbound message builders
// -----------------------------------------------------------------------

/** Wrap an assembled header+body buffer with checksum + escaping + flags. */
function finalizeFrame(headerAndBody) {
    const checksum = xorChecksum(headerAndBody);
    const withChecksum = Buffer.concat([headerAndBody, Buffer.from([checksum])]);
    const escaped = escapeFrame(withChecksum);
    return Buffer.concat([Buffer.from([FLAG]), escaped, Buffer.from([FLAG])]);
}

/**
 * 4.1.2 General Platform Response (0x8001) - what the server sends back to
 * acknowledge almost everything the terminal sends (heartbeats, location
 * reports, registration follow-ups, etc.)
 *
 * @param {string} imei          15-digit device IMEI
 * @param {number} outSeq        our own outbound message sequence number
 * @param {number} replySeq      msgSeq of the terminal message being ack'd
 * @param {number} replyMsgId    msgId of the terminal message being ack'd
 * @param {number} [result=0]    0 success, 1 fail, 2 msg error, 3 unsupported, 4 alarm ack
 * @param {boolean} [isV2019=false]
 */
function buildGeneralPlatformResponse(imei, outSeq, replySeq, replyMsgId, result = 0, isV2019 = false) {
    const bodyBuf = Buffer.alloc(5);
    bodyBuf.writeUInt16BE(replySeq, 0);
    bodyBuf.writeUInt16BE(replyMsgId, 2);
    bodyBuf.writeUInt8(result, 4);

    const headerBuf = buildHeader({
        msgId: MSG_ID.GENERAL_PLATFORM_RESPONSE,
        imei,
        msgSeq: outSeq,
        isV2019,
        bodyLength: bodyBuf.length,
    });

    return finalizeFrame(Buffer.concat([headerBuf, bodyBuf]));
}

/**
 * 4.1.4 Terminal Registration Response (0x8100).
 * @param {number} result 0 success, 1 vehicle already registered,
 *   2 no such vehicle, 3 terminal already registered, 4 no such terminal
 * @param {string} [authCode] required (ASCII) when result === 0
 */
function buildRegistrationResponse(imei, outSeq, replySeq, result = 0, authCode = '', isV2019 = false) {
    const authBuf = result === 0 ? Buffer.from(authCode, 'ascii') : Buffer.alloc(0);
    const bodyBuf = Buffer.concat([
        (() => {
            const b = Buffer.alloc(3);
            b.writeUInt16BE(replySeq, 0);
            b.writeUInt8(result, 2);
            return b;
        })(),
        authBuf,
    ]);

    const headerBuf = buildHeader({
        msgId: MSG_ID.REGISTRATION_RESPONSE,
        imei,
        msgSeq: outSeq,
        isV2019,
        bodyLength: bodyBuf.length,
    });

    return finalizeFrame(Buffer.concat([headerBuf, bodyBuf]));
}

module.exports = {
    PROTOCOL,
    DEFAULT_PORT,
    extractFrames,
    MSG_ID,
    MSG_ID_NAMES,
    parseFrame,
    decodeBody,
    decode,
    buildGeneralPlatformResponse,
    buildRegistrationResponse,
    finalizeFrame,
};