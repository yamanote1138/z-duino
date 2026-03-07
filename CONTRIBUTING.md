# Contributing to Z-Duino

## Local Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Arduino CLI](https://arduino.github.io/arduino-cli/) (for firmware work)
- ESP8266 board package: `arduino-cli core install esp8266:esp8266`
- Arduino libraries:
  ```bash
  arduino-cli lib install ArduinoJson
  arduino-cli lib install WebSockets
  ```

### Frontend Development

No hardware required. A mock WebSocket server simulates the ESP8266.

```bash
cd frontend
npm install
npm run dev:all
```

This starts:
- **Vite dev server** on `http://localhost:3000` (with hot reload)
- **Mock WebSocket server** on port 81 (simulates device responses)

Open `http://localhost:3000` in your browser. The throttle UI is fully functional against the mock server — speed changes, direction toggles, and connection status all work.

### Firmware Development

1. Copy the secrets template:
   ```bash
   cp firmware/z-duino/arduino_secrets.h.example firmware/z-duino/arduino_secrets.h
   ```
2. Edit `firmware/z-duino/arduino_secrets.h` with your WiFi credentials.

3. Compile:
   ```bash
   ./build.sh    # select option 3 (Build Firmware)
   ```

4. Upload to a connected Wemos D1 Mini:
   ```bash
   ./build.sh    # select option 7 (Build + Upload All)
   ```

### Project Structure

```
z-duino/
├── firmware/z-duino/
│   ├── z-duino.ino              # Main sketch (WiFi, mDNS, HTTP, WebSocket)
│   ├── Motor.h / Motor.cpp      # TB6612FNG motor driver abstraction
│   └── arduino_secrets.h.example
├── frontend/
│   ├── src/
│   │   ├── index.html           # Vue 3 app (inline templates, no SFC)
│   │   ├── js/main.js           # App logic, WebSocket, ramping
│   │   └── css/style.css        # Dark theme styles
│   ├── mock-server.js           # Mock WebSocket server for local dev
│   ├── vite.config.js           # Builds to ../build/data/ for LittleFS
│   └── package.json
└── build.sh                     # Build + deploy script
```

### Key Design Decisions

- **Vue 3 Options API with inline templates** — no single-file components. The HTML lives in `index.html` with Vue directives. This keeps the build simple and the output small enough for LittleFS (~616KB).
- **Client-side ramping** — speed transitions are interpolated in the browser and sent as individual WebSocket messages. The ESP8266 just applies whatever speed it receives.
- **20kHz PWM** — above audible range for Z-scale motors. Set via `analogWriteFreq(20000)` with a 0–1000 range.
- **Font Awesome solid only** — we strip TTF files and brand/regular icon sets post-build to keep the LittleFS image small.

### WebSocket Protocol

The device runs a WebSocket server on port 81 with the `arduino` subprotocol.

**Client → Device:**
| Command | Payload |
|---|---|
| Set speed | `{"cmd": "speed", "value": 0.0}` (0.0–1.0) |
| Set direction | `{"cmd": "direction", "value": true}` (true=fwd) |
| Stop | `{"cmd": "stop"}` |
| Keepalive | `{"cmd": "ping"}` |

**Device → Client:**
| Message | Payload |
|---|---|
| Status update | `{"type": "status", "speed": 0.0, "direction": true, "connected": true}` |
| Pong | `{"type": "pong"}` |

The mock server (`frontend/mock-server.js`) implements the same protocol.

### Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Test against the mock server (`npm run dev:all`)
5. Open a pull request

Keep PRs focused — one feature or fix per PR.
