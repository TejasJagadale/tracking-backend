/**
 * NormalizedGpsData
 * The single common shape every protocol decoder (GT06, Teltonika, JT/T808, JC261)
 * must produce. Nothing downstream (VehicleStatusEngine, Mongo, WebSocket,
 * REST API) ever needs to know which wire protocol a packet came from.
 *
 * Field reference (Requirements Section 5.4):
 *   imei              string   Device ID / IMEI
 *   protocol          string   'GT06' | 'TELTONIKA_CODEC8' | 'JT808' | 'JC261'
 *   latitude           number  decimal degrees
 *   longitude          number  decimal degrees
 *   speedKmh           number
 *   heading             number  0-359
 *   altitude            number|null
 *   gpsTimestamp        Date    fix time reported by the device
 *   satellites          number|null
 *   ignition             boolean|null   ACC status
 *   gsmSignal            number|null
 *   batteryLevel         number|null
 *   raw                  object  protocol-specific extra fields kept for debugging
 */
function createNormalizedGpsData(fields) {
  return {
    imei: fields.imei,
    protocol: fields.protocol,
    latitude: fields.latitude,
    longitude: fields.longitude,
    speedKmh: fields.speedKmh ?? 0,
    heading: fields.heading ?? 0,
    altitude: fields.altitude ?? null,
    gpsTimestamp: fields.gpsTimestamp,
    satellites: fields.satellites ?? null,
    ignition: fields.ignition ?? null,
    gsmSignal: fields.gsmSignal ?? null,
    batteryLevel: fields.batteryLevel ?? null,
    raw: fields.raw ?? {},
  };
}

module.exports = { createNormalizedGpsData };
