# Z-Duino — Z-Scale Model Train Controller

## Overview
Network-controlled Z-scale model train controller. ESP8266 (Wemos D1 Mini) firmware + Vue 3 webapp served via LittleFS, discoverable via mDNS at `http://ztrain.local`.

## Architecture
- **Firmware** (`firmware/z-duino/`) — Arduino sketch for ESP8266. Motor control via TB6612FNG H-bridge. WebSocket server on port 81 for real-time commands.
- **Frontend** (`frontend/`) — Vue 3 + Vite + Nuxt UI + Tailwind CSS v4 + TypeScript. Throttle UI with 10-segment speed bar, smooth ramping, direction toggle, direction invert, party mode (beat-synced techno light show on the status LED, logic in `partyBeat.ts`). Built to `build/data/` for LittleFS.
- **Build** (`build.sh`) — Interactive script: compiles firmware, builds frontend, flashes both to ESP8266.

## Hardware
- Wemos D1 Mini (ESP8266)
- TB6612FNG H-bridge (Motor A only)
- 12V DC power supply
- Common cathode RGB LED (4-pin through-hole)
- Pins: D1=PWMA, D2=AIN2, D3=AIN1, D4=STBY, D5=LED-R, D6=LED-G, D7=LED-B

## WebSocket Protocol (port 81)
Client sends JSON: `{"cmd": "speed", "value": 0.0-1.0}`, `{"cmd": "direction", "value": true/false}`, `{"cmd": "stop"}`, `{"cmd": "ping"}`, `{"cmd": "invert", "value": true/false}` (motor direction invert), `{"cmd": "led", "r": 0-1000, "g": 0-1000, "b": 0-1000}` (LED test mode / party mode), `{"cmd": "led_auto"}` (resume status LED)
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

## Testing
```bash
pio test -e native   # Firmware: hardware-free unit tests for lib/ (MotorLogic, LedTiming, Command)
cd frontend && npm test   # Frontend: Vitest — useTrainController.ts + component smoke tests
```
Both run in CI. Code touching real hardware I/O (pins, WiFi/sockets) isn't unit-tested this way — verify manually against real hardware.

## Dependency Updates
Dependabot version updates (weekly, via `.github/dependabot.yml`) plus security alerts/updates (repo setting) are both on. Don't merge Dependabot PRs one at a time — they fight over `package-lock.json`. Instead:
1. Let the PRs pile up, then check `npm audit` and open alerts (`gh api repos/{owner}/{repo}/dependabot/alerts`) for anything else to pick up.
2. On a dated branch (e.g. `deps/security-fixes-2026-11-18`), bump the deps in `frontend/` to the latest compatible versions. Never use `npm audit fix --force` — it suggests major downgrades.
3. For vulnerable transitive deps with no fixed parent release, add an `overrides` entry in `frontend/package.json`.
4. Bump the patch version in `frontend/package.json`, `package-lock.json`, and `VERSION` in `firmware/z-duino/z-duino.ino`.
5. Run `npm test` and `npm run build`, then open one rollup PR titled `vX.Y.Z: dependency updates` listing the advisories fixed and the PRs superseded.
6. Once CI (`frontend` + `firmware`) is green, squash-merge it, then comment `@dependabot close` on each superseded PR (close any that don't respond by hand).
7. Tag and publish a GitHub release `vX.Y.Z` with notes in the same format as earlier releases (Highlights / Upgrading / Full diff).

Advisories with no patched release (e.g. picomatch GHSA-fc5q-39xc-vjpf as of v2.5.2) just stay open until upstream ships a fix.

## Key Files
- `platformio.ini` — PlatformIO project config (board, ldscript, lib_deps, secrets, native test env)
- `secrets.ini` — WiFi creds & build-time config (not committed, copy from `secrets.ini.example`)
- `lib/MotorLogic/`, `lib/LedTiming/`, `lib/Command/` — hardware-independent logic, unit-tested via `pio test -e native`
- `firmware/z-duino/z-duino.ino` — Main sketch
- `firmware/z-duino/Motor.h/.cpp` — Motor abstraction
- `firmware/z-duino/StatusLED.h/.cpp` — Status LED abstraction
- `frontend/src/App.vue` — Root Vue component
- `frontend/src/composables/useTrainController.ts` — Core controller logic (WebSocket, ramping, state)
- `frontend/src/composables/partyBeat.ts` — Pure party-mode beat engine (BPM → RGB frames), unit-tested
- `frontend/src/components/` — Vue SFCs (SpeedController, LedTestPanel, DebugModal, etc.)
- `frontend/mock-server.ts` — Mock WebSocket for local dev
- `docs/LITTLEFS.md` — LittleFS flash layout & mklittlefs parameters

## Dependencies
- Firmware (PlatformIO, `espressif8266` platform): ArduinoJson, WebSockets — declared in `platformio.ini`, resolved automatically
- Node: Vue 3, Vite, Nuxt UI, Tailwind CSS v4, TypeScript
