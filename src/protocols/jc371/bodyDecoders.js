'use strict';

const { bcdToDate } = require('./utils');

// ---------------------------------------------------------------------
// 4.1.1 / 4.1.2 General Response (terminal 0x0001 / platform 0x8001)
// Identical layout, different direction.
// ---------------------------------------------------------------------
function decodeGeneralResponse(body) {
  return {
    replySeq: body.readUInt16BE(0),
    responseId: body.readUInt16BE(2),
    responseIdHex: '0x' + body.readUInt16BE(2).toString(16).padStart(4, '0'),
    result: body.readUInt8(4), // 0 success, 1 fail, 2 msg error, 3 not supported, (4 alarm ack for 0x8001 only)
  };
}

// ---------------------------------------------------------------------
// 4.1.4 Terminal Registration (0x0100) - handles both v2011 and v2019
// field widths since callers pass header.attrs.isV2019.
// ---------------------------------------------------------------------
function decodeRegistration(body, isV2019) {
  let o = 0;
  const provinceId = body.readUInt16BE(o); o += 2;
  const cityId = body.readUInt16BE(o); o += 2;

  const manuLen = isV2019 ? 11 : 5;
  const manufacturerId = body.slice(o, o + manuLen).toString('ascii').replace(/\0+$/, ''); o += manuLen;

  const modelLen = isV2019 ? 30 : 20;
  const deviceModel = body.slice(o, o + modelLen).toString('ascii').replace(/\0+$/, ''); o += modelLen;

  const termIdLen = isV2019 ? 30 : 7;
  const terminalId = body.slice(o, o + termIdLen).toString('ascii').replace(/\0+$/, ''); o += termIdLen;

  const plateColor = body.readUInt8(o); o += 1;
  const plateNumber = body.slice(o, o + 21).toString('ascii').replace(/\0+$/, ''); o += 21;

  return { provinceId, cityId, manufacturerId, deviceModel, terminalId, plateColor, plateNumber };
}

function decodeRegistrationResponse(body) {
  const replySeq = body.readUInt16BE(0);
  const result = body.readUInt8(2);
  const authCode = result === 0 ? body.slice(3).toString('ascii').replace(/\0+$/, '') : null;
  return { replySeq, result, authCode };
}

// ---------------------------------------------------------------------
// 4.1.6 Terminal Authentication (0x0102)
// ---------------------------------------------------------------------
function decodeAuthentication(body, isV2019) {
  if (!isV2019) {
    return { authCode: body.toString('ascii').replace(/\0+$/, '') };
  }
  const codeLen = body.readUInt8(0);
  let o = 1;
  const authCode = body.slice(o, o + codeLen).toString('ascii'); o += codeLen;
  const terminalImei = body.slice(o, o + 15).toString('ascii').replace(/\0+$/, ''); o += 15;
  const softwareVersion = body.slice(o, o + 20).toString('ascii').replace(/\0+$/, '');
  return { authCode, terminalImei, softwareVersion };
}

// ---------------------------------------------------------------------
// 4.2.7 Pass-through (0x8900 downlink / 0x0900 uplink)
// ---------------------------------------------------------------------
function decodePassThrough(body) {
  const type = body.readUInt8(0);
  const content = body.slice(1);
  return {
    type,
    typeHex: '0x' + type.toString(16).padStart(2, '0'),
    content,
    // 0xF0 user-defined online commands are plain ASCII (e.g. "VERSION#")
    contentAscii: type === 0xf0 ? content.toString('ascii') : undefined,
  };
}

// =======================================================================
// 4.3.1 Location Reporting (0x0200) + Chapter 7 supplementary information
// =======================================================================

const ALARM_FLAG_BITS = {
  0: 'Emergency alert (SOS button)',
  1: 'Overspeed alert',
  2: 'Fatigue driving',
  3: 'Pre-alert',
  4: 'GNSS module failure',
  5: 'GNSS antenna unconnected or cut',
  6: 'GNSS antenna shorted',
  7: 'Main power supply undervoltage',
  8: 'Main power supply failure',
  9: 'LCD or monitor failure',
  10: 'TTS module failure',
  11: 'Camera failure',
  18: 'Excessive accumulated daily driving time',
  19: 'Parking overtime',
  20: 'Geofence entry/exit alert',
  21: 'Route entry/exit alert',
  22: 'Insufficient/excessive driving time in road segment',
  23: 'Deviate from route',
  24: 'VSS fault',
  25: 'Fuel level exception',
  26: 'Vehicle being stolen (anti-theft device)',
  27: 'Unauthorized ignition on',
  28: 'Unauthorized movement',
};

const STATUS_BITS = {
  0: { name: 'acc', on: 'ON', off: 'OFF' },
  1: { name: 'positionFix', on: 'Position fix acquired', off: 'No position fix' },
  2: { name: 'latitudeHemisphere', on: 'North', off: 'South' },
  3: { name: 'longitudeHemisphere', on: 'West', off: 'East' },
  4: { name: 'operational', on: 'Non-operational', off: 'Operational' },
  5: { name: 'coordinatesEncrypted', on: 'Encrypted', off: 'Unencrypted' },
  10: { name: 'fuelSystem', on: 'Disconnected', off: 'Normal' },
  11: { name: 'electricalSystem', on: 'Disconnected', off: 'Normal' },
  12: { name: 'door', on: 'Locked', off: 'Unlocked' },
};

function decodeAlarmFlags(dword) {
  const active = [];
  for (const bit of Object.keys(ALARM_FLAG_BITS)) {
    if ((dword >> Number(bit)) & 1) active.push({ bit: Number(bit), description: ALARM_FLAG_BITS[bit] });
  }
  return { raw: dword >>> 0, active };
}

function decodeStatusBits(dword) {
  const decoded = {};
  for (const bit of Object.keys(STATUS_BITS)) {
    const def = STATUS_BITS[bit];
    const isSet = ((dword >> Number(bit)) & 1) === 1;
    decoded[def.name] = isSet ? def.on : def.off;
  }
  return { raw: dword >>> 0, ...decoded };
}

/**
 * Table 7-8: E8 Extended Alarm supplementary-info structure.
 *   alarmId(WORD) + idLen(BYTE) + [alarm/event ID block if idLen==16]
 *   + suppLen(BYTE) + [nested ID(WORD)+len(BYTE)+content(len) ...]
 */
function decodeE8ExtendedAlarm(buf) {
  let o = 0;
  const alarmId = buf.readUInt16BE(o); o += 2;
  const idLen = buf.readUInt8(o); o += 1;

  let alarmEventId = null;
  if (idLen === 16) {
    const terminalId = buf.slice(o, o + 7).toString('ascii').replace(/\0+$/, ''); o += 7;
    const dateTime = bcdToDate(buf.slice(o, o + 6)); o += 6;
    const serialNo = buf.readUInt8(o); o += 1;
    const attachmentCount = buf.readUInt8(o); o += 1;
    o += 1; // reserved
    alarmEventId = { terminalId, dateTime, serialNo, attachmentCount };
  } else if (idLen > 0) {
    o += idLen; // unknown-length ID block, skip
  }

  const suppLen = buf.readUInt8(o); o += 1;
  const suppEnd = o + suppLen;
  const supplementary = [];
  while (o < suppEnd && o < buf.length) {
    const subId = buf.readUInt16BE(o); o += 2;
    const subLen = buf.readUInt8(o); o += 1;
    const content = buf.slice(o, o + subLen); o += subLen;
    supplementary.push(decodeE8SubItem(subId, content));
  }

  let category = 'unknown';
  if (alarmId >= 0x0001 && alarmId <= 0x03ff) category = 'video';
  else if (alarmId >= 0x0400 && alarmId <= 0x0bff) category = 'location/driving';
  else if (alarmId >= 0x0c00 && alarmId <= 0x0fff) category = 'basic';

  return {
    alarmId,
    alarmIdHex: '0x' + alarmId.toString(16).padStart(4, '0'),
    category,
    description: E8_ALARM_NAMES[alarmId] || null,
    alarmEventId,
    supplementary,
  };
}

const E8_ALARM_NAMES = {
  0x0001: 'Camera failure',
  0x0002: 'Camera obstructed',
  0x0003: 'Seatbelt unfastened (ANWSB)',
  0x0004: 'Seatbelt fastened (AWSB)',
  0x0005: 'Face ID failed (AFIF)',
  0x0006: 'Face ID succeeded (AFIS)',
  0x0007: 'Eyes closed',
  0x0008: 'Yawning',
  0x0009: 'Face alignment failed',
  0x000a: 'Face lost',
  0x000b: 'Drinking',
  0x000c: 'Driver changed',
  0x0400: 'Harsh acceleration',
  0x0401: 'Harsh braking',
  0x0402: 'Sharp cornering',
  0x0403: 'Overspeed',
  0x0404: 'Excessive driving time',
  0x0405: 'Driving collision',
  0x0406: 'Parking vibration',
  0x0407: 'Towing',
  0x0408: 'Geofence entry',
  0x0409: 'Geofence exit',
  0x040a: 'Left turn alarm',
  0x040b: 'Right turn alarm',
  0x040c: 'Door open alarm',
  0x040d: 'Door close alarm',
  0x0410: 'Sleep mode event',
  0x0411: 'Working mode event',
  0x0412: 'UBI harsh acceleration',
  0x0413: 'UBI harsh braking',
  0x0414: 'UBI sharp cornering',
  0x0415: 'UBI sudden lane change',
  0x0416: 'UBI collision',
  0x0417: 'UBI rollover',
  0x0418: 'UBI abnormal attitude',
  0x0419: 'UBI abnormal Euler',
  0x0c01: 'SOS emergency alert',
  0x0c02: 'Low external battery alert',
  0x0c03: 'ACC ON',
  0x0c04: 'ACC OFF',
  0x0c05: 'Theft alarm',
  0x0c06: 'DMS calibration error',
  0x0c07: 'Identity recognition alert',
  0x0c08: 'Door alert',
  0x0c09: 'Fuel sensor abnormal alert',
  0x0c0a: 'Temperature/humidity abnormal alert',
  0x0c0b: 'Card login alert (DLT)',
  0x0c0c: 'Card logout alert (DLT)',
  0x0c0d: 'Unauthorized card alert (DLT)',
  0x0c0e: 'Power failure alert',
  0x0c0f: 'Low internal battery alert',
  0x0c10: 'Shutdown (due to low battery) alert',
  0x0c11: 'Ambient sound alert',
  0x0c12: 'Tamper alert',
  0x0c13: 'Active offline alert',
  0x0c14: 'SD/TF card inserted or mounted',
  0x0c15: 'SD/TF card not inserted or removed',
  0x0c16: 'SD/TF card write error',
  0x0c17: 'Data overage alert',
  0x0c1a: 'Failed to download audio file from specified HTTP URL',
};

/**
 * Sub-IDs nested inside 0xE8's supplementary-info list (Section 7.3.x).
 * These are themselves WORD-identified: 0x2002 (status), 0x2003 (terminal
 * status v1), 0x2005 (terminal status v2, ID-keyed list), 0x2006/0x2007
 * (peripheral info / passthrough).
 */
function decodeE8SubItem(subId, content) {
  switch (subId) {
    case 0x2002:
      return {
        subId,
        subIdHex: '0x2002',
        name: 'Location Data Status',
        uploadMode: content.readUInt8(0),
        realtimeOrBuffered: content.readUInt8(1) === 0 ? 'real-time' : 'buffered',
      };
    case 0x2003:
      return {
        subId,
        subIdHex: '0x2003',
        name: 'Terminal Status Information',
        chargingStatus: content.readUInt8(0) === 1 ? 'charging' : 'not charging',
        internalBatteryLevelCode: content.readUInt8(1),
        batteryVoltage: content.readUInt16BE(2) / 100,
        cellularSignalStrength: content.readUInt8(4),
        externalBatteryVoltage: content.readUInt16BE(5) / 100,
      };
    case 0x2005:
      return { subId, subIdHex: '0x2005', name: 'Terminal Status Information (ID-keyed)', items: decodeIdKeyedList(content) };
    case 0x2006:
      return { subId, subIdHex: '0x2006', name: 'Peripheral Information', items: decodeIdKeyedList(content) };
    case 0x2007:
      return { subId, subIdHex: '0x2007', name: 'Peripheral Raw Data Pass-Through', items: decodeIdKeyedList(content) };
    default:
      return { subId, subIdHex: '0x' + subId.toString(16).padStart(4, '0'), raw: content };
  }
}

/** Generic WORD-id + BYTE-len + content list used by 0x2005/0x2006/0x2007 */
function decodeIdKeyedList(buf) {
  const items = [];
  let o = 0;
  while (o + 3 <= buf.length) {
    const id = buf.readUInt16BE(o); o += 2;
    const len = buf.readUInt8(o); o += 1;
    const content = buf.slice(o, o + len); o += len;
    items.push({ id, idHex: '0x' + id.toString(16).padStart(4, '0'), content });
  }
  return items;
}

/**
 * Table 7-4/7-7 ADAS (0x64) / DMS (0x65) alarm bodies share the same
 * head+tail shape; alert-type-specific middle fields are captured raw
 * since their meaning depends on the alert-type byte at offset 5.
 */
function decodeAdasDmsAlarm(buf) {
  const alertId = buf.readUInt32BE(0);
  const statusFlag = buf.readUInt8(4);
  const alertType = buf.readUInt8(5);
  const alertLevel = buf.readUInt8(6);
  // Bytes 7-12 vary by alertType per the spec tables - exposed as raw.
  const typeSpecific = buf.slice(7, 13);
  const vehicleSpeed = buf.readUInt8(12);
  const elevation = buf.readUInt16BE(13);
  const latitude = buf.readInt32BE(15) / 1e6; // v1.5.2: INT32 (was DWORD)
  const longitude = buf.readInt32BE(19) / 1e6; // v1.5.2: INT32 (was DWORD)
  const dateTime = bcdToDate(buf.slice(23, 29));
  const vehicleStatus = buf.readUInt16BE(29);
  const alertIdBlock =
    buf.length >= 31 + 16
      ? {
          terminalId: buf.slice(31, 38).toString('ascii').replace(/\0+$/, ''),
          dateTime: bcdToDate(buf.slice(38, 44)),
          serialNo: buf.readUInt8(44),
          attachmentCount: buf.readUInt8(45),
        }
      : null;

  return {
    alertId,
    statusFlag, // 0x00 unavailable, 0x01 start, 0x02 end
    alertType,
    alertLevel, // 1 = L1, 2 = L2
    typeSpecificRaw: typeSpecific,
    vehicleSpeed,
    elevation,
    latitude,
    longitude,
    dateTime,
    vehicleStatus,
    alertIdBlock,
  };
}

/**
 * Full 0x0200 Location Reporting body: fixed 28-byte block + supplementary
 * information item list (ID/len/content, repeated to end of body).
 */
function decodeLocationReport(body) {
  const alarmFlag = decodeAlarmFlags(body.readUInt32BE(0));
  const status = decodeStatusBits(body.readUInt32BE(4));
  const latitude = body.readInt32BE(8) / 1e6;
  const longitude = body.readInt32BE(12) / 1e6;
  const elevation = body.readUInt16BE(16);
  const speed = body.readUInt16BE(18) / 10; // km/h
  const heading = body.readUInt16BE(20);
  // NOTE: Table 4-21 prints "Date/time" as starting at byte 21, but that
  // overlaps the preceding WORD "Heading" field (bytes 20-21) and produces
  // invalid dates (e.g. month 17) against the spec's own worked example in
  // Section 4.3.1. Byte 22 is the offset that actually reproduces that
  // example's date (2017-03-07 10:51:01) correctly, so the fixed block is
  // 28 bytes (0-27) and supplementary items start at byte 28.
  const dateTime = bcdToDate(body.slice(22, 28));

  const supplementary = [];
  let o = 28;
  while (o + 2 <= body.length) {
    const id = body.readUInt8(o); o += 1;
    const len = body.readUInt8(o); o += 1;
    const content = body.slice(o, o + len); o += len;
    supplementary.push(decodeSupplementaryItem(id, content));
  }

  return { alarmFlag, status, latitude, longitude, elevation, speed, heading, dateTime, supplementary };
}

function decodeSupplementaryItem(id, content) {
  const idHex = '0x' + id.toString(16).padStart(2, '0');
  switch (id) {
    case 0x01:
      return { id, idHex, name: 'Mileage', value: content.readUInt32BE(0) / 10, unit: 'km' };
    case 0x02:
      return { id, idHex, name: 'Fuel level', value: content.readUInt16BE(0) / 10, unit: 'L' };
    case 0x14:
      return { id, idHex, name: 'Video-related alarm', value: content.readUInt32BE(0) };
    case 0x15:
      return { id, idHex, name: 'Video signal loss alarm status', value: content.readUInt32BE(0) };
    case 0x17:
      return { id, idHex, name: 'Memory failure alarm status', value: content.readUInt16BE(0) };
    case 0x30:
      return { id, idHex, name: 'Radio network signal strength', value: content.readUInt8(0) };
    case 0x31:
      return { id, idHex, name: 'Number of positioning satellites', value: content.readUInt8(0) };
    case 0x64:
      return { id, idHex, name: 'ADAS alert', value: decodeAdasDmsAlarm(content) };
    case 0x65:
      return { id, idHex, name: 'DMS alert', value: decodeAdasDmsAlarm(content) };
    case 0xe8:
      return { id, idHex, name: 'E8 Extended alarm (custom)', value: decodeE8ExtendedAlarm(content) };
    case 0xeb:
      // Section 7.4's "ID / length / string" table describes the OUTER
      // item wrapper (already stripped by the caller's id/len/content
      // loop) - `content` here is just the raw ASCII timezone string,
      // e.g. "UTC+08:00", with no extra inner length byte.
      return {
        id,
        idHex,
        name: 'Timezone extension',
        value: content.toString('ascii'),
      };
    default:
      return { id, idHex, name: 'Unrecognized/manufacturer-specific', raw: content };
  }
}

module.exports = {
  decodeGeneralResponse,
  decodeRegistration,
  decodeRegistrationResponse,
  decodeAuthentication,
  decodePassThrough,
  decodeLocationReport,
  decodeAlarmFlags,
  decodeStatusBits,
  decodeE8ExtendedAlarm,
  decodeAdasDmsAlarm,
  decodeSupplementaryItem,
};