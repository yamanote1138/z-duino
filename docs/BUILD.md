# Build & Development Setup

Full software prerequisites and the `build.sh` reference. For the condensed quickstart, see the main [README](../README.md).

## Software Prerequisites

### macOS Setup

1. **PlatformIO Core** (via Homebrew):
   ```bash
   brew install platformio
   ```
   This installs `pio`, the CLI PlatformIO uses to compile, upload, and manage dependencies.

2. **Node.js** (v18+) — via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org/):
   ```bash
   nvm install 20
   ```

That's it — the ESP8266 platform, toolchain, `mklittlefs`, `esptool`, and the `ArduinoJson`/`WebSockets` libraries are all declared in `platformio.ini` and resolved automatically the first time you run `pio run` or `./build.sh`. No separate board-package or library-install step.

### Verify Installation

```bash
pio --version                # should print version info
node --version                # v18+ required
```

## Setup

1. **Clone the repo:**
   ```bash
   git clone https://github.com/yamanote1138/z-duino.git
   cd z-duino
   ```

2. **Configure WiFi credentials:**
   ```bash
   cp firmware/z-duino/arduino_secrets.h.example firmware/z-duino/arduino_secrets.h
   ```
   Edit `arduino_secrets.h` with your WiFi SSID and password. Optionally change the mDNS hostname (default: `ztrain`) and `MAX_PWM` to tune top speed (default: `500` — about half voltage to the track, which is plenty for Z-scale).

3. **Install frontend dependencies:**
   ```bash
   cd frontend
   npm install
   cd ..
   ```

4. **Build and flash:**
   ```bash
   ./build.sh
   ```
   Select option **7** (Build + Upload All). This will:
   - Build the frontend with Vite
   - Compile the firmware with PlatformIO
   - Flash the firmware to the Wemos
   - Pack and flash the frontend filesystem (LittleFS)

## Build Script Options

| Option | Action |
|---|---|
| 1 | Build All (frontend + firmware) |
| 2 | Build Frontend only |
| 3 | Build Firmware only |
| 4 | Upload Firmware only |
| 5 | Upload LittleFS only |
| 6 | Upload All (firmware + filesystem) |
| 7 | Build + Upload All |

Under the hood, `build.sh` wraps:
- **Build Firmware** → `pio run`
- **Upload Firmware** → `pio run -t upload`
- **Upload LittleFS** → `pio run -t uploadfs` (packs `build/data/` into a LittleFS image sized from `platformio.ini`'s `board_build.ldscript`, then flashes it — see [LITTLEFS.md](LITTLEFS.md) for the partition math)

## Development

For frontend development without hardware:

```bash
cd frontend
npm run dev:all
```

This starts the Vite dev server on `http://localhost:3000` and a mock WebSocket server on port 81 that simulates the ESP8266's responses.
