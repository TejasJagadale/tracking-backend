/**
 * CRC-ITU, as specified in JC261 protocol doc Section 4.6 / Appendix A.
 * This is the standard CRC-16/X-25 (reflected, poly 0x8408, init 0xFFFF,
 * final XOR 0xFFFF) - identical algorithm to GT06's checksum, confirmed by
 * cross-checking the vendor's own lookup-table C code in Appendix A against
 * this bit-by-bit implementation (both produce the same results).
 */
function crcItu(buffer) {
  let fcs = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    fcs ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (fcs & 0x0001) {
        fcs = (fcs >> 1) ^ 0x8408;
      } else {
        fcs = fcs >> 1;
      }
    }
  }
  return (~fcs) & 0xffff;
}

module.exports = { crcItu };
