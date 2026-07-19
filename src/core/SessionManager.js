const { scoped } = require('../utils/logger');

const log = scoped('SessionManager');

/**
 * Tracks one entry per authenticated device connection, regardless of which
 * protocol/TCP port it came in on. Keyed by IMEI so a device reconnecting
 * (new socket) always replaces its previous session cleanly.
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, {socket: import('net').Socket, protocol: string, imei: string, authenticatedAt: Date, lastPacketAt: Date, serial: number}>} */
    this.sessions = new Map();
    /** reverse lookup: socket -> imei, so we can clean up on 'close' before auth info is known elsewhere */
    this.socketToImei = new Map();
  }

  registerSession(socket, protocol, imei) {
    const existing = this.sessions.get(imei);
    if (existing && existing.socket !== socket && !existing.socket.destroyed) {
      log.warn('Duplicate session, destroying previous socket', { imei, protocol });
      existing.socket.destroy();
    }

    this.sessions.set(imei, {
      socket,
      protocol,
      imei,
      authenticatedAt: new Date(),
      lastPacketAt: new Date(),
      serial: 0,
    });
    this.socketToImei.set(socket, imei);
    log.info('Session registered', { imei, protocol });
  }

  touch(imei) {
    const s = this.sessions.get(imei);
    if (s) s.lastPacketAt = new Date();
  }

  getByImei(imei) {
    return this.sessions.get(imei) || null;
  }

  getImeiBySocket(socket) {
    return this.socketToImei.get(socket) || null;
  }

  isAuthenticated(socket) {
    return this.socketToImei.has(socket);
  }

  removeBySocket(socket) {
    const imei = this.socketToImei.get(socket);
    if (!imei) return null;
    this.socketToImei.delete(socket);
    const session = this.sessions.get(imei);
    // Only delete the session map entry if it still points at this exact socket
    // (avoids deleting a newer session if a stale duplicate closes late).
    if (session && session.socket === socket) {
      this.sessions.delete(imei);
    }
    log.info('Session removed', { imei });
    return imei;
  }

  nextSerial(imei) {
    const s = this.sessions.get(imei);
    if (!s) return 0;
    s.serial = (s.serial + 1) % 65536;
    return s.serial;
  }

  getActiveImeis() {
    return Array.from(this.sessions.keys());
  }

  getActiveCount() {
    return this.sessions.size;
  }
}

// Singleton - one process-wide session table shared by every protocol's TCP server
module.exports = new SessionManager();
