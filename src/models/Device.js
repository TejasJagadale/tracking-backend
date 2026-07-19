const mongoose = require('mongoose');

// Embedded snapshot of the most recent GPS fix - this is what used to live in
// Redis. Keeping it embedded on the Device document means "get current
// position for every device" is a single indexed Mongo query instead of a
// separate cache round-trip.
const CurrentLocationSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    speedKmh: { type: Number, default: 0 },
    heading: { type: Number, default: 0 },
    altitude: { type: Number, default: null },
    satellites: { type: Number, default: null },
    ignition: { type: Boolean, default: null },
    gsmSignal: { type: Number, default: null },
    batteryLevel: { type: Number, default: null },
    gpsTimestamp: { type: Date, required: true },
  },
  { _id: false }
);

// Raw, not-yet-decoded OBD payloads (fuel/mileage/RPM/DTC/etc from OB22-style
// devices) land here instead of lastLocation. Deliberately untyped/raw -
// nothing here is validated as real telemetry yet. Once the real field
// layout is confirmed against actual OB22 packets, this can be replaced with
// a proper structured schema and folded into normal location processing.
const UnverifiedObdSchema = new mongoose.Schema(
  {
    protocolNumberHex: { type: String, default: null },
    hex: { type: String, default: null },
    receivedAt: { type: Date, default: null },
  },
  { _id: false }
);

const DeviceSchema = new mongoose.Schema(
  {
    imei: { type: String, required: true, unique: true, index: true },
    protocol: {
      type: String,
      required: true,
      enum: ['GT06', 'TELTONIKA_CODEC8', 'JT808', 'JC261', 'OB22'],
    },
    name: { type: String, default: null }, // friendly / vehicle label, set later via admin
    model: { type: String, default: null }, // e.g. "Concox V5", "Teltonika FMB120"
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    lastStatus: {
      type: String,
      enum: ['MOVING', 'IDLE', 'PARKED', 'OFFLINE', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    isOnline: { type: Boolean, default: false, index: true }, // TCP-session-alive flag, replaces Redis "online set"
    lastLocation: { type: CurrentLocationSchema, default: null }, // replaces Redis "current location" cache
    lastObdRawUnverified: { type: UnverifiedObdSchema, default: null }, // see UnverifiedObdSchema note above
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Device', DeviceSchema);