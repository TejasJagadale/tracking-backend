const mongoose = require('mongoose');

const RawPacketSchema = new mongoose.Schema({
  imei: { type: String, default: null, index: true },
  protocol: { type: String, required: true },
  direction: { type: String, enum: ['IN', 'OUT'], required: true },
  hex: { type: String, required: true },
  protocolNumberHex: { type: String, default: null },
  parsedOk: { type: Boolean, default: true },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: { expires: '7d' } }, // auto-prune after 7 days
});

module.exports = mongoose.model('RawPacket', RawPacketSchema);
