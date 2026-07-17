# Contributing to Z-Duino

## Local Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html) (for firmware work): `brew install platformio`

Firmware dependencies (`espressif8266` platform, `ArduinoJson`, `WebSockets`) are declared in `platformio.ini` and resolved automatically by PlatformIO on first build — no manual install step needed. See [docs/BUILD.md](docs/BUILD.md) for the full setup walkthrough.

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
   cp secrets.ini.example secrets.ini
   ```
2. Edit `secrets.ini` with your WiFi credentials. These are PlatformIO `build_flags` merged in via `extra_configs` — gitignored, never committed.

3. Compile:
   ```bash
   ./build.sh    # select option 3 (Build Firmware)
   ```

4. Upload to a connected Wemos D1 Mini:
   ```bash
   ./build.sh    # select option 7 (Build + Upload All)
   ```

### Testing

**Firmware** — the hardware-independent logic (motor state decisions, LED timing math, WebSocket command parsing) lives in `lib/` and is unit-tested on PlatformIO's `native` platform, no device required:
```bash
pio test -e native
```
Code that touches actual hardware I/O (`Motor`, `StatusLED`'s pin writes, WiFi/sockets) isn't unit-tested this way — verify those manually against real hardware.

**Frontend** — `useTrainController.ts` (via a fake WebSocket) and a couple of component smoke tests, using Vitest:
```bash
cd frontend
npm test          # single run
npm run test:watch  # watch mode
```

### Project Structure

```
z-duino/
├── platformio.ini               # PlatformIO project config (board, ldscript, lib_deps, native test env)
├── secrets.ini.example          # WiFi creds template — copy to secrets.ini (gitignored)
├── lib/                         # Hardware-independent logic, shared by firmware + native tests
│   ├── MotorLogic/               # Motor forward/reverse/stop decision
│   ├── LedTiming/                 # StatusLED breathing/blink timing math
│   └── Command/                   # WebSocket JSON command parsing
├── test/                        # PlatformIO native (Unity) tests for lib/
│   ├── test_motor_logic/
│   ├── test_led_timing/
│   └── test_command/
├── firmware/z-duino/
│   ├── z-duino.ino              # Main sketch (WiFi, mDNS, HTTP, WebSocket)
│   ├── Motor.h / Motor.cpp      # TB6612FNG motor driver abstraction
│   └── StatusLED.h / StatusLED.cpp  # RGB status LED abstraction
├── frontend/
│   ├── src/
│   │   ├── App.vue              # Root component
│   │   ├── main.ts              # Entry point
│   │   ├── main.css             # Tailwind CSS imports
│   │   ├── components/          # Vue SFCs (SpeedController, LedTestPanel, etc.)
│   │   └── composables/
│   │       └── useTrainController.ts  # Core logic (WebSocket, ramping, state)
│   ├── test/                    # Vitest suites (composable + component smoke tests)
│   ├── index.html
│   ├── mock-server.ts           # Mock WebSocket server for local dev
│   ├── vite.config.ts           # Builds to ../build/data/ for LittleFS
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   └── package.json
├── docs/
│   ├── BUILD.md                 # Full software prerequisites & build script reference
│   ├── HARDWARE.md              # Parts list & wiring diagram
│   ├── PROTOCOL.md              # Full WebSocket protocol spec
│   ├── LITTLEFS.md              # LittleFS flash layout & mklittlefs parameters
│   └── status-led-wiring.md     # RGB LED wiring & resistor values
└── build.sh                     # Build + deploy script
```

### Key Design Decisions

- **Vue 3 Composition API with SFCs** — TypeScript throughout, `<script setup>` syntax. UI built with Nuxt UI components and Tailwind CSS v4. Icons via `@iconify-json/mdi`.
- **Singleton composable** — `useTrainController.ts` holds all state and WebSocket logic in a single composable, shared across components.
- **Client-side ramping** — speed transitions are interpolated in the browser and sent as individual WebSocket messages. The ESP8266 just applies whatever speed it receives.
- **20kHz PWM** — above audible range for Z-scale motors. Set via `analogWriteFreq(20000)` with a 0–1000 range.

### WebSocket Protocol

See **[docs/PROTOCOL.md](docs/PROTOCOL.md)** for the full spec. The mock server (`frontend/mock-server.ts`) implements the same protocol.

### Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Test against the mock server (`npm run dev:all`), and run `pio test -e native` / `npm test` if you touched anything covered above
5. Open a pull request

Keep PRs focused — one feature or fix per PR.
