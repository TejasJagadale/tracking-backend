const mongoose = require('mongoose');

const LocationSchema = new mongoose.Schema(
  {
    imei: { type: String, required: true, index: true },
    protocol: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    speedKmh: { type: Number, default: 0 },
    heading: { type: Number, default: 0 }, // course, degrees 0-359
    altitude: { type: Number, default: null },
    satellites: { type: Number, default: null },
    ignition: { type: Boolean, default: null }, // ACC status
    gsmSignal: { type: Number, default: null },
    batteryLevel: { type: Number, default: null },
    gpsTimestamp: { type: Date, required: true }, // device-reported fix time
    receivedAt: { type: Date, default: Date.now }, // server receipt time
    vehicleStatus: {
      type: String,
      enum: ['MOVING', 'IDLE', 'PARKED', 'OFFLINE', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
  },
  { timestamps: false }
);

// Compound index: fast "latest location" and "history in range" queries per device
LocationSchema.index({ imei: 1, gpsTimestamp: -1 });

module.exports = mongoose.model('Location', LocationSchema);
