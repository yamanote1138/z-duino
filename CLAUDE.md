# Z-Duino — Z-Scale Model Train Controller

## Overview
Network-controlled Z-scale model train controller. ESP8266 (Wemos D1 Mini) firmware + Vue 3 webapp served via LittleFS, discoverable via mDNS at `http://ztrain.local`.

## Architecture
- **Firmware** (`firmware/z-duino/`) — Arduino sketch for ESP8266. Motor control via TB6612FNG H-bridge. WebSocket server on port 81 for real-time commands.
- **Frontend** (`frontend/`) — Vue 3 + Vite + Bootstrap 5. Throttle UI with 10-segment speed bar, smooth ramping, direction toggle, direction invert. Built to `build/data/` for LittleFS.
- **Build** (`build.sh`) — Interactive script: compiles firmware, builds frontend, flashes both to ESP8266.

## Hardware
- Wemos D1 Mini (ESP8266)
- TB6612FNG H-bridge (Motor A only)
- 12V DC power supply
- Common cathode RGB LED (4-pin through-hole)
- Pins: D1=PWMA, D2=AIN2, D3=AIN1, D4=STBY, D5=LED-R, D6=LED-G, D7=LED-B

## WebSocket Protocol (port 81)
Client sends JSON: `{"cmd": "speed", "value": 0.0-1.0}`, `{"cmd": "direction", "value": true/false}`, `{"cmd": "stop"}`, `{"cmd": "ping"}`, `{"cmd": "invert", "value": true/false}` (motor direction invert), `{"cmd": "led", "r": 0-1000, "g": 0-1000, "b": 0-1000}` (LED test mode), `{"cmd": "led_auto"}` (resume status LED)
Server responds: `{"type": "status", "name": "...", "speed": 0.0, "direction": true, "connected": true}`, `{"type": "pong"}`

## Development
```bash
cd frontend
npm install
npm run dev:all    # Vite dev server + mock WebSocket server
```

## Build & Deploy
```bash
./build.sh         # Interactive menu — option 7 builds + uploads everything
```

## Key Files
- `firmware/z-duino/z-duino.ino` — Main sketch
- `firmware/z-duino/Motor.h/.cpp` — Motor abstraction
- `firmware/z-duino/StatusLED.h/.cpp` — Status LED abstraction
- `firmware/z-duino/arduino_secrets.h` — WiFi creds (not committed, copy from .example)
- `frontend/src/js/main.js` — Vue 3 app with throttle logic
- `frontend/mock-server.js` — Mock WebSocket for local dev
- `docs/LITTLEFS.md` — LittleFS flash layout & mklittlefs parameters

## Dependencies
- Arduino: ESP8266 board package, ArduinoJson, WebSockets
- Node: Vue 3, Vite, Bootstrap 5, Font Awesome 6
