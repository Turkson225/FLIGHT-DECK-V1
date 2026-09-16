# Flight Deck V1

A high-end fixed-wing ground-control dashboard for an nRF24L01 RC system with a Nano receiver and NodeMCU telemetry bridge.

## Hardware flow

```text
TX controller
  ├─ 2 joysticks
  ├─ 2 potentiometers
  ├─ 4 push buttons
  ├─ buzzer + 2 LEDs
  └─ TX voltage sensor
       │
       │ nRF24L01
       ▼
RX Arduino Nano
       │
       │ UART
       ▼
NodeMCU
  ├─ MPU6050
  ├─ RX voltage sensor
  ├─ receives decoded RC telemetry from Nano
  └─ exposes telemetry/control API
       │
       ▼
Flight Deck V1 web dashboard
```

## Dashboard capabilities

- Responsive fixed-wing ground-control interface
- Animated attitude indicator for MPU6050 roll/pitch
- Relative yaw presentation with MPU6050 limitation clearly marked
- TX and RX battery monitoring
- RC joystick, potentiometer and push-button visualization
- nRF24L01 link-quality and packet-age monitoring
- Nano-to-NodeMCU UART status
- Safety arm/disarm state
- Explicit RC-vs-web control authority switch
- Web throttle/aileron/elevator/rudder console
- Event/telemetry log
- Demo simulation mode for development without hardware
- Configurable NodeMCU endpoint

## Expected NodeMCU API

### `GET /api/telemetry`

```json
{
  "roll": 2.4,
  "pitch": -1.1,
  "yaw": 18.0,
  "ax": 0.01,
  "ay": -0.02,
  "az": 1.0,
  "gx": 1.2,
  "gy": -0.7,
  "gz": 0.3,
  "txVoltage": 11.8,
  "rxVoltage": 11.6,
  "throttle": 42,
  "yawInput": 3,
  "pitchInput": -6,
  "rollInput": 11,
  "pot1": 50,
  "pot2": 72,
  "buttons": [0, 1, 0, 0],
  "packetAge": 24,
  "linkQuality": 98
}
```

### `POST /api/control`

```json
{
  "source": "WEB",
  "throttle": 0,
  "aileron": 0,
  "elevator": 0,
  "rudder": 0
}
```

## GitHub Pages

This project is a static site and can be hosted directly from the repository root.

1. Open the repository on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select branch **main** and folder **/(root)**.
5. Save.

The expected public URL will be:

`https://turkson225.github.io/FLIGHT-DECK-V1/`

## Important connectivity note

GitHub Pages is served over HTTPS. Browsers can block an HTTPS page from directly calling a local unsecured `http://192.168.x.x` NodeMCU endpoint because of mixed-content restrictions. For bench testing, the NodeMCU can host the dashboard locally. For reliable internet-accessible operation, use an HTTPS-capable backend/relay such as Firebase or an MQTT-over-TLS service.

## Flight safety

The dashboard UI intentionally keeps physical RC control as the default authority. Do not make browser control silently override the RC transmitter. Implement receiver-side failsafe behavior, link timeout handling, command validation, throttle-safe startup, and hardware arming checks before using the system on an aircraft.
