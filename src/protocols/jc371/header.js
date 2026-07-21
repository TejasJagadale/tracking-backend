'use strict';

const { decodeImeiField, encodeImeiField } = require('./utils');

/**
 * Message Body Attributes word (Table 3-4). Bit numbering is bit0 = LSB.
 *   bits 0-9   : message body length
 *   bits 10-12 : data encryption method (0 = none, bit10=1 -> RSA)
 *   bit 13     : segmentation flag (1 = message encapsulation item follows)
 *   bit 14     : version identifier (v2019 only; always 1 when present).
 *                This is how we auto-detect v2011 vs v2019 - v2011 leaves
 *                this bit as part of "reserved" (0).
 *   bit 15     : reserved
 */
function parseBodyAttrs(word) {
  return {
    bodyLength: word & 0x03ff,
    encryption: (word >> 10) & 0x7,
    segmented: ((word >> 13) & 0x1) === 1,
    isV2019: ((word >> 14) & 0x1) === 1,
    raw: word,
  };
}

function buildBodyAttrsWord({ bodyLength, encryption = 0, segmented = false, isV2019 = false }) {
  let word = bodyLength & 0x03ff;
  word |= (encryption & 0x7) << 10;
  if (segmented) word |= 1 << 13;
  if (isV2019) word |= 1 << 14;
  return word;
}

/**
 * Parse the message header starting at `offset` in an unescaped
 * header+body+checksum buffer. Returns { header, offset } where offset is
 * the byte position immediately after the header (i.e. start of body).
 */
function parseHeader(buf, offset = 0) {
  const msgId = buf.readUInt16BE(offset);
  offset += 2;

  const attrsWord = buf.readUInt16BE(offset);
  offset += 2;
  const attrs = parseBodyAttrs(attrsWord);

  let protocolVersion = null;
  if (attrs.isV2019) {
    protocolVersion = buf.readUInt8(offset);
    offset += 1;
  }

  const imeiFieldLen = attrs.isV2019 ? 10 : 6;
  const imeiHexBuf = buf.slice(offset, offset + imeiFieldLen);
  offset += imeiFieldLen;
  const imei = decodeImeiField(imeiHexBuf);

  const msgSeq = buf.readUInt16BE(offset);
  offset += 2;

  let packetInfo = null;
  if (attrs.segmented) {
    packetInfo = {
      totalPackets: buf.readUInt16BE(offset),
      packetSeq: buf.readUInt16BE(offset + 2),
    };
    offset += 4;
  }

  return {
    header: {
      msgId,
      msgIdHex: '0x' + msgId.toString(16).padStart(4, '0'),
      attrs,
      protocolVersion,
      imei,
      msgSeq,
      packetInfo,
    },
    offset,
  };
}

/**
 * Build a header+body buffer (NOT yet escaped, NOT yet flagged, checksum
 * NOT yet appended). `opts.isV2019` picks the header shape; if omitted,
 * defaults to v2011 (matches every real-world example frame in the spec's
 * own appendix, which all use the compact 6-byte-IMEI, no-version-byte
 * form even for JT/T1078 message IDs).
 */
function buildHeader({ msgId, imei, msgSeq, isV2019 = false, encryption = 0, packetInfo = null, bodyLength }) {
  const segmented = !!packetInfo;
  const attrsWord = buildBodyAttrsWord({ bodyLength, encryption, segmented, isV2019 });

  const parts = [];
  const msgIdBuf = Buffer.alloc(2);
  msgIdBuf.writeUInt16BE(msgId, 0);
  parts.push(msgIdBuf);

  const attrsBuf = Buffer.alloc(2);
  attrsBuf.writeUInt16BE(attrsWord, 0);
  parts.push(attrsBuf);

  if (isV2019) {
    parts.push(Buffer.from([1])); // protocol version number
  }

  const imeiLen = isV2019 ? 10 : 6;
  parts.push(encodeImeiField(imei, imeiLen));

  const seqBuf = Buffer.alloc(2);
  seqBuf.writeUInt16BE(msgSeq, 0);
  parts.push(seqBuf);

  if (segmented) {
    const pkt = Buffer.alloc(4);
    pkt.writeUInt16BE(packetInfo.totalPackets, 0);
    pkt.writeUInt16BE(packetInfo.packetSeq, 2);
    parts.push(pkt);
  }

  return Buffer.concat(parts);
}

module.exports = { parseBodyAttrs, buildBodyAttrsWord, parseHeader, buildHeader };