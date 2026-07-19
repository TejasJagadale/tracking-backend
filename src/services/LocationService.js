const Device = require('../models/Device');
const Location = require('../models/Location');
const { computeStatus } = require('./VehicleStatusEngine');
const eventBus = require('../core/eventBus');
const { scoped } = require('../utils/logger');

const log = scoped('LocationService');

/**
 * Called by every protocol handler whenever a normalized GPS fix (LOCATION)
 * has been decoded. Implements the "GPS Data Processing" + "Vehicle Status
 * Detection" + storage steps of the Live Data Flow (Section 7) - Mongo-only:
 * the previous Redis "current location" cache is now the embedded
 * `lastLocation` field on the Device document itself.
 */
async function processLocation(imei, normalized) {
  const status = computeStatus({
    speedKmh: normalized.speedKmh,
    ignition: normalized.ignition,
    gpsTimestamp: normalized.gpsTimestamp,
  });

  const existing = await Device.findOne({ imei }, { lastStatus: 1 }).lean();
  const previousStatus = existing?.lastStatus || null;

  const lastLocation = {
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    speedKmh: normalized.speedKmh,
    heading: normalized.heading,
    altitude: normalized.altitude,
    satellites: normalized.satellites,
    ignition: normalized.ignition,
    gsmSignal: normalized.gsmSignal,
    batteryLevel: normalized.batteryLevel,
    gpsTimestamp: normalized.gpsTimestamp,
  };

  const device = await Device.findOneAndUpdate(
    { imei },
    {
      $set: {
        lastSeenAt: new Date(),
        lastStatus: status,
        protocol: normalized.protocol,
        isOnline: true,
        lastLocation,
      },
      $setOnInsert: { firstSeenAt: new Date() },
    },
    { upsert: true, new: true }
  );

  await Location.create({
    imei,
    protocol: normalized.protocol,
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    speedKmh: normalized.speedKmh,
    heading: normalized.heading,
    altitude: normalized.altitude,
    satellites: normalized.satellites,
    ignition: normalized.ignition,
    gsmSignal: normalized.gsmSignal,
    batteryLevel: normalized.batteryLevel,
    gpsTimestamp: normalized.gpsTimestamp,
    vehicleStatus: status,
  });

  eventBus.emit('location:update', {
    imei,
    protocol: normalized.protocol,
    location: { ...normalized, imei, vehicleStatus: status },
    status,
    deviceName: device.name,
  });

  if (previousStatus && previousStatus !== status) {
    eventBus.emit('device:statusChange', { imei, status, previousStatus });
  }

  log.debug('Location processed', { imei, status, lat: normalized.latitude, lon: normalized.longitude });

  return { device, status };
}

/**
 * Called on heartbeat / any non-location packet so the device is still
 * marked online and lastSeen is refreshed, even without a fresh GPS fix.
 */
async function processHeartbeat(imei, heartbeatData = {}) {
  await Device.findOneAndUpdate(
    { imei },
    { $set: { lastSeenAt: new Date(), isOnline: true } },
    { upsert: false }
  );
  log.debug('Heartbeat processed', { imei, ...heartbeatData });
}

async function markDeviceOffline(imei) {
  await Device.findOneAndUpdate({ imei }, { $set: { isOnline: false, lastStatus: 'OFFLINE' } });
  eventBus.emit('device:offline', { imei });
  log.info('Device marked offline', { imei });
}

module.exports = { processLocation, processHeartbeat, markDeviceOffline };
