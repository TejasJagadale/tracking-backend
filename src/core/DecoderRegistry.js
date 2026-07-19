const gt06 = require('../protocols/gt06/decoder');
const jc261 = require('../protocols/jc261/decoder');
// Future protocols plug in here the same way, e.g.:
// const teltonika = require('../protocols/teltonika/decoder');
// const jt808 = require('../protocols/jt808/decoder');

/**
 * Every entry must implement:
 *   PROTOCOL: string
 *   DEFAULT_PORT: number
 *   extractFrames(buffer): { frames: Buffer[], rest: Buffer }
 *   parseFrame(frame): { type, imei, serial, crcValid, normalized, ack }
 *
 * Adding a new device protocol to the whole server = writing one module with
 * this interface and adding one line here. Nothing in SessionManager,
 * tcpServer, VehicleStatusEngine, Mongo, REST, or WebSocket changes.
 */
const registry = {
  [gt06.PROTOCOL]: gt06,
  [jc261.PROTOCOL]: jc261,
  // [teltonika.PROTOCOL]: teltonika,
  // [jt808.PROTOCOL]: jt808,
};

function getDecoder(protocolName) {
  const decoder = registry[protocolName];
  if (!decoder) throw new Error(`No decoder registered for protocol: ${protocolName}`);
  return decoder;
}

function getAllDecoders() {
  return Object.values(registry);
}

module.exports = { getDecoder, getAllDecoders, registry };
