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
{"type": "beam", "event": "lost"}                                                  // the sensor disconnected or went quiet
{"type": "beam", "event": "calibration", "phase": "measuring", "detail": ""}       // phases: measuring, creeping, measuring_second, done, failed
```
`status` gains `features.sensor` (a sensor is connected) and `beam`: `{"state": "clear"|"blocked"|"uncalibrated"|"lost", "level": 748, "calibrated": true, "calibrating": false}`, or `null` with no sensor.

**Calibration**, step by step: the sensor measures where the loco is (A); the controller creeps forward at `CAL_SPEED` (default 0.15, the cap) for up to 10 s until the sensor reports `changed`, then carries on 0.3 s (so the loco is well past the beam's edge) and stops; with no change it pauses 0.5 s and creeps in reverse for up to 20 s; after 0.5 s settled the sensor measures again (B); the higher of A and B is clear. It's refused with no sensor, while the train is moving, or while one is already running. Any `stop`, `speed`, `direction` or `invert` from a client, the sensor disconnecting or reconnecting, or a quiet sensor (1.5 s without a message while the loco moves, 3 s otherwise) ends it with the motor stopped. A refusal goes only to the client that asked. The loco is left where it stopped.

## Guarded creep and parking

A person's client can ask the controller to creep the loco and stop it on the board the moment the beam does something:

```json
{"cmd": "creep", "forward": true, "until": ["break"], "maxMs": 8000, "afterMs": 0, "id": 7}
```
- `until`: `["break"]`, `["restore"]` or `["break", "restore"]`, in that order.
- `afterMs` (0–1000): keep creeping that long after the last event. `maxMs` (1–120000): the time limit. A creep never runs longer than `maxMs` + 1 s.
- `id`: echoed back. Speed is always `CAL_SPEED` (default 0.15, the cap).

Replies (to every person's client, except refusals, which go only to the one who asked):
```json
{"type": "creep", "id": 7, "phase": "running"}
{"type": "creep", "id": 7, "phase": "ended", "result": "event", "detail": "", "parked": "nose"}   // result: event | timeout | aborted
{"type": "creep", "id": 7, "phase": "refused", "detail": "calibrate the sensor first"}
```
Refusals: `no sensor connected`, `bad creep arguments`, `calibrate the sensor first`, `calibration is running`, `a creep is already running`, `stop the train first`. A creep is aborted (motor stopped) by a person's `stop` ("stopped"), `speed`, `direction` or `invert` ("throttle used"), `beam_calibrate` ("calibration started"), the sensor disconnecting, reconnecting or going quiet for 1.5 s, and the 30 s safety timeout ("safety timeout"). Unlike calibration, a creep does not pause the safety timeout: the client that asked for it keeps pinging.

**Parked.** `status.beam.parked` is `"nose"`, `"tail"` or `null`. A creep that ends on its events with `afterMs` 0 sets it: a break while forward or a restore while reversing is the nose at the beam; a break while reversing or a restore while forward is the tail. Any other creep, a person's speed above 0, `invert`, calibration, the beam changing with nothing moving, the sensor dropping, or a reboot clears it.

The throttle app's **Park on nose** and **Park on tail** buttons string creeps together (`frontend/src/composables/parkSearch.ts`): if the beam is blocked, back off and come forward onto it; otherwise try just short (5 s), then just past (back over the beam, then forward), then round the loop (80 s). Park on tail finds the nose first, then goes forward until the tail clears and backs it onto the beam.

The mock server (`frontend/mock-server.ts`) implements the same protocol for local development without hardware, including a pretend beam sensor and a loco on a 134 in loop that creeps and parks (`MOCK_SENSOR=0` turns the sensor off).
