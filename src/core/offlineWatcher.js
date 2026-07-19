const Device = require('../models/Device');
const { OFFLINE_TIMEOUT_SECONDS } = require('../services/VehicleStatusEngine');
const LocationService = require('../services/LocationService');
const { scoped } = require('../utils/logger');

const log = scoped('OfflineWatcher');

const SWEEP_INTERVAL_MS = 30 * 1000;

function startOfflineWatcher() {
  const timer = setInterval(async () => {
    try {
      const staleCutoff = new Date(Date.now() - OFFLINE_TIMEOUT_SECONDS * 1000);

      // Single indexed query: every device still marked online whose
      // lastSeenAt has fallen behind the offline threshold.
      const staleDevices = await Device.find(
        { isOnline: true, lastSeenAt: { $lt: staleCutoff } },
        { imei: 1 }
      ).lean();

      for (const { imei } of staleDevices) {
        await LocationService.markDeviceOffline(imei);
      }
    } catch (err) {
      log.error('Sweep failed', { error: err.message });
    }
  }, SWEEP_INTERVAL_MS);

  log.info('Started', { intervalMs: SWEEP_INTERVAL_MS });
  return timer;
}

module.exports = { startOfflineWatcher };
