const { Server } = require('socket.io');
const eventBus = require('./core/eventBus');
const Device = require('./models/Device');
const { scoped } = require('./utils/logger');

const log = scoped('SocketServer');

const EVENTS = {
  LOCATION_UPDATE: 'location:update',
  STATUS_CHANGE: 'device:statusChange',
  DEVICE_ONLINE: 'device:online',
  DEVICE_OFFLINE: 'device:offline',
};

function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || '*' },
  });

  io.on('connection', async (socket) => {
    log.info('Client connected', { id: socket.id });

    // Send a snapshot immediately on connect so the map has something to
    // render before the next live packet arrives - avoids a blank map.
    try {
      const devices = await Device.find(
        { lastLocation: { $ne: null } },
        { imei: 1, name: 1, protocol: 1, lastStatus: 1, isOnline: 1, lastLocation: 1 }
      ).lean();

      const locations = devices.map((d) => ({
        imei: d.imei,
        deviceName: d.name,
        protocol: d.protocol,
        isOnline: d.isOnline,
        vehicleStatus: d.lastStatus,
        ...d.lastLocation,
      }));

      socket.emit('snapshot', { locations });
    } catch (err) {
      log.error('Failed to send snapshot', { error: err.message });
    }

    socket.on('disconnect', () => log.info('Client disconnected', { id: socket.id }));
  });

  // Bridge internal domain events -> browser-facing Socket.IO events.
  // This is the only place that knows Socket.IO exists; the TCP/decoder/
  // service layers never import socket.io directly (Section 5.8 requirement:
  // WebSocket broadcasts live location updates, status changes, online/offline).
  eventBus.on('location:update', (payload) => {
    io.emit(EVENTS.LOCATION_UPDATE, payload);
  });

  eventBus.on('device:statusChange', (payload) => {
    io.emit(EVENTS.STATUS_CHANGE, payload);
  });

  eventBus.on('device:offline', (payload) => {
    io.emit(EVENTS.DEVICE_OFFLINE, payload);
  });

  log.info('Socket.IO server initialized');
  return io;
}

module.exports = { initSocketServer, EVENTS };
