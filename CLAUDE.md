# Z-Duino — Z-Scale Model Train Controller

## Overview
Network-controlled Z-scale model train controller. ESP8266 (Wemos D1 Mini) firmware + Vue 3 webapp served via LittleFS, discoverable via mDNS at `http://ztrain.local`.

## Architecture
- **Firmware** (`firmware/z-duino/`) — Arduino sketch for ESP8266. Motor control via TB6612FNG H-bridge. WebSocket server on port 81 for real-time commands.
- **Frontend** (`frontend/`) — Vue 3 + Vite + Nuxt UI + Tailwind CSS v4 + TypeScript. Throttle UI with 10-segment speed bar, smooth ramping, direction toggle, direction invert, party mode (beat-synced techno light show on the status LED, logic in `partyBeat.ts`). Built to `build/data/` for LittleFS.
- **Build** (`build.sh`) — Interactive script: compiles firmware, builds frontend, flashes both to ESP8266.
- **Beam sensor** (`firmware/beam-sensor/`) — optional add-on Wemos: detects beam breaks (`lib/BeamDetector`), calibrates on the controller's command, and reports events to the controller as a WebSocket client. The controller relays them and runs one-button calibration (`lib/BeamCalibration`), the one time the firmware moves the train on its own.
- **Mac tools** (`tools/train/`) — Node (22+, no dependencies) toolchain that runs on the Mac, not the Wemos: beam sensor over USB serial, sound library (afplay), JSON shows, a web page on `127.0.0.1:4040`. A WebSocket client of the controller like the browser. Settings: `tools/train/local/config.jsonc` (template `tools/train/config.example.jsonc`). Tests: `cd tools/train && node --test --test-timeout=30000 test/*.test.mjs`. Details: `tools/train/README.md`.
- **Read `docs/ARCHITECTURE.md`** for what runs where, who enforces motor care (the clients, not the firmware), and where each setting lives.

## Hardware
- Wemos D1 Mini (ESP8266)
- TB6612FNG H-bridge (Motor A only)
- 12V DC power supply
- Common cathode RGB LED (4-pin through-hole) — **optional**: build with `-D HAS_STATUS_LED=0` in `secrets.ini` if none is fitted (default on). The status message reports `features.led`; the app and the Mac tools hide or skip LED features when it is false.
- Pins: D1=PWMA, D2=AIN2, D3=AIN1, D4=STBY, D5=LED-R, D6=LED-G, D7=LED-B (D5-D7 only with the LED)

## WebSocket Protocol (port 81)
Client sends JSON: `{"cmd": "speed", "value": 0.0-1.0}`, `{"cmd": "direction", "value": true/false}`, `{"cmd": "stop"}`, `{"cmd": "ping"}`, `{"cmd": "invert", "value": true/false}` (motor direction invert), `{"cmd": "led", "r": 0-1000, "g": 0-1000, "b": 0-1000}` (LED test mode / party mode), `{"cmd": "led_auto"}` (resume status LED), `{"cmd": "beam_calibrate"}` (controller-driven sensor calibration), `{"cmd": "creep", "forward": true, "until": ["break"], "maxMs": 8000}` (guarded creep the controller stops on a beam event; the app's Park on nose/tail buttons chain these). The beam sensor connects as a client too: `{"cmd": "hello", "role": "sensor"}`, then `{"cmd": "beam", "event": ...}` messages; see `docs/PROTOCOL.md`.
Server responds: `{"type": "status", "name": "...", "speed": 0.0, "direction": true, "connected": true, "features": {"led": true}}` (`features` = hardware fitted; absent on older firmware, which clients treat as "everything present"), `{"type": "pong"}`, and with a sensor `features.sensor`, a `beam` object in status, and relayed `{"type": "beam", ...}` events. Without an LED, `led` and `led_auto` are accepted and ignored.

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

## Testing
```bash
pio test -e native   # Firmware: hardware-free unit tests for lib/ (MotorLogic, LedTiming, Command, Clients, BeamCalibration, BeamDetector, GuardedCreep)
cd frontend && npm test   # Frontend: Vitest — useTrainController.ts + component smoke tests
```
Both run in CI. Code touching real hardware I/O (pins, WiFi/sockets) isn't unit-tested this way — verify manually against real hardware.

## Key Files
- `platformio.ini` — PlatformIO project config (board, ldscript, lib_deps, secrets, native test env)
- `secrets.ini` — WiFi creds & build-time config (not committed, copy from `secrets.ini.example`)
- `lib/MotorLogic/`, `lib/LedTiming/`, `lib/Command/`, `lib/Clients/`, `lib/BeamCalibration/`, `lib/BeamDetector/`, `lib/GuardedCreep/` — hardware-independent logic, unit-tested via `pio test -e native`
- `firmware/beam-sensor/` — beam sensor sketch (`pio run -d firmware/beam-sensor`), reads the root `secrets.ini` and `lib/`
- `firmware/z-duino/z-duino.ino` — Main sketch
- `firmware/z-duino/Motor.h/.cpp` — Motor abstraction
- `firmware/z-duino/StatusLED.h/.cpp` — Status LED abstraction (no-op stand-in when `HAS_STATUS_LED=0`)
- `frontend/src/App.vue` — Root Vue component
- `frontend/src/composables/useTrainController.ts` — Core controller logic (WebSocket, ramping, state)
- `frontend/src/composables/parkSearch.ts` — Park on nose/tail search over guarded creeps, unit-tested
- `frontend/src/composables/showHost.ts`, `macShow.ts` — run the Mac kit's show engine (`tools/train/lib/show`) in the app: throttle, beam and Web Audio glue
- `frontend/src/composables/measureLoco.ts` — Measure loco: laps and passes give the speed model and length, saved in the browser's localStorage
- `frontend/src/shows/jr-lap.json` — the JR lap show; its sounds come from `frontend/scripts/import-sounds.sh` (git-ignored, needs `../jr-esu-sound-profiles`)
- `frontend/src/composables/partyBeat.ts` — Pure party-mode beat engine (BPM → RGB frames), unit-tested
- `frontend/src/components/` — Vue SFCs (SpeedController, LedTestPanel, DebugModal, etc.)
- `frontend/mock-server.ts` — Mock WebSocket for local dev
- `docs/LITTLEFS.md` — LittleFS flash layout & mklittlefs parameters
- `docs/ARCHITECTURE.md` — what runs where, authority and safety rules, configuration map
- `tools/train/` — Mac-side toolchain (see its README)

## Dependencies
- Firmware (PlatformIO, `espressif8266` platform): ArduinoJson, WebSockets — declared in `platformio.ini`, resolved automatically
- Node: Vue 3, Vite, Nuxt UI, Tailwind CSS v4, TypeScript
