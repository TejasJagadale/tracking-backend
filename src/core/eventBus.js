const EventEmitter = require('events');

/**
 * Shared event bus. The TCP server / LocationService emit events here;
 * socketServer.js subscribes and broadcasts to connected browser clients.
 * Keeping this decoupled means the TCP ingest pipeline never needs to know
 * Socket.IO exists at all.
 *
 * Events:
 *   'location:update'   -> { imei, protocol, location, status }
 *   'device:statusChange' -> { imei, status, previousStatus }
 *   'device:online'      -> { imei, protocol }
 *   'device:offline'     -> { imei }
 */
class GpsEventBus extends EventEmitter {}

module.exports = new GpsEventBus();
