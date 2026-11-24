# WebSocket Protocol

The ESP8266 runs a WebSocket server on port 81 (subprotocol `arduino`).

**Client → Device:**
```json
{"cmd": "speed", "value": 0.0}                    // 0.0 to 1.0
{"cmd": "direction", "value": true}                // true = forward
{"cmd": "stop"}                                    // immediate stop
{"cmd": "ping"}                                    // keepalive
{"cmd": "invert", "value": true}                   // motor direction invert
{"cmd": "led", "r": 0, "g": 0, "b": 1000}         // LED test mode (0–1000 per channel); ignored without an LED
{"cmd": "led_auto"}                                // resume status LED behaviour; ignored without an LED
```

**Device → Client:**
```json
{"type": "status", "name": "Z-Duino", "speed": 0.0, "direction": true, "connected": true, "features": {"led": true}}
{"type": "pong"}
```

`features` says which optional hardware this controller was built with. Today that is `led`: the RGB status LED (`HAS_STATUS_LED`, default on). A client should treat a missing `features` (older firmware) as "everything present", and leave out or skip controls for anything reported `false`. A controller without an LED still accepts the `led` and `led_auto` commands and ignores them.

The mock server (`frontend/mock-server.ts`) implements the same protocol for local development without hardware.
