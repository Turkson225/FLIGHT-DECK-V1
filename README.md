# Flight Deck V1

Flight Deck V1 is a responsive fixed-wing ground-station interface for the Turkson RC platform. It visualizes the nRF24 controller data forwarded by the receiver Nano, merges it with the NodeMCU's MPU6050 and aircraft-voltage readings, and provides a deliberately safety-interlocked bench-control workflow.

**Live dashboard:** <https://turkson225.github.io/FLIGHT-DECK-V1/>

## Hardware path

```text
TX Arduino Nano
  ├─ two joysticks (throttle, rudder, elevator, aileron)
  ├─ two potentiometers (AUX 1 and AUX 2)
  ├─ four push buttons
  ├─ buzzer and two LEDs
  └─ TX battery sensor
          │
          │ nRF24L01 control packet
          ▼
RX Arduino Nano ── owns outputs, source arbitration and failsafe
          │
          │ framed UART at 38400 baud
          ▼
NodeMCU ESP8266
  ├─ MPU6050 on I²C
  ├─ aircraft/RX battery sensor on A0
  ├─ telemetry REST API
  └─ receiver-acknowledged bench-command bridge
          │
          ▼
Flight Deck V1
```

The receiver Nano—not the browser or NodeMCU—must remain the final authority over all servo and ESC outputs.

## Dashboard capabilities

- Avionics-style primary flight display driven by MPU6050 roll and pitch
- Correctly labelled yaw rate, acceleration, angular rate, temperature and vibration estimate
- TX and aircraft battery monitoring with configurable voltage calibration
- Two live joystick plots, AUX channels and four receiver-confirmed button states
- Packet delivery, packet age, RF rate, UART health and NodeMCU freshness
- Live 30-second, 2-minute and 10-minute motion charts
- Telemetry recording and CSV export
- Persistent event log and CSV export
- Derived health score, flight-envelope guard and actionable diagnostics
- Receiver-acknowledged bench-control lease with throttle, telemetry and physical-enable interlocks
- Receiver-priority, acknowledgement-verified motor-safe / safe-authority-exit action
- Demo mode with a permanent **SIMULATED DATA** identity
- Night and daylight themes
- Desktop, tablet and phone layouts with accessible focus and reduced-motion support
- Strict telemetry whitelisting, number validation and stale-data handling

## Running locally

This is a dependency-free static site. From the repository root:

```bash
python3 -m http.server 8080
```

Open <http://localhost:8080>. Demo telemetry starts automatically.

## Connecting the NodeMCU

1. Open **Systems**.
2. Change the data source to **Direct NodeMCU / HTTPS bridge**.
3. Enter the device URL, for example `http://192.168.4.1` or `http://flightdeck.local`.
4. Select a polling interval.
5. Press **Test**, then **Save & Connect**.

The dashboard first requests `GET /api/v1/telemetry`. For telemetry-only compatibility with the previous prototype, it falls back to `GET /api/telemetry` after a 404. Bench control is enabled only for the versioned `/api/v1` API because that API supports receiver leases and acknowledgements, including the priority `POST /api/v1/control/kill` motor-safe route. That route is exposed only during an active lease and must still pass receiver-side lease and physical-enable authorization.

### GitHub Pages and a local NodeMCU

The public dashboard is HTTPS while a local NodeMCU is normally HTTP. Current Chromium browsers can request explicit Local Network Access after a user action, which is why Flight Deck uses a visible **Connect** flow instead of silently scanning the LAN. The NodeMCU must:

- allow the exact origin `https://turkson225.github.io`;
- handle `OPTIONS`, `GET` and `POST` correctly;
- return `Cache-Control: no-store`;
- never use `*` as the CORS origin for command routes; and
- issue a short-lived control lease only after physical enable is confirmed.

Cross-browser behavior is uneven. For offline field use, serve the same dashboard from NodeMCU LittleFS so it is same-origin. For remote telemetry, add an authenticated TLS relay such as Firebase or MQTT over WSS. Do not place Wi-Fi passwords, database admin secrets or private broker credentials in this public repository.

## Telemetry contract

The preferred endpoint is `GET /api/v1/telemetry`:

```json
{
  "schema": "flightdeck.telemetry.v1",
  "deviceId": "FDV1-001",
  "seq": 4812,
  "uptimeMs": 912344,
  "control": {
    "authority": "radio",
    "armed": false,
    "webEnabled": false,
    "failsafe": false,
    "lastAck": null
  },
  "link": {
    "rf": {"state": "ok", "ageMs": 18, "qualityPct": 98, "rateHz": 49.8, "lossPct": 0.4, "rpd": true},
    "uart": {"state": "ok", "ageMs": 11},
    "wifi": {"rssiDbm": -58}
  },
  "rc": {
    "channelsUs": [1500, 1498, 1000, 1502, 1260, 1900],
    "buttonsMask": 4
  },
  "imu": {
    "valid": true,
    "ageMs": 7,
    "rollDeg": 1.8,
    "pitchDeg": -0.7,
    "yawRateDps": 2.3,
    "gyroDps": {"x": 0.8, "y": -1.1, "z": 2.3},
    "accelG": {"x": 0.01, "y": 0.03, "z": 0.99},
    "temperatureC": 34.1
  },
  "power": {"aircraftV": 11.92, "txV": 11.18},
  "faults": []
}
```

Channel order is aileron, elevator, throttle, rudder, AUX 1 and AUX 2. Control channels use 1000–2000 µs. Use `null` plus a validity flag when a measurement is unavailable; never publish `NaN` or an invented zero.

The MPU6050 cannot measure absolute compass heading, altitude, airspeed or GPS position. Flight Deck intentionally shows these as not installed instead of fabricating them. The nRF24L01 also does not supply true numeric RSSI, so **radio health** is derived from packet delivery and age.

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the receiver/NodeMCU protocol, command lease, CORS rules and acceptance tests.

## GitHub Pages deployment

The site is currently published from the `main` branch repository root. Any verified update to `main` is deployed automatically to:

<https://turkson225.github.io/FLIGHT-DECK-V1/>

If Pages is reconfigured later, select **Settings → Pages → Deploy from a branch → main → /(root)**.

## Safety boundary

- Browser control is for restrained, propeller-removed bench testing only.
- Physical transmitter control is the boot and normal-flight default.
- A browser must never arm the aircraft.
- The receiver must atomically validate neutral/aligned initial channels before granting a bench lease.
- Removing the physical web-enable must end bench authority immediately at the receiver.
- The receiver must reject stale, duplicated, out-of-range or unauthorized commands.
- NodeMCU liveness alone must never renew control; loss of the browser deadman, Wi-Fi or UART must end web authority.
- A release returns to radio only when RF is fresh and safely aligned; otherwise it enters motor-safe failsafe.
- Priority STOP must install a receiver-side motor-inhibit latch that only a deliberate physical disarm/re-arm sequence can clear.
- Loss of both web and radio control must apply receiver-defined failsafe outputs.
- Validate all behavior on the bench before fitting a propeller.
