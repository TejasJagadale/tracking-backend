'use strict';

/**
 * JC371 (JT/T 808-2019 / JT/T 808-2011 / JT/T 1078-2016) protocol utilities
 * -------------------------------------------------------------------------
 * This protocol is NOT related to GT06 / OB22 / Teltonika Codec8. It uses a
 * totally different framing style:
 *   - Frame delimiter is 0x7E on BOTH ends (not a 2-byte 0x7878 start marker)
 *   - Bytes 0x7E/0x7D inside header+body+checksum must be escaped
 *   - Checksum is a single-byte running XOR (not CRC-16/IBM or CRC-ITU)
 *   - Header layout differs between v2011 and v2019 (auto-detected via a
 *     "version identifier" bit in the message body attributes word)
 */

const FLAG = 0x7e;
const ESC = 0x7d;

/**
 * Reverse 0x7E/0x7D escaping on a raw frame body (the bytes BETWEEN the two
 * 0x7E flag bytes). Rule (Section 3.2.2):
 *   0x7D 0x02 -> 0x7E
 *   0x7D 0x01 -> 0x7D
 */
function unescapeFrame(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ESC && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) {
        out.push(FLAG);
        i++;
        continue;
      }
      if (buf[i + 1] === 0x01) {
        out.push(ESC);
        i++;
        continue;
      }
    }
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

/**
 * Apply 0x7E/0x7D escaping to an already-assembled (header+body+checksum)
 * buffer, in preparation for wrapping it with 0x7E flags on send.
 * NOTE order matters: escape 0x7D first, then 0x7E (Section 3.2.2).
 */
function escapeFrame(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ESC) {
      out.push(ESC, 0x01);
    } else if (buf[i] === FLAG) {
      out.push(ESC, 0x02);
    } else {
      out.push(buf[i]);
    }
  }
  return Buffer.from(out);
}

/**
 * Running single-byte XOR checksum over header+body (Section 3.2.5).
 */
function xorChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i++) cs ^= buf[i];
  return cs;
}

/**
 * Scan a raw TCP byte stream for 0x7E ... 0x7E delimited frames.
 * Returns { frames: [Buffer,...] (unescaped, header+body+checksum only),
 *           remainder: Buffer (leftover partial bytes to prepend next read) }
 */
function extractFrames(streamBuf) {
  const frames = [];
  let start = -1;
  let i = 0;
  while (i < streamBuf.length) {
    if (streamBuf[i] === FLAG) {
      if (start === -1) {
        start = i; // opening flag
      } else if (i > start) {
        // closing flag - content strictly between the two flags
        const raw = streamBuf.slice(start + 1, i);
        if (raw.length > 0) frames.push(unescapeFrame(raw));
        start = i; // this flag can double as the next frame's opening flag
      }
    }
    i++;
  }
  const remainder = start === -1 ? streamBuf : streamBuf.slice(start);
  return { frames, remainder };
}

/**
 * Luhn check-digit calculation (used to derive the 15th IMEI digit from the
 * 14 digits recovered from the 6-byte / 10-byte hex-encoded IMEI field).
 */
function luhnCheckDigit(digitsStr) {
  let sum = 0;
  const digits = digitsStr.split('').map(Number);
  // Luhn: starting from the rightmost digit of the 14, double every 2nd digit
  for (let idx = 0; idx < digits.length; idx++) {
    // position counted from the right, 0-indexed; double odd positions
    const posFromRight = digits.length - idx;
    let d = digits[idx];
    if (posFromRight % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Decode the device-IMEI field per Section 3.2.3's worked example:
 *   hex bytes -> read as one big hex integer -> decimal string, left-padded
 *   with zeros to 14 digits -> append a Luhn check digit as the 15th digit.
 *
 * Example: hex 4EB6FB4AD5FB -> decimal 86547807000059 -> +Luhn digit "3"
 *          -> IMEI "865478070000593"
 */
function decodeImeiField(buf) {
  const hex = buf.toString('hex');
  let decimalStr = BigInt('0x' + hex).toString(10);
  decimalStr = decimalStr.padStart(14, '0');
  const check = luhnCheckDigit(decimalStr);
  return decimalStr + String(check);
}

/**
 * Encode a 15-digit IMEI back into the 6-byte (v2011) or 10-byte (v2019)
 * hex field used in outbound headers (drops the trailing Luhn digit,
 * i.e. reverses decodeImeiField).
 */
function encodeImeiField(imei15, byteLen) {
  const first14 = imei15.slice(0, 14);
  let hex = BigInt(first14).toString(16);
  const targetHexLen = byteLen * 2;
  hex = hex.padStart(targetHexLen, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * BCD[n] -> string of 2n decimal digits (each byte is two BCD nibbles).
 */
function bcdToString(buf) {
  return buf.toString('hex');
}

/**
 * Parse a BCD[6] YY-MM-DD-hh-mm-ss field into a JS Date (UTC unless noted
 * otherwise by the caller - the spec says GMT/GMT+8 depending on section).
 */
function bcdToDate(buf) {
  const s = bcdToString(buf); // 12 hex-decimal digits: YYMMDDhhmmss
  const yy = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  const hh = parseInt(s.slice(6, 8), 10);
  const mi = parseInt(s.slice(8, 10), 10);
  const ss = parseInt(s.slice(10, 12), 10);
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
}

function dateToBcd(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const s =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds());
  return Buffer.from(s, 'hex');
}

module.exports = {
  FLAG,
  ESC,
  unescapeFrame,
  escapeFrame,
  xorChecksum,
  extractFrames,
  luhnCheckDigit,
  decodeImeiField,
  encodeImeiField,
  bcdToString,
  bcdToDate,
  dateToBcd,
};