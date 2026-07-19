/**
 * CRC-16/X-25 (a.k.a. CRC-ITU), reflected, poly 0x1021 (reflected form 0x8408),
 * init 0xFFFF, final XOR 0xFFFF. This is the checksum GT06/Concox devices use
 * over [length byte(s) + protocol number + content + serial number].
 */
function crc16X25(buffer) {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0x8408;
      } else {
        crc = crc >> 1;
      }
    }
  }
  crc = ~crc & 0xffff;
  return crc;
}

module.exports = { crc16X25 };
