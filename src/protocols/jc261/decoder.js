const { crcItu } = require('./crc');
const { createNormalizedGpsData } = require('../../core/DataModel');

const PROTOCOL = 'JC261';
const DEFAULT_PORT = Number(process.env.JC261_TCP_PORT || 5029);

// This protocol uses two frame families (Section 4 / 5.5.2 / 5.6 / 5.7):
//   0x78 0x78 ... 0x0D 0x0A   with a 1-byte length field  -> login, heartbeat,
//                                 location, alarm, server->terminal commands
//   0x79 0x79 ... 0x0D 0x0A   with a 2-byte length field  -> terminal's reply
//                                 to server commands, 0x94/0x9B/0x9C packets
// We only need to decode packets the terminal sends unsolicited (login,
// heartbeat, location, alarm), all of which are the 0x78 0x78 / 1-byte-length
// family, so extractFrames focuses on that family. The 0x79 0x79 family is
// left for future extension (image/video/DVR features are out of POC scope).
const START = Buffer.from([0x78, 0x78]);
const STOP = Buffer.from([0x0d, 0x0a]);

const PROTOCOL_NUMBER = {
  LOGIN: 0x01,
  HEARTBEAT: 0x13,
  LOCATION: 0x22,
  ALARM: 0x95,
  ADDITIONAL_LOCATION: 0x37,
};

/**
 * Splits a running TCP byte stream into complete 0x78 0x78 ... 0x0D 0x0A
 * frames (Section 4: Data Packet Format). Length field is 1 byte, unlike
 * GT06's optional 2-byte extended variant.
 */
function extractFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const remaining = buffer.length - offset;

    const isStart = remaining >= 2 && buffer[offset] === START[0] && buffer[offset + 1] === START[1];
    if (!isStart) {
      offset += 1; // resync
      continue;
    }

    const headerSize = 3; // 2 start bytes + 1 length byte
    if (remaining < headerSize + 1) break;

    const contentLength = buffer.readUInt8(offset + 2); // protocol(1)+content+serial(2)+crc(2)
    const frameTotalLength = headerSize + contentLength + STOP.length;

    if (remaining < frameTotalLength) break; // wait for more bytes

    const frame = buffer.subarray(offset, offset + frameTotalLength);
    const hasStop = frame[frame.length - 2] === STOP[0] && frame[frame.length - 1] === STOP[1];

    if (hasStop) {
      frames.push(frame);
      offset += frameTotalLength;
    } else {
      offset += 1; // corrupted length field - resync
    }
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Terminal ID -> IMEI. Per Section 5.1.1 example: IMEI 123456789012345 packs
 * as 0x01 0x23 0x45 0x67 0x89 0x01 0x23 0x45 - i.e. digit pairs, left-padded
 * with a zero nibble since 8 bytes = 16 nibbles but IMEI is 15 digits.
 */
function terminalIdToImei(idBuffer) {
  let digits = '';
  for (const byte of idBuffer) {
    digits += ((byte >> 4) & 0x0f).toString();
    digits += (byte & 0x0f).toString();
  }
  return digits.replace(/^0+(?=\d{15}$)/, '') || digits;
}

function buildAck(protocolNumber, serial) {
  // Same ACK shape as the login/heartbeat response examples in the spec:
  // 0x78 0x78 [len=05] [protocol] [serial:2] [crc:2] 0x0D 0x0A
  const body = Buffer.alloc(5);
  body[0] = protocolNumber;
  body.writeUInt16BE(serial, 1);
  const crc = crcItu(Buffer.concat([Buffer.from([0x05]), body]));
  body.writeUInt16BE(crc, 3);
  return Buffer.concat([START, Buffer.from([0x05]), body, STOP]);
}

function verifyCrc(frame) {
  const crcOffset = frame.length - STOP.length - 2;
  const expectedCrc = frame.readUInt16BE(crcOffset);
  // Section 4.6: CRC covers Packet Length through Information Serial Number
  const crcInput = frame.subarray(2, crcOffset);
  return expectedCrc === crcItu(crcInput);
}

/** Course & Status word - Section 5.3 "Course & Status" table + worked example. */
function parseCourseStatus(word) {
  const byte1 = (word >> 8) & 0xff;
  const byte2 = word & 0xff;
  const course = ((byte1 & 0x03) << 8) | byte2; // 10-bit field
  const gpsPositioned = Boolean((byte1 >> 4) & 0x1);
  const isWest = Boolean((byte1 >> 3) & 0x1); // 1 = West, 0 = East
  const isNorth = Boolean((byte1 >> 2) & 0x1); // 1 = North, 0 = South
  return { course, gpsPositioned, isWest, isNorth };
}

function parseDateTime(buf, offset) {
  const year = 2000 + buf.readUInt8(offset);
  const month = buf.readUInt8(offset + 1);
  const day = buf.readUInt8(offset + 2);
  const hour = buf.readUInt8(offset + 3);
  const minute = buf.readUInt8(offset + 4);
  const second = buf.readUInt8(offset + 5);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** Location Data Packet (0x22) - Section 5.3 */
function parseLocationContent(content) {
  let o = 0;
  const gpsTimestamp = parseDateTime(content, o); o += 6;

  const satByte = content.readUInt8(o); o += 1; // low nibble = satellite count
  const satellites = satByte & 0x0f;

  const rawLat = content.readUInt32BE(o); o += 4;
  const rawLon = content.readUInt32BE(o); o += 4;

  const speedKmh = content.readUInt8(o); o += 1;

  const courseStatusWord = content.readUInt16BE(o); o += 2;
  const { course, isWest, isNorth } = parseCourseStatus(courseStatusWord);

  let latitude = rawLat / 1800000;
  let longitude = rawLon / 1800000;
  if (!isNorth) latitude = -latitude;
  if (isWest) longitude = -longitude;

  // LBS info - not part of the common normalized model but useful for debugging
  const mcc = content.readUInt16BE(o); o += 2;
  const mnc = content.readUInt8(o); o += 1;
  const lac = content.readUInt16BE(o); o += 2;
  const cellId = (content.readUInt8(o) << 16) | content.readUInt16BE(o + 1); o += 3;

  const accByte = content.readUInt8(o); o += 1;
  const ignition = accByte === 0x01;

  const uploadMode = content.readUInt8(o); o += 1;
  const realtimeFlag = content.readUInt8(o); o += 1;

  let mileage = null;
  if (o + 4 <= content.length) {
    mileage = content.readUInt32BE(o); o += 4;
  }

  return {
    gpsTimestamp,
    satellites,
    latitude,
    longitude,
    speedKmh,
    heading: course,
    ignition,
    raw: { mcc, mnc, lac, cellId, uploadMode, realtimeFlag, mileage },
  };
}

/** Heartbeat / Status packet (0x13) - Section 5.2 */
function parseHeartbeatContent(content) {
  const terminalInfo = content.readUInt8(0);
  const ignition = Boolean((terminalInfo >> 1) & 0x1); // Bit1: 1 = ACC high
  const gpsPositioned = Boolean((terminalInfo >> 6) & 0x1);
  const voltageLevel = content.length > 1 ? content.readUInt8(1) : null; // 0-6 scale
  const gsmSignal = content.length > 2 ? content.readUInt8(2) : null; // 0-4 scale
  return { ignition, gpsPositioned, batteryLevel: voltageLevel, gsmSignal };
}

/**
 * Alarm packet (0x95) - Section 5.4. Carries its own location fix plus an
 * alarm type/value. We normalize the location portion the same way as 0x22
 * so it flows through the same VehicleStatusEngine / storage pipeline, and
 * surface the alarm type separately for the caller to log/act on.
 */
function parseAlarmContent(content) {
  // bytes 0-1: special marking 0xFF 0xFF, byte 2: version
  let o = 3;
  const gpsTimestamp = parseDateTime(content, o); o += 6;

  const satByte = content.readUInt8(o); o += 1;
  const satellites = satByte & 0x0f;

  const rawLat = content.readUInt32BE(o); o += 4;
  const rawLon = content.readUInt32BE(o); o += 4;

  const courseStatusWord = content.readUInt16BE(o); o += 2;
  const { course, isWest, isNorth } = parseCourseStatus(courseStatusWord);

  const speedKmh = content.readUInt16BE(o); o += 2; // note: 2 bytes here, unlike 0x22's 1 byte

  let latitude = rawLat / 1800000;
  let longitude = rawLon / 1800000;
  if (!isNorth) latitude = -latitude;
  if (isWest) longitude = -longitude;

  const externalBatteryVoltage = content.readUInt16BE(o) / 10; o += 2;

  const alarmType = content.readUInt8(o); o += 1;
  const alarmTypeHex = `0x${alarmType.toString(16).padStart(2, '0')}`;

  return {
    gpsTimestamp,
    satellites,
    latitude,
    longitude,
    speedKmh,
    heading: course,
    raw: { externalBatteryVoltage, alarmType, alarmTypeHex },
  };
}

/**
 * @returns {{
 *   type: 'LOGIN'|'LOCATION'|'HEARTBEAT'|'ALARM'|'UNKNOWN',
 *   imei: string|null, serial: number, crcValid: boolean,
 *   normalized: object|null, ack: Buffer, protocolNumberHex: string
 * }}
 */
function parseFrame(frame) {
  const headerSize = 3; // start(2) + length(1)
  const protocolNumber = frame.readUInt8(headerSize);
  const crcValid = verifyCrc(frame);

  const contentStart = headerSize + 1;
  const contentEnd = frame.length - STOP.length - 2 - 2; // minus crc(2), serial(2)
  const content = frame.subarray(contentStart, contentEnd);
  const serial = frame.readUInt16BE(frame.length - STOP.length - 2 - 2);

  const protocolNumberHex = `0x${protocolNumber.toString(16).padStart(2, '0')}`;
  const base = { serial, crcValid, protocolNumberHex, ack: buildAck(protocolNumber, serial) };

  if (!crcValid) {
    return { ...base, type: 'UNKNOWN', imei: null, normalized: null };
  }

  switch (protocolNumber) {
    case PROTOCOL_NUMBER.LOGIN: {
      const imei = terminalIdToImei(content.subarray(0, 8));
      return { ...base, type: 'LOGIN', imei, normalized: null };
    }
    case PROTOCOL_NUMBER.HEARTBEAT: {
      const parsed = parseHeartbeatContent(content);
      return { ...base, type: 'HEARTBEAT', imei: null, normalized: parsed };
    }
    case PROTOCOL_NUMBER.LOCATION:
    case PROTOCOL_NUMBER.ADDITIONAL_LOCATION: {
      const parsed = parseLocationContent(content);
      const normalized = createNormalizedGpsData({ protocol: PROTOCOL, ...parsed });
      return { ...base, type: 'LOCATION', imei: null, normalized };
    }
    case PROTOCOL_NUMBER.ALARM: {
      const parsed = parseAlarmContent(content);
      const normalized = createNormalizedGpsData({ protocol: PROTOCOL, ...parsed });
      return { ...base, type: 'LOCATION', imei: null, normalized };
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
