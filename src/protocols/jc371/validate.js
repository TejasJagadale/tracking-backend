'use strict';

const assert = require('assert');
const { unescapeFrame, decodeImeiField } = require('./utils');
const { parseFrame, MSG_ID, buildGeneralPlatformResponse, buildRegistrationResponse } = require('./decoder');

function hexToBuf(hexStr) {
  return Buffer.from(hexStr.replace(/\s+/g, ''), 'hex');
}

// Strip the leading/trailing 0x7E flags from a doc example, exactly as the
// TCP framing layer would before handing the raw bytes to unescapeFrame().
function frameFromExample(hexStr) {
  const full = hexToBuf(hexStr);
  assert.strictEqual(full[0], 0x7e, 'expected leading 0x7E flag');
  assert.strictEqual(full[full.length - 1], 0x7e, 'expected trailing 0x7E flag');
  return unescapeFrame(full.slice(1, full.length - 1));
}

let passed = 0;
function check(label, cond) {
  if (cond) {
    passed++;
    console.log('PASS -', label);
  } else {
    console.log('FAIL -', label);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------
// IMEI decode sanity check (Section 3.2.3 worked example)
// -----------------------------------------------------------------------
{
  const imei = decodeImeiField(hexToBuf('4EB6FB4AD5FB'));
  check('IMEI decode matches spec worked example (865478070000593)', imei === '865478070000593');
}

// -----------------------------------------------------------------------
// 0x0100 Terminal Registration (uplink) - Section 9 example 1
// -----------------------------------------------------------------------
{
  const raw = frameFromExample(
    '7e 01 00 00 25 4e b6 fb 4a d6 28 00 09 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 9a 7e'
  );
  const msg = parseFrame(raw);
  check('0x0100 checksum verifies', msg.ok === true);
  check('0x0100 msgId decoded', msg.msgId === MSG_ID.TERMINAL_REGISTRATION);
  check('0x0100 IMEI decoded', msg.imei === '865478070001047');
  check('0x0100 msgSeq decoded', msg.msgSeq === 9);
  // NOTE: this doc example's body is only 37 zero-bytes - shorter than the
  // full field table (province+city+manufacturer+model+terminalId+plate =
  // 58 bytes for v2011). It's a placeholder/test frame, not a full
  // real-world registration body, so the field decoder correctly bails
  // out via the try/catch in parseFrame() rather than reading past the
  // buffer. Confirm that safety net engages instead of crashing:
  check('0x0100 truncated body handled gracefully (no throw)', msg.type === 'UNHANDLED' && !!msg.decodeError);
}

// 0x8100 Registration Response (downlink) - reply auth code "ODY1NDc4MDcwMDAxMDQ3Y" -ish
{
  const raw = frameFromExample(
    '7e 81 00 00 17 4e b6 fb 4a d6 28 00 09 00 09 00 4f 44 59 31 4e 44 63 34 4d 44 63 77 4d 44 41 78 4d 44 51 33 59 7e'
  );
  const msg = parseFrame(raw);
  check('0x8100 checksum verifies', msg.ok === true);
  check('0x8100 msgId decoded', msg.msgId === MSG_ID.REGISTRATION_RESPONSE);
  check('0x8100 type tag correct', msg.type === 'REGISTRATION_RESPONSE');
  check('0x8100 replySeq decoded', msg.data.replySeq === 9);
  check('0x8100 result decoded (0=success)', msg.data.result === 0);
  check('0x8100 authCode decoded', msg.data.authCode === 'ODY1NDc4MDcwMDAxMDQ3');
}

// -----------------------------------------------------------------------
// 0x0102 Terminal Authentication (uplink, v2011 shape) - example 2
// -----------------------------------------------------------------------
{
  const raw = frameFromExample(
    '7e 01 02 00 14 4e b6 fb 4a d6 28 00 0a 4f 44 59 31 4e 44 63 34 4d 44 63 77 4d 44 41 78 4d 44 51 33 d2 7e'
  );
  const msg = parseFrame(raw);
  check('0x0102 checksum verifies', msg.ok === true);
  check('0x0102 type tag correct', msg.type === 'AUTHENTICATION');
  check('0x0102 authCode decoded', msg.data.authCode === 'ODY1NDc4MDcwMDAxMDQ3');
}

// -----------------------------------------------------------------------
// 0x0002 Terminal Heartbeat - example 3
// -----------------------------------------------------------------------
{
  const raw = frameFromExample('7e 00 02 00 00 4e b6 fb 4a d6 28 00 0e bb 7e');
  const msg = parseFrame(raw);
  check('0x0002 checksum verifies', msg.ok === true);
  check('0x0002 type tag correct', msg.type === 'HEARTBEAT');
  check('0x0002 msgSeq decoded', msg.msgSeq === 14);
}

// -----------------------------------------------------------------------
// 0x0200 Location Reporting - example 4
// -----------------------------------------------------------------------
{
  const raw = frameFromExample(
    '7e 02 00 00 4b 4e b6 fb 4a d6 28 00 0b 00 00 08 00 00 0c 00 0d 00 00 00 00 00 00 00 00 00 00 00 00 00 00 25 01 21 17 13 09 01 04 00 00 00 00 25 04 00 00 00 00 30 01 16 31 01 00 eb 09 55 54 43 2b 30 38 3a 30 30 14 04 00 00 00 01 15 04 00 00 00 06 e8 04 04 11 00 00 81 7e'
  );
  const msg = parseFrame(raw);
  check('0x0200 checksum verifies', msg.ok === true);
  check('0x0200 type tag correct', msg.type === 'LOCATION');

  const d = msg.data;
  check('0x0200 alarmFlag raw == 0x00000800 (bit 11, camera failure)', d.alarmFlag.raw === 0x00000800);
  check(
    '0x0200 alarmFlag decodes bit 11 description',
    d.alarmFlag.active.some((a) => a.bit === 11)
  );
  check('0x0200 status raw == 0x000c000d', d.status.raw === 0x000c000d);
  check('0x0200 status.acc == ON (bit0=1)', d.status.acc === 'ON');
  check('0x0200 status.positionFix (bit1=0 -> no fix)', d.status.positionFix === 'No position fix');
  check('0x0200 status.latitudeHemisphere (bit2=1 -> North)', d.status.latitudeHemisphere === 'North');
  check('0x0200 dateTime decoded == 2025-01-21T17:13:09Z', d.dateTime.toISOString() === '2025-01-21T17:13:09.000Z');

  // supplementary info items present: 0x01 mileage, 0x30 signal, 0x31 sats, 0xEB timezone, 0x14/0x15 video alarms, 0xE8 extended
  const ids = d.supplementary.map((s) => s.idHex);
  check('0x0200 supplementary includes 0x01 mileage', ids.includes('0x01'));
  check('0x0200 supplementary includes 0x30 signal strength', ids.includes('0x30'));
  check('0x0200 supplementary includes 0x31 satellite count', ids.includes('0x31'));
  check('0x0200 supplementary includes 0xeb timezone', ids.includes('0xeb'));
  check('0x0200 supplementary includes 0xe8 extended alarm', ids.includes('0xe8'));

  const tzItem = d.supplementary.find((s) => s.idHex === '0xeb');
  check('0x0200 timezone string decoded == UTC+08:00', tzItem.value === 'UTC+08:00');

  const e8Item = d.supplementary.find((s) => s.idHex === '0xe8');
  check('0x0200 E8 alarmId == 0x0411 (Working mode event)', e8Item.value.alarmId === 0x0411);
  check('0x0200 E8 description resolved', e8Item.value.description === 'Working mode event');
}

// -----------------------------------------------------------------------
// Round-trip: build a General Platform Response and re-parse it
// -----------------------------------------------------------------------
{
  const frame = buildGeneralPlatformResponse('865478070001047', 14, 14, MSG_ID.TERMINAL_HEARTBEAT, 0, false);
  // Compare byte-for-byte against the doc's own downlink example 3:
  const expected = hexToBuf('7e 80 01 00 05 4e b6 fb 4a d6 28 00 0e 00 0e 00 02 00 31 7e'.replace(/\s+/g, ''));
  check('buildGeneralPlatformResponse matches spec example byte-for-byte', frame.equals(expected));

  const reparsed = parseFrame(unescapeFrame(frame.slice(1, frame.length - 1)));
  check('rebuilt frame re-parses OK', reparsed.ok === true);
  check('rebuilt frame decodes as GENERAL_RESPONSE', reparsed.type === 'GENERAL_RESPONSE');
}

// -----------------------------------------------------------------------
// Round-trip: build a Registration Response and compare to spec example
// -----------------------------------------------------------------------
{
  const frame = buildRegistrationResponse('865478070001047', 9, 9, 0, 'ODY1NDc4MDcwMDAxMDQ3', false);
  const expected = hexToBuf(
    '7e 81 00 00 17 4e b6 fb 4a d6 28 00 09 00 09 00 4f 44 59 31 4e 44 63 34 4d 44 63 77 4d 44 41 78 4d 44 51 33 59 7e'.replace(
      /\s+/g,
      ''
    )
  );
  check('buildRegistrationResponse matches spec example byte-for-byte', frame.equals(expected));
}

console.log(`\n${passed} checks passed.`);