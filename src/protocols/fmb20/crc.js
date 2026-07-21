/**
 * crc.js
 * CRC-16/IBM (a.k.a. CRC-16/ARC) for the Teltonika Codec8 / Codec8 Extended
 * protocol - NOT the same algorithm as GT06/OB22's CRC-ITU/X25. Different
 * poly, different init value. Do not reuse ../gt06/crc.js for this protocol.
 *
 * Implements the exact flowchart from the PDF's "CRC-16" appendix:
 *   CRC = 0
 *   for each byte:
 *     CRC = CRC XOR byte
 *     repeat 8 times:
 *       carry = CRC AND 1
 *       CRC = CRC shifted right 1 bit
 *       if carry == 1: CRC = CRC XOR 0xA001
 *   return CRC
 *
 * This is standard CRC-16/ARC: poly 0x8005 reflected (0xA001), init 0x0000,
 * no final XOR.
 */

function crc16IBM(buffer) {
  let crc = 0x0000;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      const carry = crc & 0x0001;
      crc = crc >>> 1;
      if (carry) {
        crc ^= 0xa001;
      }
    }
  }
  return crc & 0xffff;
}

module.exports = { crc16IBM };