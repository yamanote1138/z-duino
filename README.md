# Z-Duino

[![CI](https://github.com/yamanote1138/z-duino/actions/workflows/ci.yml/badge.svg)](https://github.com/yamanote1138/z-duino/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
![ESP8266](https://img.shields.io/badge/ESP8266-Arduino-00979D?logo=arduino&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Nuxt UI](https://img.shields.io/badge/Nuxt_UI-4-00DC82?logo=nuxtdotjs&logoColor=white)

A network-controlled Z-scale model train controller. An ESP8266 (Wemos D1 Mini) drives a TB6612FNG H-bridge motor driver, serving a webapp over WiFi that lets you control your train from any browser on the local network.

Discoverable via mDNS at `http://ztrain.local`.

## Screenshot

![Z-Duino throttle UI](docs/resources/screenshot.png)

## Features

- **Throttle UI** — 10-segment speed bar with colour-coded zones (red/yellow/green), smooth ramping between speed steps
- **Direction control** — forward/reverse toggle with automatic ramp-down-switch-ramp-up when the train is moving
- **Direction invert** — swap forward/reverse polarity to match your track wiring (persisted in browser)
- **Emergency stop** — immediate halt, bypasses ramping, magenta LED blink
- **Status LED** — RGB LED indicates connection and motor state; supports manual colour control via LED test panel
- **Safety timeout** — train stops automatically if the controller loses contact for 30 seconds
- **Zero external dependencies** — everything served from the device itself, no internet required
- **mDNS discovery** — no need to remember IP addresses

## Hardware

Wemos D1 Mini (ESP8266) → TB6612FNG H-bridge → track, plus an RGB status LED. Full parts list, wiring diagram, and pinout live in **[docs/HARDWARE.md](docs/HARDWARE.md)**.

## Software Prerequisites

### macOS Setup

1. **Arduino CLI** (via Homebrew):
   ```bash
   brew install arduino-cli
   ```

2. **ESP8266 board package** — add the board manager URL, then install:
   ```bash
   arduino-cli config init  # creates ~/Library/Arduino15/arduino-cli.yaml
   arduino-cli config add board_manager.additional_urls \
     http://arduino.esp8266.com/stable/package_esp8266com_index.json
   arduino-cli core update-index
   arduino-cli core install esp8266:esp8266
   ```
   This installs the board definitions, toolchain, `mklittlefs`, and `esptool` under:
   ```
   ~/Library/Arduino15/packages/esp8266/
   ```

3. **Arduino libraries:**
   ```bash
   arduino-cli lib install ArduinoJson WebSockets
   ```
   Libraries install to `~/Arduino/libraries/`.

4. **Node.js** (v18+) — via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org/):
   ```bash
   nvm install 20
   ```

### Verify Installation

```bash
arduino-cli version          # should print version info
arduino-cli core list        # should show esp8266:esp8266
arduino-cli lib list         # should show ArduinoJson and WebSockets
node --version               # v18+ required
```

`mklittlefs` and `esptool` don't need to be on your PATH — `build.sh` finds them automatically inside `~/Library/Arduino15/`.

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
   - Compile the firmware with arduino-cli
   - Flash the firmware to the Wemos
   - Pack and flash the frontend filesystem (LittleFS)

## Usage

1. Power up the Wemos D1 Mini (USB or external 5V)
2. Connect your 12V supply to the TB6612FNG
3. Open a browser and navigate to **http://ztrain.local**
   - If mDNS isn't working on your network, check the serial monitor (115200 baud) for the device's IP address
4. Use the throttle:
   - **Speed segments 1–10** — click to ramp to that speed level. Click a lit segment to ramp back down.
   - **FWD / REV** — toggle direction. If the train is moving, it will smoothly ramp down, switch, and ramp back up.
   - **Brake** — smooth ramp to stop
   - **E-Stop** — immediate stop

> **Z-scale note:** These locomotives are tiny and light. Don't be surprised if nothing happens at low power — it's normal for a Z-scale train to sit still until 40–50% throttle, then take off suddenly once it overcomes static friction. This isn't a bug; it's just how small motors behave at low voltage. You may want to start around segment 4 and work up from there.

## Development

For frontend development without hardware:

```bash
cd frontend
npm run dev:all
```

This starts the Vite dev server on `http://localhost:3000` and a mock WebSocket server on port 81 that simulates the ESP8266's responses.

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

## WebSocket Protocol

The ESP8266 runs a WebSocket server on port 81 (subprotocol `arduino`).

**Client → Device:**
```json
{"cmd": "speed", "value": 0.0}                    // 0.0 to 1.0
{"cmd": "direction", "value": true}                // true = forward
{"cmd": "stop"}                                    // immediate stop
{"cmd": "ping"}                                    // keepalive
{"cmd": "invert", "value": true}                   // motor direction invert
{"cmd": "led", "r": 0, "g": 0, "b": 1000}         // LED test mode (0–1000 per channel)
{"cmd": "led_auto"}                                // resume status LED behaviour
```

**Device → Client:**
```json
{"type": "status", "name": "Z-Duino", "speed": 0.0, "direction": true, "connected": true}
{"type": "pong"}
```

## License

MIT
