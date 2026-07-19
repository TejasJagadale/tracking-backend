/**
 * Simulates a JC261 GPS device: connects to the TCP server, logs in, then
 * sends a location fix every few seconds that nudges along a short path -
 * exactly the bytes a real device would send, built fresh with the current
 * timestamp (not replayed from the spec's stale 2022 example).
 *
 * Usage:
 *   node tools/simulate-jc261-device.js
 *   node tools/simulate-jc261-device.js --host 127.0.0.1 --port 5029 --imei 123456789012345
 */
const net = require('net');

// ---- CLI args (all optional) -----------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, arr) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
    return pairs;
  }, [])
);
const HOST = args.host || '127.0.0.1';
const PORT = Number(args.port || 5029);
const IMEI = args.imei || '123456789012345'; // any 15-digit string works as a fake IMEI

// Starting point: Chennai, India - nudges north-east each tick to simulate driving
let lat = Number(args.lat || 13.0827);
let lon = Number(args.lon || 80.2707);
const LAT_STEP = 0.0006; // roughly ~65m per tick
const LON_STEP = 0.0008;

// ---- Same CRC-ITU algorithm the server's JC261 decoder verifies against ----
function crcItu(buffer) {
  let fcs = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    fcs ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      fcs = fcs & 0x0001 ? (fcs >> 1) ^ 0x8408 : fcs >> 1;
    }
  }
  return ~fcs & 0xffff;
}

const START = Buffer.from([0x78, 0x78]);
const STOP = Buffer.from([0x0d, 0x0a]);

function buildFrame(protocolNumber, content, serial) {
  const body = Buffer.concat([
    Buffer.from([protocolNumber]),
    content,
    Buffer.from([(serial >> 8) & 0xff, serial & 0xff]),
  ]);
  const lengthByte = Buffer.from([body.length + 2]); // +2 for the CRC bytes we're about to append
  const crc = crcItu(Buffer.concat([lengthByte, body]));
  const crcBuf = Buffer.from([(crc >> 8) & 0xff, crc & 0xff]);
  return Buffer.concat([START, lengthByte, body, crcBuf, STOP]);
}

// IMEI digit-string -> 8-byte BCD terminal ID, same packing the spec's own
// login example uses (two digits per byte, left-padded with a zero nibble)
function imeiToTerminalId(imei) {
  const padded = imei.length === 15 ? '0' + imei : imei; // pad to 16 digits = 8 bytes
  const bytes = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const high = parseInt(padded[i * 2], 10);
    const low = parseInt(padded[i * 2 + 1], 10);
    bytes[i] = (high << 4) | low;
  }
  return bytes;
}

function buildLoginFrame(imei, serial) {
  const terminalId = imeiToTerminalId(imei);
  const typeId = Buffer.from([0x00, 0x01]); // arbitrary terminal type
  const timeZoneLang = Buffer.from([0x03, 0x22]); // GMT+8-ish placeholder, unused by our decoder
  const content = Buffer.concat([terminalId, typeId, timeZoneLang]);
  return buildFrame(0x01, content, serial);
}

function buildLocationFrame({ latitude, longitude, speedKmh, headingDeg, ignitionOn }, serial) {
  const now = new Date();
  const dateTime = Buffer.from([
    now.getUTCFullYear() - 2000,
    now.getUTCMonth() + 1,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  ]);

  const satByte = Buffer.from([0xcf]); // 12-bit info length nibble + 15 satellites (cosmetic, any valid nibble works)

  const rawLat = Math.round(Math.abs(latitude) * 1800000);
  const rawLon = Math.round(Math.abs(longitude) * 1800000);
  const latBuf = Buffer.alloc(4);
  latBuf.writeUInt32BE(rawLat, 0);
  const lonBuf = Buffer.alloc(4);
  lonBuf.writeUInt32BE(rawLon, 0);

  const speedBuf = Buffer.from([Math.min(255, Math.round(speedKmh))]);

  const course = Math.max(0, Math.min(1023, Math.round(headingDeg)));
  const isNorth = latitude >= 0;
  const isWest = longitude < 0;
  let byte1 = 0x10; // bit4 = GPS positioned
  if (isWest) byte1 |= 0x08;
  if (isNorth) byte1 |= 0x04;
  byte1 |= (course >> 8) & 0x03;
  const byte2 = course & 0xff;
  const courseStatusBuf = Buffer.from([byte1, byte2]);

  const mcc = Buffer.from([0x01, 0x94]); // 404 decimal = India (any plausible MCC works, decoder doesn't validate it)
  const mnc = Buffer.from([0x0b]);
  const lac = Buffer.from([0x76, 0x06]);
  const cellId = Buffer.from([0x07, 0x76, 0xa4]);

  const acc = Buffer.from([ignitionOn ? 0x01 : 0x00]);
  const uploadMode = Buffer.from([0x00]); // upload by time interval
  const realtimeFlag = Buffer.from([0x00]); // real-time upload
  const mileage = Buffer.alloc(4); // 0 - not simulated

  const content = Buffer.concat([
    dateTime,
    satByte,
    latBuf,
    lonBuf,
    speedBuf,
    courseStatusBuf,
    mcc,
    mnc,
    lac,
    cellId,
    acc,
    uploadMode,
    realtimeFlag,
    mileage,
  ]);

  return buildFrame(0x22, content, serial);
}

// ---- Connect and stream ------------------------------------------------
let serial = 1;
const socket = net.connect(PORT, HOST, () => {
  console.log(`Connected to ${HOST}:${PORT} as IMEI ${IMEI}`);
  socket.write(buildLoginFrame(IMEI, serial++));
});

socket.on('data', (data) => {
  console.log('<- server ACK:', data.toString('hex'));
});

let tickCount = 0;
const interval = setInterval(() => {
  lat += LAT_STEP;
  lon += LON_STEP;
  tickCount += 1;

  const frame = buildLocationFrame(
    {
      latitude: lat,
      longitude: lon,
      speedKmh: 35 + Math.round(Math.random() * 15), // 35-50 km/h, looks like real driving
      headingDeg: 45, // north-east
      ignitionOn: true,
    },
    serial++
  );

  socket.write(frame);
  console.log(`-> sent fix #${tickCount}: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
}, 3000);

socket.on('close', () => {
  console.log('Connection closed');
  clearInterval(interval);
});

socket.on('error', (err) => {
  console.error('Socket error:', err.message);
  clearInterval(interval);
});

process.on('SIGINT', () => {
  console.log('\nStopping simulator...');
  clearInterval(interval);
  socket.end();
  process.exit(0);
});
