const Device = require('../../models/Device');
const sessionManager = require('../../core/SessionManager');

// GET /api/devices - all registered devices, isOnline flag straight from Mongo
async function listDevices(req, res) {
  const devices = await Device.find().sort({ lastSeenAt: -1 }).lean();
  res.json({ count: devices.length, devices });
}

// GET /api/devices/connected - devices with an active TCP session right now
// (in-memory, per-process - distinct from the persisted isOnline flag, which
// also survives a server restart until the offline sweep catches up)
async function listConnectedDevices(req, res) {
  const imeis = sessionManager.getActiveImeis();
  res.json({ count: imeis.length, imeis });
}

// GET /api/devices/:imei/status
async function getDeviceStatus(req, res) {
  const { imei } = req.params;
  const device = await Device.findOne({ imei }).lean();
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json(device);
}

module.exports = { listDevices, listConnectedDevices, getDeviceStatus };
