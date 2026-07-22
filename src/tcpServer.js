const net = require('net');
const sessionManager = require('./core/SessionManager');
const { getAllDecoders } = require('./core/DecoderRegistry');
const LocationService = require('./services/LocationService');
const RawPacket = require('./models/RawPacket');
const { scoped } = require('./utils/logger');

const log = scoped('TcpServer');

// Per-socket receive buffers, since TCP gives us a byte stream, not framed
// messages - a device's packet can arrive split across multiple 'data'
// events, or several packets can arrive coalesced into one.
const socketBuffers = new WeakMap();

async function auditPacket({ imei, protocol, direction, buffer, protocolNumberHex, parsedOk, error }) {
  try {
    await RawPacket.create({
      imei: imei || null,
      protocol,
      direction,
      hex: buffer.toString('hex'),
      protocolNumberHex: protocolNumberHex || null,
      parsedOk,
      error: error || null,
    });
  } catch (err) {
    // Raw packet audit trail is optional / best-effort - never let it break the pipeline
    log.warn('Failed to persist raw packet audit record', { error: err.message });
  }
}

function handleConnection(socket, decoder) {
  const { PROTOCOL } = decoder;
  socketBuffers.set(socket, Buffer.alloc(0));

  log.info('Device connected', { protocol: PROTOCOL, remote: `${socket.remoteAddress}:${socket.remotePort}` });

  socket.on('data', async (chunk) => {
    const combined = Buffer.concat([socketBuffers.get(socket) || Buffer.alloc(0), chunk]);
    console.log(combined, "combined data")
    const { frames, rest } = decoder.extractFrames(combined);
    socketBuffers.set(socket, rest);

    for (const frame of frames) {
      let parsed;
      console.log(frame, "frame data")
      try {
        parsed = decoder.parseFrame(frame);
        console.log(parsed, "parse data")
      } catch (err) {
        console.log(err, "parse error")
        log.error('Packet decode error', { protocol: PROTOCOL, error: err.message });
        await auditPacket({ protocol: PROTOCOL, direction: 'IN', buffer: frame, parsedOk: false, error: err.message });
        continue; // Section 8: Packet Decode Errors are logged, connection stays open
      }

      console.log(parsed.protocolNumberHex, "parsed HEX data")

      if (!parsed.crcValid) {
        console.log("crc error")
        log.warn('CRC validation failed', { protocol: PROTOCOL });
        await auditPacket({
          protocol: PROTOCOL,
          direction: 'IN',
          buffer: frame,
          protocolNumberHex: parsed.protocolNumberHex,
          parsedOk: false,
          error: 'CRC mismatch',
        });
        continue; // do not ACK a packet that failed integrity check
      }

      await auditPacket({
        imei: sessionManager.getImeiBySocket(socket),
        protocol: PROTOCOL,
        direction: 'IN',
        buffer: frame,
        protocolNumberHex: parsed.protocolNumberHex,
        parsedOk: true,
      });

      if (
        parsed.type === "LOGIN" ||
        parsed.type === "AUTHENTICATION"
      ) {
        sessionManager.registerSession(
          socket,
          PROTOCOL,
          parsed.imei
        );

        log.info("Authentication success", {
          protocol: PROTOCOL,
          imei: parsed.imei
        });

        if (parsed.ack) {
          socket.write(parsed.ack);
        }

        continue;
      } else {
        sessionManager.touch(sessionManager.getImeiBySocket(socket));
      }

      const imei = parsed.imei || sessionManager.getImeiBySocket(socket);
      console.log(imei, "imei")

      if (parsed.type === 'LOCATION' && parsed.normalized) {
        console.log("location")
        try {
          await LocationService.processLocation(imei, { ...parsed.normalized, imei });
        } catch (err) {
          log.error('Failed to process location', { imei, error: err.message });
        }
      } else if (parsed.type === 'LOCATION_BATCH' && parsed.records) {
        // Teltonika Codec8/8E: one TCP frame can carry multiple buffered GPS
        // fixes. Process oldest-first so lastLocation/status end up reflecting
        // the most recent point once the loop finishes.
        for (const record of parsed.records) {
          try {
            await LocationService.processLocation(imei, { ...record, imei });
          } catch (err) {
            log.error('Failed to process location (batch)', { imei, error: err.message });
          }
        }
      } else if (parsed.type === 'HEARTBEAT') {
        await LocationService.processHeartbeat(imei, parsed.normalized || {});
      } else if (parsed.type === 'OBD_UNVERIFIED') {
        // Recognized frame (CRC-valid, ack'd), but the field layout isn't
        // verified yet - see protocols/ob22/decoder.js. Store raw only,
        // never fabricate location/telemetry fields from it.
        try {
          await LocationService.processUnverifiedObd(imei, parsed.normalized, parsed.protocolNumberHex);
        } catch (err) {
          log.error('Failed to store unverified OBD packet', { imei, error: err.message });
        }
      }

      if (parsed.ack) {
        socket.write(parsed.ack);
        await auditPacket({
          imei,
          protocol: PROTOCOL,
          direction: 'OUT',
          buffer: parsed.ack,
          protocolNumberHex: parsed.protocolNumberHex,
          parsedOk: true,
        });
      }
    }
  });

  socket.on('close', async () => {
    const imei = sessionManager.removeBySocket(socket);
    socketBuffers.delete(socket);
    log.info('Device disconnected', { protocol: PROTOCOL, imei });
    if (imei) {
      await LocationService.markDeviceOffline(imei);
    }
  });

  socket.on('error', (err) => {
    log.error('Socket error', { protocol: PROTOCOL, error: err.message });
  });

  socket.setTimeout(5 * 60 * 1000); // 5 min idle timeout, most GPS devices heartbeat far more often
  socket.on('timeout', () => {
    log.warn('Socket idle timeout - closing', { protocol: PROTOCOL });
    socket.destroy();
  });
}

/**
 * Starts one TCP listener per registered protocol decoder. Each listener is
 * completely independent at the socket level but shares the same
 * SessionManager, LocationService and event bus - this is what "modular
 * architecture, additional protocols added with minimal changes" (Section
 * 11) means in practice: adding JC261 later is one new decoder module plus
 * one new entry in DecoderRegistry, nothing here changes.
 */
function startTcpServers() {
  const servers = [];

  for (const decoder of getAllDecoders()) {
    const server = net.createServer((socket) => handleConnection(socket, decoder));
    server.listen(decoder.DEFAULT_PORT, () => {
      log.info(`${decoder.PROTOCOL} TCP server listening`, { port: decoder.DEFAULT_PORT });
    });
    server.on('error', (err) => {
      log.error(`${decoder.PROTOCOL} TCP server error`, { error: err.message });
    });
    servers.push(server);
  }

  return servers;
}

module.exports = { startTcpServers };