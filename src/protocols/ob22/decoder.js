const { crc16X25 } = require('../gt06/crc'); // OB22 (Concox) uses the same CRC16/X25 as GT06
const { createNormalizedGpsData } = require('../../core/DataModel');

const PROTOCOL = 'OB22';
const DEFAULT_PORT = Number(process.env.OB22_TCP_PORT || 5030);

// Verified against the Concox GPS location packet spec (GPS location packet,
// section 3). Frame envelope + CRC are identical to GT06. Location content
// layout, protocol numbers (0x12 / 0x22), and the course/status bit meanings
// below are taken directly from that document - no longer guessed.
const START_STANDARD = Buffer.from([0x78, 0x78]);
const START_EXTENDED = Buffer.from([0x79, 0x79]);
const STOP = Buffer.from([0x0d, 0x0a]);

const PROTOCOL_NUMBER = {
  LOGIN: 0x01,
  GPS_LOCATION: 0x12,
  GPS_LOCATION_UTC: 0x22, // same content layout as 0x12, per vendor spec section 3.1
  GPS_LBS_STATUS: 0x16,
  HEARTBEAT: 0x13,
  ALARM: 0x26,
  // --- OBD-specific, still unverified - not in the location-packet spec we have ---
  OBD_DATA: 0x8a,
  IGNITION_ALARM: 0x94,
};

/**
 * Identical frame-splitting logic to GT06: self-delimited frames, 1-byte
 * length field on standard frames, 2-byte on extended frames.
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
      offset += 1; // resync
      continue;
    }

    const lengthFieldSize = isExtendedStart ? 2 : 1;
    const headerSize = 2 + lengthFieldSize;
    if (remaining < headerSize + 1) break;

    const contentLength = isExtendedStart
      ? buffer.readUInt16BE(offset + 2)
      : buffer.readUInt8(offset + 2);

    const frameTotalLength = headerSize + contentLength + STOP.length;
    if (remaining < frameTotalLength) break;

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

function bcdToImei(bcdBuffer) {
  let digits = '';
  for (const byte of bcdBuffer) {
    digits += ((byte >> 4) & 0x0f).toString();
    digits += (byte & 0x0f).toString();
  }
  return digits.replace(/^0+(?=\d{15}$)/, '') || digits;
}

function buildAck(protocolNumber, serial) {
  const lengthByte = Buffer.from([0x05]);
  const protoByte = Buffer.from([protocolNumber]);
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial, 0);

  const crcInput = Buffer.concat([lengthByte, protoByte, serialBuf]); // exactly 4 bytes, no CRC placeholder
  const crc = crc16X25(crcInput);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc, 0);

  return Buffer.concat([START_STANDARD, lengthByte, protoByte, serialBuf, crcBuf, STOP]);
}

function verifyCrc(frame, isExtended) {
  const lengthFieldSize = isExtended ? 2 : 1;
  const headerSize = 2 + lengthFieldSize;
  const crcOffset = frame.length - STOP.length - 2;
  const expectedCrc = frame.readUInt16BE(crcOffset);
  const crcInput = frame.subarray(2, crcOffset);
  const computedCrc = crc16X25(crcInput);
  return expectedCrc === computedCrc;
}

/**
 * Course & Status word (2 bytes, BYTE_1 high / BYTE_2 low).
 * Verified against the vendor's worked example (0x15 0x4C):
 *   BYTE_1 Bit4 = GPS positioned flag
 *   BYTE_1 Bit3 = 0 -> East, 1 -> West
 *   BYTE_1 Bit2 = 1 -> North, 0 -> South   (this was previously inverted)
 *   BYTE_1 Bit1..0 + BYTE_2 (all 8 bits) = course, 0-359
 */
function parseCourseStatus(word) {
  const course = word & 0x03ff;
  const gpsPositioned = Boolean((word >> 12) & 0x1);
  const isNorth = Boolean((word >> 10) & 0x1);
  const isWest = Boolean((word >> 11) & 0x1);
  return { course, gpsPositioned, isNorth, isWest };
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
  const { course, isNorth, isWest } = parseCourseStatus(courseStatusWord);

  let latitude = rawLat / 1800000;
  let longitude = rawLon / 1800000;
  if (!isNorth) latitude = -latitude; // Bit2: 1 = North, 0 = South
  if (isWest) longitude = -longitude; // Bit3: 0 = East, 1 = West

  const gpsTimestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Everything below (MCC/MNC/LAC/CellID/ACC/upload mode/mileage) is
  // optional per the spec ("Only available for devices with this
  // function"), so bail out gracefully if the content is shorter.
  let mcc = null, mnc = null, lac = null, cellId = null, ignition = null, mileageMeters = null;

  if (content.length >= o + 2) { mcc = content.readUInt16BE(o); o += 2; }
  if (content.length >= o + 1) { mnc = content.readUInt8(o); o += 1; }
  if (content.length >= o + 2) { lac = content.readUInt16BE(o); o += 2; }
  if (content.length >= o + 3) { cellId = content.readUIntBE(o, 3); o += 3; }
  if (content.length >= o + 1) {
    const accByte = content.readUInt8(o); o += 1;
    ignition = accByte === 1 ? true : accByte === 0 ? false : null; // spec: 00 low, 01 high
  }
  if (content.length >= o + 1) { o += 1; } // Data Upload Mode - not surfaced yet
  if (content.length >= o + 1) { o += 1; } // GPS Real-Time Re-upload flag - not surfaced yet
  if (content.length >= o + 4) { mileageMeters = content.readUInt32BE(o); o += 4; }

  return {
    latitude,
    longitude,
    speedKmh,
    heading: course,
    satellites,
    gpsTimestamp,
    ignition,
    mcc,
    mnc,
    lac,
    cellId,
    mileageMeters,
  };
}

function parseHeartbeatContent(content) {
  const terminalInfo = content.readUInt8(0);
  const ignition = Boolean((terminalInfo >> 1) & 0x1);
  const voltageLevel = content.length > 1 ? content.readUInt8(1) : null;
  const gsmSignal = content.length > 2 ? content.readUInt8(2) : null;
  return { ignition, batteryLevel: voltageLevel, gsmSignal };
}

/**
 * Still a placeholder - the doc we have covers the GPS location packet, not
 * the OBD-specific data messages (fuel/RPM/DTC). Leave this as raw-only
 * until we get a spec or capture for those specific protocol numbers.
 */
function parseObdContent(content) {
  return {
    raw: content.toString('hex'),
    note: 'OBD field layout unverified - capture a real packet to fill this in',
  };
}

function parseFrame(frame) {
  const isExtended = frame[0] === START_EXTENDED[0] && frame[1] === START_EXTENDED[1];
  const lengthFieldSize = isExtended ? 2 : 1;
  const headerSize = 2 + lengthFieldSize;

  const protocolNumber = frame.readUInt8(headerSize);
  const crcValid = verifyCrc(frame, isExtended);

  const contentStart = headerSize + 1;
  const contentEnd = frame.length - STOP.length - 2 - 2;
  const content = frame.subarray(contentStart, contentEnd);
  const serial = frame.readUInt16BE(frame.length - STOP.length - 2 - 2);

  const protocolNumberHex = `0x${protocolNumber.toString(16).padStart(2, '0')}`;
  const base = { serial, crcValid, protocolNumberHex, ack: buildAck(protocolNumber, serial) };

  if (!crcValid) {
    return { ...base, type: 'UNKNOWN', imei: null, normalized: null };
  }
console.log("parseFrame", protocolNumber, "contttetetetetet", content, "baseeeeeeeeeee", base)
  switch (protocolNumber) {

    
    case PROTOCOL_NUMBER.LOGIN: {
      const imei = bcdToImei(content.subarray(0, 8));
      return { ...base, type: 'LOGIN', imei, normalized: null };
    }
    case PROTOCOL_NUMBER.GPS_LOCATION:
    case PROTOCOL_NUMBER.GPS_LOCATION_UTC:
    case PROTOCOL_NUMBER.GPS_LBS_STATUS:
    case PROTOCOL_NUMBER.ALARM: {
      const parsed = parseLocationContent(content);
      const normalized = createNormalizedGpsData({ protocol: PROTOCOL, ...parsed, raw: { protocolNumberHex } });
      return { ...base, type: 'LOCATION', imei: null, normalized };
    }
    case PROTOCOL_NUMBER.HEARTBEAT: {
      const parsed = parseHeartbeatContent(content);
      return { ...base, type: 'HEARTBEAT', imei: null, normalized: parsed };
    }
    case PROTOCOL_NUMBER.OBD_DATA:
    case PROTOCOL_NUMBER.IGNITION_ALARM: {
      // Recognized-but-unverified message types: don't feed unverified fields
      // into LocationService yet, just surface them for inspection/logging.
      const parsed = parseObdContent(content);
      return { ...base, type: 'OBD_UNVERIFIED', imei: null, normalized: parsed };
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