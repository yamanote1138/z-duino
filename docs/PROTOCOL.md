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

## Beam sensor add-on

A beam sensor (`firmware/beam-sensor/`) is just another WebSocket client. It finds the controller by its mDNS `ws` service, says hello, and from then on only reports. The controller never counts it as a person: its messages don't keep the 30 s safety timer alive and don't light the status LED.

**Sensor → controller:**
```json
{"cmd": "hello", "role": "sensor", "version": "1.0.0"}
{"cmd": "beam", "event": "heartbeat", "t": 125000.0, "state": "clear", "level": 748, "clearEstimate": 746, "calibrated": true, "levels": {"clear": 747, "blocked": 235}}
{"cmd": "beam", "event": "break", "t": 123456.7, "level": 231}
{"cmd": "beam", "event": "restore", "t": 124001.2}
{"cmd": "beam", "event": "pass", "t0": 123460.1, "t1": 123998.4, "durationMs": 538.3, "minLevel": 228, "meanLevel": 236, "maxLevel": 251}
{"cmd": "beam", "event": "drift", "kind": "partial", "estimate": 512, "calibrated": 747, "sd": 3.1}
{"cmd": "beam", "event": "measured", "n": 150, "median": 747, "mean": 746.5, "sd": 6.5, "min": 735, "max": 754}
{"cmd": "beam", "event": "changed", "t": 126010.4, "level": 402}
{"cmd": "beam", "event": "calibrated", "levels": {"clear": 747, "blocked": 235}, "warnings": []}
{"cmd": "beam", "event": "calibration_failed", "error": "blocked (700) and clear (720) are only 20 counts apart (need 60+)"}
```
`t` is the sensor's own clock in milliseconds. `state` in a heartbeat is `clear`, `blocked`, or `uncalibrated` (an uncalibrated sensor sends heartbeats only).

**Controller → sensor** (calibration only):
```json
{"type": "beam_measure"}                       // collect 3 s of readings, answer "measured"
{"type": "beam_watch", "from": 747}            // answer "changed" once 2 readings sit 40% (and 150 counts) away from this
{"type": "beam_watch_off"}
{"type": "beam_levels", "a": {...}, "b": {...}} // the two measurements: derive levels, store them, answer "calibrated" or "calibration_failed"
```

**Client → controller:**
```json
{"cmd": "beam_calibrate"}   // one-button calibration: the controller creeps the loco until the beam changes
```

**Controller → clients:** every sensor `beam` message is passed on as `{"type": "beam", ...}` (without `cmd`). While the motor runs, `break`, `restore` and `pass` also get `"direction": "forward"|"reverse"`, and `break`/`restore` get `"edge": "nose"|"tail"` (forward: the nose breaks it, the tail restores it). Plus:
```json
{"type": "beam", "event": "lost"}                                                  // the sensor disconnected or went 3 s without a heartbeat
{"type": "beam", "event": "calibration", "phase": "measuring", "detail": ""}       // phases: measuring, creeping, measuring_second, done, failed
```
`status` gains `features.sensor` (a sensor is connected) and `beam`: `{"state": "clear"|"blocked"|"uncalibrated"|"lost", "level": 748, "calibrated": true, "calibrating": false}`, or `null` with no sensor.

**Calibration**, step by step: the sensor measures where the loco is (A); the controller creeps forward at `CAL_SPEED` (default 0.1, capped at 0.15) for up to 10 s, stopping as soon as the sensor reports `changed`; with no change it pauses 0.5 s and creeps in reverse for up to 20 s; after 0.5 s settled the sensor measures again (B); the higher of A and B is clear. It's refused with no sensor, while the train is moving, or while one is already running. Any `stop`, `speed` or `direction` from a client, the sensor disconnecting, or a quiet sensor ends it with the motor stopped. The loco is left where it stopped.

The mock server (`frontend/mock-server.ts`) implements the same protocol for local development without hardware, including a pretend beam sensor (`MOCK_SENSOR=0` turns it off).
