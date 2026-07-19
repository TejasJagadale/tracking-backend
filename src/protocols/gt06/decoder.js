const { crc16X25 } = require('./crc');
const { createNormalizedGpsData } = require('../../core/DataModel');

const PROTOCOL = 'GT06';
const DEFAULT_PORT = Number(process.env.GT06_TCP_PORT || 5023);

const START_STANDARD = Buffer.from([0x78, 0x78]);
const START_EXTENDED = Buffer.from([0x79, 0x79]);
const STOP = Buffer.from([0x0d, 0x0a]);

const PROTOCOL_NUMBER = {
  LOGIN: 0x01,
  GPS_LOCATION: 0x12,
  GPS_LBS_STATUS_1: 0x16, // GPS + LBS + alarm/status (extended)
  HEARTBEAT: 0x13,
  GPS_LBS_STATUS_2: 0x22, // GPS + LBS (some firmwares)
  ALARM: 0x26,
};

/**
 * Splits a running TCP byte stream into complete GT06 frames.
 * GT06 frames are self-delimited (0x78 0x78 ... 0x0D 0x0A), so we scan for a
 * start marker, read the declared length, and slice out exactly that frame.
 * Any leftover partial bytes are returned so the caller can prepend them to
 * the next `data` event.
 *
 * @param {Buffer} buffer accumulated bytes for one socket
 * @returns {{ frames: Buffer[], rest: Buffer }}
 */
function extractFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const remaining = buffer.length - offset;

    const isStandardStart =
      remaining >= 2 && buffer[offset] === START_STANDARD[0] && buffer[offset + 1] === START_STANDARD[1];
    const isExtendedStart =
      remaining >= 2 && buffer[offset] === START_EXTENDED[0] && buffer[offset + 1] === START_EXTENDED[1];

    if (!isStandardStart && !isExtendedStart) {
      // Not aligned on a start marker - drop this byte and keep scanning.
      // This self-heals if the stream ever gets out of sync.
      offset += 1;
      continue;
    }

    const lengthFieldSize = isExtendedStart ? 2 : 1;
    const headerSize = 2 + lengthFieldSize; // start bytes + length field
    if (remaining < headerSize + 1) break; // not enough bytes yet for length + at least protocol number

    const contentLength = isExtendedStart
      ? buffer.readUInt16BE(offset + 2)
      : buffer.readUInt8(offset + 2);

    // contentLength counts everything after the length field up to (not including) stop bits:
    // protocol number + content + serial(2) + crc(2)
    const frameTotalLength = headerSize + contentLength + STOP.length;

    if (remaining < frameTotalLength) break; // wait for more data

    const frame = buffer.subarray(offset, offset + frameTotalLength);

    const hasStop =
      frame[frame.length - 2] === STOP[0] && frame[frame.length - 1] === STOP[1];

    if (hasStop) {
      frames.push(frame);
      offset += frameTotalLength;
    } else {
      // Length field lied or stream corrupted - resync by one byte.
      offset += 1;
    }
  }

  return { frames, rest: buffer.subarray(offset) };
}

function bcdToImei(bcdBuffer) {
  // Standard GT06 login content encodes IMEI as 8 bytes BCD = 16 nibbles.
  // Real IMEIs are 15 digits, so the leading nibble is typically a padding
  // zero which we strip.
  let digits = '';
  for (const byte of bcdBuffer) {
    digits += ((byte >> 4) & 0x0f).toString();
    digits += (byte & 0x0f).toString();
  }
  return digits.replace(/^0+(?=\d{15}$)/, '') || digits;
}

function buildAck(protocolNumber, serial) {
  // 0x78 0x78 [len] [protocol] [serial:2] [crc:2] 0x0D 0x0A
  // len = protocol(1) + serial(2) + crc(2) = 5
  const body = Buffer.alloc(5);
  body[0] = protocolNumber;
  body.writeUInt16BE(serial, 1);
  const crc = crc16X25(Buffer.concat([Buffer.from([0x05]), body]));
  body.writeUInt16BE(crc, 3);

  return Buffer.concat([
    START_STANDARD,
    Buffer.from([0x05]),
    body,
    STOP,
  ]);
}

function verifyCrc(frame, isExtended) {
  const lengthFieldSize = isExtended ? 2 : 1;
  const headerSize = 2 + lengthFieldSize;
  const crcOffset = frame.length - STOP.length - 2;
  const expectedCrc = frame.readUInt16BE(crcOffset);
  // CRC covers [length field(s) ... up to but excluding the CRC bytes]
  const crcInput = frame.subarray(2, crcOffset);
  const computedCrc = crc16X25(crcInput);
  return expectedCrc === computedCrc;
}

/**
 * Parses the Course/Status word from a GT06 location packet.
 * NOTE: bit assignment for N/S and E/W sign flags varies slightly between
 * GT06 firmware forks in the wild. This implements the mapping used by the
 * majority of published Concox/GT06 reference decoders. If a specific
 * device's coordinates come out mirrored, flip the corresponding sign check
 * here after validating against a real packet capture from that device.
 */
function parseCourseStatus(word) {
  const course = word & 0x03ff; // bits 0-9
  const gpsPositioned = Boolean((word >> 12) & 0x1); // bit 12
  const isSouth = Boolean((word >> 10) & 0x1); // bit 10: 1 = South
  const isWest = Boolean((word >> 11) & 0x1); // bit 11: 1 = West
  return { course, gpsPositioned, isSouth, isWest };
}

function parseLocationContent(content) {
  let o = 0;
  const year = 2000 + content.readUInt8(o); o += 1;
  const month = content.readUInt8(o); o += 1;
  const day = content.readUInt8(o); o += 1;
  const hour = content.readUInt8(o); o += 1;
  const minute = content.readUInt8(o); o += 1;
  const second = content.readUInt8(o); o += 1;

  const gpsInfoByte = content.readUInt8(o); o += 1;
  const satellites = gpsInfoByte & 0x0f;

  const rawLat = content.readUInt32BE(o); o += 4;
  const rawLon = content.readUInt32BE(o); o += 4;

  const speedKmh = content.readUInt8(o); o += 1;

  const courseStatusWord = content.readUInt16BE(o); o += 2;
  const { course, isSouth, isWest } = parseCourseStatus(courseStatusWord);

  let latitude = rawLat / 1800000;
  let longitude = rawLon / 1800000;
  if (isSouth) latitude = -latitude;
  if (isWest) longitude = -longitude;

  const gpsTimestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return {
    latitude,
    longitude,
    speedKmh,
    heading: course,
    satellites,
    gpsTimestamp,
  };
}

function parseHeartbeatContent(content) {
  // Terminal Info byte: bit1 = ACC high(1)/low(0), other bits = alarm/charging/defense flags
  const terminalInfo = content.readUInt8(0);
  const ignition = Boolean((terminalInfo >> 1) & 0x1);
  const voltageLevel = content.length > 1 ? content.readUInt8(1) : null; // 0-6 scale, device-relative
  const gsmSignal = content.length > 2 ? content.readUInt8(2) : null; // 0-4 scale
  return { ignition, batteryLevel: voltageLevel, gsmSignal };
}

/**
 * Parses one already-extracted GT06 frame.
 * @returns {{
 *   type: 'LOGIN'|'LOCATION'|'HEARTBEAT'|'UNKNOWN',
 *   imei: string|null,
 *   serial: number,
 *   crcValid: boolean,
 *   normalized: object|null,
 *   ack: Buffer,
 *   protocolNumberHex: string
 * }}
 */
function parseFrame(frame) {
  const isExtended = frame[0] === START_EXTENDED[0] && frame[1] === START_EXTENDED[1];
  const lengthFieldSize = isExtended ? 2 : 1;
  const headerSize = 2 + lengthFieldSize;

  const protocolNumber = frame.readUInt8(headerSize);
  const crcValid = verifyCrc(frame, isExtended);

  const contentStart = headerSize + 1;
  const contentEnd = frame.length - STOP.length - 2 - 2; // minus crc(2) minus serial(2)
  const content = frame.subarray(contentStart, contentEnd);
  const serial = frame.readUInt16BE(frame.length - STOP.length - 2 - 2);

  const protocolNumberHex = `0x${protocolNumber.toString(16).padStart(2, '0')}`;

  const base = { serial, crcValid, protocolNumberHex, ack: buildAck(protocolNumber, serial) };

  if (!crcValid) {
    return { ...base, type: 'UNKNOWN', imei: null, normalized: null };
  }

  switch (protocolNumber) {
    case PROTOCOL_NUMBER.LOGIN: {
      const imei = bcdToImei(content.subarray(0, 8));
      return { ...base, type: 'LOGIN', imei, normalized: null };
    }
    case PROTOCOL_NUMBER.GPS_LOCATION:
    case PROTOCOL_NUMBER.GPS_LBS_STATUS_1:
    case PROTOCOL_NUMBER.GPS_LBS_STATUS_2:
    case PROTOCOL_NUMBER.ALARM: {
      const parsed = parseLocationContent(content);
      const normalized = createNormalizedGpsData({
        protocol: PROTOCOL,
        ...parsed,
        raw: { protocolNumberHex },
      });
      return { ...base, type: 'LOCATION', imei: null, normalized };
    }
    case PROTOCOL_NUMBER.HEARTBEAT: {
      const parsed = parseHeartbeatContent(content);
      return { ...base, type: 'HEARTBEAT', imei: null, normalized: parsed };
    }
    default:
      return { ...base, type: 'UNKNOWN', imei: null, normalized: null };
  }
}

module.exports = {
  PROTOCOL,
  DEFAULT_PORT,
  PROTOCOL_NUMBER,
  extractFrames,
  parseFrame,
  buildAck,
};
