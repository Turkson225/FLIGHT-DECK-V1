# Flight Deck V1 integration contract

This document defines the boundary between the receiver Nano, NodeMCU ESP8266 and dashboard. It is implementation guidance, not a substitute for airframe-specific failsafe testing.

## 1. Authority model

The receiver Nano is the only component allowed to select and apply actuator outputs.

| State | Output owner | Entry condition | Exit condition |
|---|---|---|---|
| `RADIO` | nRF24 transmitter | Boot/default or valid radio takeover | Physical bench enable plus valid web lease |
| `BENCH_WEB` | Receiver-validated web commands | Disarmed, throttle minimum, physical enable, atomically aligned initial command, valid lease | Physical enable removed, TX takeover, browser deadman/lease/UART expiry, release or kill |
| `FAILSAFE` | Receiver safe positions | Neither command source is fresh | Valid radio recovery or deliberate recovery policy |

Recommended starting timeouts are 150 ms for an RF warning, 300 ms for RF loss and 300 ms for web-command/heartbeat loss. Confirm the final numbers on the real airframe.

Physical web-enable deassertion is a receiver-owned, immediate exit from `BENCH_WEB`; it must not wait for the browser or NodeMCU. On every exit, select `RADIO` only when RF data is fresh, disarmed and aligned to the current safe output. Otherwise enter motor-safe `FAILSAFE`.

## 2. TX-to-RX radio packet

Transmit around 50 Hz. Serialize explicitly rather than sending a compiler-dependent C++ structure.

| Byte(s) | Field | Encoding |
|---:|---|---|
| 0 | Magic | `0xD7` |
| 1 | Version | `1` |
| 2 | Type | `0x01` control |
| 3 | Flags | arm/calibration/mode bits |
| 4–7 | Sequence | little-endian `uint32_t` |
| 8–11 | TX uptime | little-endian `uint32_t`, ms |
| 12–23 | Six channels | six `uint16_t`, 1000–2000 µs |
| 24 | Buttons | lower four bits |
| 25–26 | TX battery | `uint16_t`, mV |
| 27–28 | CRC | CRC16-CCITT-FALSE |

This 29-byte payload fits the nRF24L01 32-byte maximum. Enable the radio's hardware CRC16, auto-acknowledgement and retries. Validate magic, version, length, CRC, sequence and channel ranges before applying a packet.

Maintain an independent last-accepted sequence for the RF stream and for each UART direction. A frame is newer only when unsigned `delta = uint32_t(newSeq - lastAcceptedSeq)` is in `1..0x7fffffff`. Duplicate or older valid-CRC frames must not change actuator state, packet age, browser deadman, lease expiry or any freshness watchdog. If sender uptime regresses in a way that indicates reboot, first end web authority, invalidate every lease and enter the safe authority-selection path; only then rebaseline that sender's sequence.

The nRF24L01 does not provide a true numeric RSSI value. Export packet age, delivery percentage and the RPD threshold bit.

## 3. Nano-to-NodeMCU UART

Use 38400 baud with binary COBS framing:

```text
COBS(
  magic:u8 = 0xFD,
  version:u8 = 1,
  type:u8,
  flags:u8,
  sequence:u32,
  senderMillis:u32,
  payloadLength:u8,
  payload[0..48],
  crc16:u16
) + 0x00 delimiter
```

CRC16-CCITT-FALSE covers the decoded header and payload. Reject incorrect magic/version, impossible length, frames over 64 decoded bytes, bad CRC and partial frames that time out. Parse without blocking and without dynamic `String` allocation.

Suggested message types:

- `0x01 RADIO_STATE`: RF sequence, six channel values, button mask, TX mV, packet age, delivery and flags.
- `0x02 RX_HEALTH`: authority, failsafe reason, receiver uptime and error counters.
- `0x10 WEB_COMMAND`: lease, strictly increasing command ID, remaining TTL, channel mask/values and deadman bit.
- `0x11 COMMAND_ACK`: accepted/rejected/expired, exact reason and applied command ID.
- `0x12 NODE_HEARTBEAT`: transport-health evidence only; it must never renew control authority by itself.

The NodeMCU records a monotonic timestamp when each valid browser command body is fully received. Before UART transmission it subtracts HTTP parsing and queue age from `ttlMs` and forwards only the remaining TTL; an expired item is rejected, never made fresh again. The receiver starts its deadline from UART receipt using that smaller remaining value and accepts only a strictly newer `commandId` within that exact lease. Duplicate or backward commands cannot refresh output or watchdog state.

If `NODE_HEARTBEAT` is retained, send it only while a valid browser deadman command has arrived within the last 150 ms and include that browser-command age. Stop immediately on browser inactivity. The receiver renews `BENCH_WEB` only from a newly validated `WEB_COMMAND`, not from Node liveness alone, and exits no later than its configured 300 ms deadman bound.

### Electrical notes

- Nano D1/TX is 5 V; level-shift it before NodeMCU GPIO3/RX.
- NodeMCU 3.3 V TX is normally accepted by the Nano RX input.
- Share ground.
- D0/D1 are also used for programming and USB serial. Add a jumper or disconnect the bridge while flashing.
- Do not mix debug text into the framed production UART stream.

## 4. NodeMCU hardware tasks

- MPU6050: SDA on D2/GPIO4 and SCL on D1/GPIO5, normally address `0x68`.
- Aircraft voltage: A0 through a calibrated divider. Verify the exact board's A0 full-scale voltage before connecting the divider.
- Bridge UART: GPIO3/RX and GPIO1/TX at 38400 for the most reliable version.
- Sample the IMU around 100 Hz, calculate calibrated roll/pitch and expose Z gyro as `yawRateDps`.
- Average A0 at 10–20 Hz and publish telemetry at 5–10 Hz.
- Use non-blocking Wi-Fi reconnection and watchdog-friendly loops.

## 5. REST API

Required routes:

- `GET /api/v1/health`
- `GET /api/v1/telemetry`
- `POST /api/v1/session`
- `POST /api/v1/control`
- `POST /api/v1/control/kill`
- `POST /api/v1/control/release`
- `OPTIONS` for every cross-origin route

All responses should use `Cache-Control: no-store`. Limit request body size, validate all types and ranges, and return a machine-readable reason with 400, 401, 409 or 423 responses.

Every newly published telemetry snapshot must increment the unsigned 32-bit `seq` value and carry a nondecreasing numeric `uptimeMs`; never replay a cached JSON body as fresh data. Flight Deck requires two advancing V1 snapshots before bench control can be requested, then locks output if progression stops for one second. Use a dashboard polling interval of 200 ms or faster for bench mode.

### Session request

Only issue an unpredictable, single-owner, short-lived lease (at least 128 bits of entropy) after the physical receiver enable is active and all safety checks pass.

```json
{
  "schema": "flightdeck.session.v1",
  "action": "requestBench",
  "propellerRemoved": true,
  "initialChannelsUs": {
    "throttle": 1000,
    "roll": 1500,
    "pitch": 1500,
    "yaw": 1500
  },
  "alignmentToleranceUs": 50
}
```

Handover must be atomic. The receiver compares every requested initial channel with the currently applied, fresh radio output, verifies throttle-safe/disarmed state, preloads the bench command buffer, and only then changes authority to `web`. It rejects the request if any channel is outside tolerance. It must never switch first and wait for the browser's next heartbeat to supply neutral values.

Successful response:

```json
{
  "accepted": true,
  "leaseId": "random-short-lived-value",
  "authority": "web",
  "expiresInMs": 1000
}
```

### Control request

```json
{
  "schema": "flightdeck.command.v1",
  "leaseId": "random-short-lived-value",
  "commandId": 83,
  "issuedAt": "2026-09-17T04:18:23.000Z",
  "ttlMs": 250,
  "mode": "bench",
  "deadman": true,
  "channelsUs": {
    "roll": 1500,
    "pitch": 1500,
    "throttle": 1000,
    "yaw": 1500
  }
}
```

The HTTP response must represent the receiver Nano acknowledgement—not merely receipt by the NodeMCU:

```json
{
  "accepted": false,
  "reason": "PHYSICAL_ENABLE_REQUIRED",
  "leaseId": "random-short-lived-value",
  "authority": "radio",
  "commandId": 83
}
```

Reject expired, duplicated, non-increasing-ID, out-of-range or lease-mismatched commands. Clamp and slew outputs. `issuedAt` is an audit field, not a trusted cross-device clock; enforce the TTL using monotonic NodeMCU receipt/queue age and the receiver's own deadline.

### Priority motor-safe request

`POST /api/v1/control/kill` is a receiver-owned priority path. It bypasses normal command queue ordering, but it never bypasses authorization: the receiver must require the current unexpired, matching lease and the physical web-enable input. Reject a missing, stale or mismatched lease. Once authorized, immediately command the ESC-safe value, disarm and cancel the web lease. Select `radio` only if the RF input is fresh and aligned; otherwise select `failsafe`. Process the kill even while an earlier `/control` request is awaiting completion. The NodeMCU must not fabricate this acknowledgement.

```json
{
  "schema": "flightdeck.command.v1",
  "action": "motorSafeRelease",
  "leaseId": "random-short-lived-value",
  "commandId": 84,
  "issuedAt": "2026-09-17T04:18:24.000Z",
  "throttleUs": 1000
}
```

The response is successful only when it carries the receiver Nano's confirmed state:

```json
{
  "accepted": true,
  "leaseId": "random-short-lived-value",
  "motorSafe": true,
  "killLatched": true,
  "rearmRequired": true,
  "armed": false,
  "authority": "radio",
  "commandId": 84
}
```

`authority` is exactly `radio` for a safe fresh-radio handback or exactly `failsafe` when radio is stale/unavailable. Both are receiver-confirmed terminal outcomes; no other value is accepted by the dashboard.

The receiver must install a durable motor-inhibit latch before returning this acknowledgement. While latched, later RF packets—including armed/high-throttle packets—cannot drive the ESC. `motorSafe: true` means that latch is installed, not merely that one safe PWM sample was written. Clear it only after fresh RF is established, throttle is at minimum, the physical arm input has been observed DISARMED, and the pilot then performs a deliberate new DISARM→ARM edge. The browser and NodeMCU cannot clear this latch.

If that exact acknowledgement is missing or late, the dashboard displays **KILL UNCONFIRMED — USE PHYSICAL KILL**. It never converts a network timeout into a green success state.

### Normal release

`POST /api/v1/control/release` stops the web lease and returns `{ "accepted": true, "leaseId": "the-exact-released-lease", "motorSafe": true, "armed": false, "authority": "radio" }` only after the receiver confirms the safe transition. When RF is stale or not safely aligned, return the same fields with `authority: "failsafe"`. On a lost or mismatched reply, the dashboard stops its heartbeat and visibly waits for the receiver's independent lease timeout; it does not claim that authority has already changed.

## 6. CORS and local-network security

For the public Pages dashboard, allow the exact origin:

```text
https://turkson225.github.io
```

An origin never includes `/FLIGHT-DECK-V1/`. Do not return `Access-Control-Allow-Origin: *` on control routes. Preflight responses should allow `GET, POST, OPTIONS`, `Content-Type`, `X-FlightDeck-Session`, and include `Vary: Origin`. Current Local Network Access uses a browser permission; `Access-Control-Allow-Private-Network: true` is only relevant when deliberately supporting older Private Network Access experiments.

Exact-origin CORS is not authentication. Do not store a permanent control secret in public dashboard JavaScript. Use high-entropy, single-owner leases; keep the active lease in memory; verify it again at the receiver for every control, release and kill action; expire it on release/loss; and rate-limit commands. The dashboard exposes its network STOP action only while it holds an active receiver lease.

## 7. Acceptance tests

Run these with the propeller removed:

1. Inject corrupt, truncated and overlength UART frames; the parser must recover at the next delimiter and outputs must not jump.
2. Request handover with each radio channel just inside and just outside the alignment tolerance; authority must change atomically with no output pulse.
3. Deassert physical web-enable during active bench output; the receiver must exit immediately without waiting for HTTP, Node heartbeat or lease expiry.
4. Power off the transmitter; receiver failsafe must activate within the configured RF timeout.
5. Release/kill with fresh aligned RF and with stale RF; expect `radio` in the first case and motor-safe `failsafe` in the second.
6. Close/hide the browser, kill Wi-Fi, unplug UART and reboot NodeMCU; the web deadman must expire independently in each case.
7. Leave NodeMCU running after browser death; Node heartbeat alone must never keep or reacquire `BENCH_WEB`.
8. Delay a command in the Node queue beyond its TTL and send continuous duplicate/backward RF, UART and web-command IDs with valid CRCs; none may refresh outputs or watchdogs, and failsafe/deadman must still fire.
9. Hold a normal command request open, then issue `/control/kill`; the receiver must apply motor-safe first and return the exact kill acknowledgement.
10. After `/control/kill`, keep transmitting armed/high-throttle RF frames; ESC output must remain safe until the full physical DISARM→ARM re-arm sequence occurs.
11. Stall or truncate an HTTP JSON body; the dashboard must time out and show the action as unconfirmed.
12. Reboot each sender and simulate uptime regression; leases must be invalidated before sequence rebaselining.
13. Verify an unapproved web origin fails CORS while the Pages origin passes preflight, telemetry and command tests.
14. Disconnect MPU6050 and A0 separately; telemetry must report invalid/`null`, not a false zero.
15. Test `millis()` rollover logic and run a multi-hour soak at full RF, UART and Wi-Fi rates.
16. Range-test nRF24 while the NodeMCU transmits Wi-Fi traffic to expose 2.4 GHz coexistence problems.

The final receiver servo/ESC pin map and the exact existing TX packet layout should be confirmed before generating actuator-ready firmware.
