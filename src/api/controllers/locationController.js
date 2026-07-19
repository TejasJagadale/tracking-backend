const Device = require('../../models/Device');
const Location = require('../../models/Location');

// GET /api/locations/live - current position for every device that has a
// known fix. Reads the embedded lastLocation on Device - a single indexed
// query, no separate cache needed.
async function getLiveLocations(req, res) {
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

  res.json({ count: locations.length, locations });
}

// GET /api/locations/:imei/latest
async function getLatestLocation(req, res) {
  const { imei } = req.params;

  const device = await Device.findOne({ imei }, { lastLocation: 1, lastStatus: 1, name: 1 }).lean();
  if (device?.lastLocation) {
    return res.json({
      imei,
      deviceName: device.name,
      vehicleStatus: device.lastStatus,
      ...device.lastLocation,
    });
  }

  // Fall back to history collection in case the embedded snapshot hasn't
  // been set yet (e.g. device record exists but no fix landed since restart)
  const latest = await Location.findOne({ imei }).sort({ gpsTimestamp: -1 }).lean();
  if (!latest) return res.status(404).json({ error: 'No location data for this device' });
  res.json(latest);
}

// GET /api/locations/:imei/history?from=ISO&to=ISO&limit=500
async function getLocationHistory(req, res) {
  const { imei } = req.params;
  const { from, to, limit } = req.query;

  const query = { imei };
  if (from || to) {
    query.gpsTimestamp = {};
    if (from) query.gpsTimestamp.$gte = new Date(from);
    if (to) query.gpsTimestamp.$lte = new Date(to);
  }

  const cappedLimit = Math.min(Number(limit) || 500, 5000);

  const history = await Location.find(query)
    .sort({ gpsTimestamp: -1 })
    .limit(cappedLimit)
    .lean();

  res.json({ count: history.length, imei, history: history.reverse() });
}

module.exports = { getLiveLocations, getLatestLocation, getLocationHistory };
