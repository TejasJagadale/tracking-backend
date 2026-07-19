# GPS Tracking Server — POC

Custom GPS tracking backend built from scratch in Node.js (no Traccar / open-source GPS platforms), per the POC requirements doc. Currently supports **GT06 (Concox V5)** and **JC261 (Jimi IoT v1.2.8)**. Teltonika Codec 8/8E and JT/T808 are not yet implemented.

**This version uses MongoDB only** — no Redis. The "live cache" that Redis used to provide (current location per device, online/offline flag) is now an embedded `lastLocation` field directly on the `Device` document, kept up to date on every packet. Reading "current position for every device" is a single indexed Mongo query instead of a separate cache round-trip.

## What's working end-to-end right now

```
GT06 / JC261 device --TCP--> Protocol Decoder --> SessionManager
                                                        |
                                                        v
                                              LocationService
                                             /                \
                                     MongoDB: Location      MongoDB: Device
                                     (full history)     (embedded lastLocation,
                                                          isOnline, lastStatus)
                                                                |
                                                                v
                                                            EventBus
                                                                |
                                                                v
                                                          Socket.IO
                                                                |
                                                                v
                                                     React + Google Maps UI
```

- **GT06 decoder** — verified against the standard GT06/Concox reference frame structure (login, GPS location, heartbeat), CRC16/X25 checksum.
- **JC261 decoder** — verified byte-for-byte against the vendor's own worked examples in `Protocal-JC261-JIMI.pdf` (login, heartbeat, location 0x22, alarm 0x95). All CRC checks pass, coordinates/timestamps decode correctly against the spec's sample hex.
- Both plug into the same `DecoderRegistry` → adding a protocol never touches the TCP server, session manager, vehicle status engine, storage, or API layers.
- REST API + Socket.IO + React/Google Maps live map — built, and the frontend build (`npm run build`) and backend syntax/module-load all verified in this sandbox.

**Not yet live-tested against a real MongoDB instance** — this sandbox has no way to install/run a database (network is locked to package registries only). The server correctly attempts to connect and waits on Mongo when it's absent, which confirms the wiring is right; you'll want to do a real smoke test against your own MongoDB before pointing real devices at it.

## Prerequisites

- Node.js 18+
- MongoDB running locally or reachable via `MONGO_URI`
- A Google Maps JavaScript API key (for the frontend)

## Backend setup

```bash
cd gps-tracking-server
npm install
cp .env.example .env      # edit MONGO_URI / ports as needed
npm run dev                # or: npm start
```

This starts:
- HTTP + Socket.IO server on `HTTP_PORT` (default 4000)
- GT06 TCP listener on `GT06_TCP_PORT` (default 5023)
- JC261 TCP listener on `JC261_TCP_PORT` (default 5029)
- An offline-sweep timer that queries Mongo every 30s and flags devices OFFLINE if no packet arrives within `OFFLINE_TIMEOUT_SECONDS`

Health check: `GET http://localhost:4000/health`

## Frontend setup

```bash
cd gps-tracking-server/frontend
npm install
cp .env.example .env      # set VITE_GOOGLE_MAPS_API_KEY and VITE_API_URL
npm run dev                 # opens on http://localhost:3000
```

## REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/devices` | All registered devices (isOnline, lastStatus, lastLocation embedded) |
| GET | `/api/devices/connected` | Devices with an active TCP session right now (in-memory, this process only) |
| GET | `/api/devices/:imei/status` | Single device document |
| GET | `/api/locations/live` | Current position for every device with a known fix (reads `Device.lastLocation`) |
| GET | `/api/locations/:imei/latest` | Latest location for one device |
| GET | `/api/locations/:imei/history?from=&to=&limit=` | GPS history from the `Location` collection |

## WebSocket events (Socket.IO)

Emitted by server → client:
- `snapshot` — sent once on connect, current state of all known devices (Mongo query on `Device.lastLocation`)
- `location:update` — `{ imei, protocol, location, status, deviceName }`
- `device:statusChange` — `{ imei, status, previousStatus }`
- `device:offline` — `{ imei }`

## Testing a device connection without real hardware

You can hand-craft a GT06 or JC261 login+location packet and pipe it at the TCP port with `nc`, using the hex frames from the vendor spec PDFs / `src/protocols/*/decoder.js`.

## What's next

- Teltonika Codec 8 / Codec 8 Extended decoder
- JT/T 808 decoder
- Admin UI for naming/labeling devices (currently devices show by IMEI until named)
- Auth on the REST/WebSocket layer (currently open — fine for POC, not for production)
- If write throughput ever becomes a bottleneck on a single Mongo instance, the `Device.lastLocation` embedded-doc pattern scales fine on its own, but you may eventually want a capped collection or TTL index tuning on `Location` for very high-frequency fleets.

