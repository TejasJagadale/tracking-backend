const IDLE_SPEED_THRESHOLD_KMH = Number(process.env.IDLE_SPEED_THRESHOLD_KMH || 3);
const OFFLINE_TIMEOUT_SECONDS = Number(process.env.OFFLINE_TIMEOUT_SECONDS || 180);

const STATUS = {
  MOVING: 'MOVING',
  IDLE: 'IDLE',
  PARKED: 'PARKED',
  OFFLINE: 'OFFLINE',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Determines vehicle status from the latest normalized GPS fix.
 *
 * Rules (Section 5.5 / 7. Live Data Flow):
 *   OFFLINE - no packet received within OFFLINE_TIMEOUT_SECONDS
 *   MOVING  - speed above the idle threshold
 *   IDLE    - speed at/below threshold but ignition is ON (engine running, stationary)
 *   PARKED  - speed at/below threshold and ignition is OFF (or unknown)
 *
 * @param {object} params
 * @param {number} params.speedKmh
 * @param {boolean|null} params.ignition
 * @param {Date} params.gpsTimestamp   device-reported fix time
 * @param {Date} [params.now]          for testability
 * @returns {string} one of STATUS
 */
function computeStatus({ speedKmh, ignition, gpsTimestamp, now = new Date() }) {
  const secondsSinceFix = (now.getTime() - new Date(gpsTimestamp).getTime()) / 1000;

  if (secondsSinceFix > OFFLINE_TIMEOUT_SECONDS) {
    return STATUS.OFFLINE;
  }

  if (speedKmh > IDLE_SPEED_THRESHOLD_KMH) {
    return STATUS.MOVING;
  }

  if (ignition === true) {
    return STATUS.IDLE;
  }

  return STATUS.PARKED;
}

/**
 * Called on a scheduled interval (not just on packet arrival) so a device
 * that simply stops transmitting still transitions to OFFLINE without
 * needing a new packet to trigger the check.
 */
function isStale(lastSeenMs, now = Date.now()) {
  if (!lastSeenMs) return true;
  return (now - lastSeenMs) / 1000 > OFFLINE_TIMEOUT_SECONDS;
}

module.exports = { STATUS, computeStatus, isStale, OFFLINE_TIMEOUT_SECONDS };
