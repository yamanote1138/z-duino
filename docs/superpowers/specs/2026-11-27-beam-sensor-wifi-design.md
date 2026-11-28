# Beam sensor over WiFi: design

Project 1 of 4 in moving the layout off the Mac. Status: design, not built.

## Why

The layout should run on its own: the controller Wemos and a browser, with no Mac and no USB data cable except for flashing. The user's words: "why would i need the mac for anything?" Today the beam sensor only works through USB serial into `tools/train` on the Mac, which runs the detector, the calibration and every beam-aware routine.

The bigger plan, in order (only project 1 is designed here):

1. **The sensor on WiFi, reporting to the controller, calibrated by the controller.** (This document.)
2. The controller's beam abilities in firmware: on-mark status, nudge to the mark, guarded stops.
3. The throttle app shows them: beam state, a "to the mark" button, passes.
4. Shows and sounds in the browser (shows in browser storage, the JR East sounds served from the controller and cached by the browser). The synth pack is dropped.

## What it is

The sensor becomes an **add-on** to the controller. When one is present and calibrated, the controller knows it has a beam sensor and passes its events on to every connected client. Without one, the controller behaves exactly as it does today.

The sensor does its own detection and **only reports events**. The controller decides what to do with them. In this project the controller does one thing with them besides relaying them: it **runs calibration**, driving the loco into the beam itself while the sensor measures. That's the first time the controller firmware moves the train on its own.

## Goals

- The sensor joins WiFi, finds the controller, connects to its WebSocket (port 81) and keeps reconnecting if either side restarts.
- Beam detection (break, restore, pass, drift) runs on the sensor, with the same logic and thresholds the Mac's detector uses today.
- **One-button calibration, run by the controller.** A "Calibrate sensor" button in the throttle app starts it. The controller creeps the loco until the sensor sees the beam change, stops, and has the sensor measure both levels. The sensor keeps the levels in its own flash, so they survive power cycles.
- The controller reports whether a sensor is present (`features.sensor`) and the beam's current state, and relays beam events to all clients.
- The throttle app gets the minimum needed to use this without a Mac: the calibrate button, a progress or result line, and a small beam-state indicator, shown only when `features.sensor` is true.

## Non-goals

- The controller acting on beam events outside calibration (stops, to-the-mark). Project 2.
- Any richer throttle-app beam UI (passes, to-the-mark button). Project 3.
- Shows and sounds in the browser. Project 4.
- **Making `tools/train` work over WiFi.** It stays a USB bench kit as it is today, and retires once projects 2–4 replace it.
- Streaming raw readings over WiFi. The sensor keeps printing raw `reading,micros` lines on USB serial for bench work.
- Flashing over the air.

## Anti-goals (failure even if it works)

- **The sensor must not keep the motor alive.** The controller's 30-second no-message safety stop and its connected-client count (which drives the status LED) must ignore the sensor's connection and messages. Otherwise a chatty sensor would keep a train running after every person has gone.
- **Calibration must not run the loco away.** It moves only at creep speed, has a hard time limit on every move, stops on any `stop` command from any client, and stops at once if the sensor disconnects or goes quiet.
- A controller with no sensor, or with the sensor unplugged, must behave exactly as today. Existing clients (the throttle app, the Mac tools) must keep working against the protocol they already speak.
- Anything that needs the user to move a wire or change how a board is powered. The desk layout is delicate. Both boards stay wired and powered as they are now.

## Constraints

- Hardware: both boards are Wemos D1 Minis (ESP8266, 4 MB flash). The sensor reads a phototransistor on A0 about every 20 ms (clear about 750, blocked about 235 on the layout, 10-bit ADC). The receiver is on 3V3, the emitter on 5V.
- The sensor turns WiFi back on. At one reading per 20 ms the ESP8266 copes; the 500-count gap between clear and blocked dwarfs any radio noise.
- WiFi adds a few tens of milliseconds of latency. Timing must come from the sensor's own clock, never from arrival time. At creep speed (about 2.35 in/s, speed 0.1) 100 ms of delay is about 0.25 inch, well inside the loco's length, so a creep that stops on the beam's first change stops with the loco still in the beam.
- The loco's position on the loop is unknown when calibration starts: it may be in the beam or anywhere else on the loop, and either direction might be the shorter way to the beam.
- The controller's WebSocket server (links2004 `WebSocketsServer`) allows a handful of clients (5 by default on ESP8266). The sensor takes one slot.
- The controller already registers mDNS as `ztrain.local` (`MDNS_HOSTNAME` in `secrets.ini`).
- Hardware-independent logic lives in the root `lib/` and is unit-tested with `pio test -e native` in CI. Hardware I/O is checked by hand on real hardware.
- One-line code comments, American English, light docs.

## Approaches considered

**How the boards talk.**

- **A. The sensor dials the controller (chosen).** The sensor is a WebSocket client of the controller's existing server on port 81. It identifies itself with a hello, then sends events. The controller already accepts clients; it needs to recognize the sensor, keep it out of the safety timer and the client count, and relay. Reconnecting after a controller reboot falls out naturally.
- **B. The controller dials the sensor.** The sensor runs its own server; the controller adds a WebSocket client and a way to find the sensor. More code and memory on the busier board, and nothing gained. Rejected.
- Raw readings to the controller, with detection on the controller, was ruled out by the user: the sensor detects and reports events.

**Who moves the loco during calibration.**

- The user by hand, with the throttle: simple, but needs a person to place the loco on cue.
- The Mac, driving a guarded shuttle: needs the Mac. Rejected by the user.
- **The controller (chosen by the user).** It drives the creep itself, guarded by the sensor's "the beam changed" report.

## Decided

### Calibration, end to end

1. Any client sends `{"cmd": "beam_calibrate"}`. The controller refuses (`calibration_failed`) if no sensor is connected, if the motor is running, or if a calibration is already going.
2. **First level.** The controller asks the sensor to measure where the loco is now. The sensor takes about 3 seconds of readings and reports level A (median, sd, min, max). It doesn't know yet whether A is clear or blocked.
3. **Creep until the beam changes.** The sensor watches for a big change from A: readings at least 40% of A away from A's median, and at least 150 counts, for 2 samples in a row. A hand in the beam counts too, and that's fine. The controller creeps forward at calibration speed for up to 10 seconds, stopping the instant the sensor reports `changed`. With no change, it tries reverse for up to 20 seconds. Still no change and it gives up: the loco stops and the run reports `calibration_failed` ("the beam never changed: is the emitter on, is the loco on the track?").
4. **Second level.** After the loco has stopped and settled for 500 ms, the sensor measures level B, the same way.
5. **Levels.** The higher of A and B is clear and the lower is blocked. The sensor derives its levels with the rules in `tools/train/lib/sensor/calibration.mjs` (`deriveLevels`: span at least 60 counts, the same noise and wander warnings). It stores them and starts detecting with them, then reports `calibrated` (or `calibration_failed`).
6. **The loco stays where it stopped**: in the beam if it started out of it, just clear of it if it started in it. Project 2's to-the-mark can seat it properly later.

Calibration speed comes from `secrets.ini` (`CAL_SPEED`, default 0.1), capped in firmware at 0.15. A `stop` from any client aborts the run at once and stops the motor. So does the sensor disconnecting or missing its heartbeat. Every phase change is broadcast to clients as a `calibration` progress event, so the app can show what's happening.

The decision logic (the phases, timeouts, which level is clear, when to abort) goes in a hardware-independent library in the root `lib/` (for example `lib/BeamCalibration/`). It's unit-tested under `pio test -e native`, including every abort path. The sketch only wires it to the motor and the socket.

### Sensor firmware

- **Port the detector to C++** as a hardware-independent library in the root `lib/` (for example `lib/BeamDetector/`), unit-tested under `pio test -e native`. It must reproduce the logic of `tools/train/lib/sensor/detector.mjs`: thresholds as fractions of the calibrated span (`breakFrac` 0.7, `restoreFrac` 0.8), `breakSamples` 2, `restoreSamples` 3, the pass summary with interpolated edges, and drift kinds (`low`, `high`, `noisy`, `partial`) with the same defaults (`DETECTOR_DEFAULTS`). The JS tests in `tools/train/test/sensor.test.mjs` are the reference for what correct means; port their cases.
- **Measuring and change-watching** for calibration (steps 2–4 above), on command from the controller.
- **Direction labeling stays out of the sensor.** It sends unlabeled break/restore/pass events.
- A sensor that has never been calibrated connects, reports `calibrated: false`, and sends no beam events until it is.
- **Timestamps** come from the sensor's own clock in milliseconds, with sub-millisecond precision from `micros()` and handling of its wraparound (about every 71 minutes).
- **A heartbeat** about once a second carries the current state (`clear`/`blocked`), the latest reading, the running clear-level estimate, the calibrated levels and the calibration flag.
- The raw `reading,micros` lines on USB serial stay, unchanged, so the bench tools keep working.
- WiFi credentials and the controller's host name come from `secrets.ini`, like the controller's.

### Protocol

All JSON over the controller's existing WebSocket. The exact field names are the builder's to settle; this is the shape. The authoritative version goes into `docs/PROTOCOL.md`.

Sensor → controller:

```json
{"cmd": "hello", "role": "sensor", "version": "1.0.0"}
{"cmd": "beam", "event": "break",   "t": 123456.7, "level": 231}
{"cmd": "beam", "event": "restore", "t": 124001.2}
{"cmd": "beam", "event": "pass", "t0": 123460.1, "t1": 123998.4, "durationMs": 538.3, "minLevel": 228, "meanLevel": 236, "maxLevel": 251}
{"cmd": "beam", "event": "drift", "kind": "partial", "estimate": 512, "calibrated": 747, "sd": 3.1}
{"cmd": "beam", "event": "heartbeat", "t": 125000.0, "state": "clear", "level": 748, "clearEstimate": 746, "calibrated": true, "levels": {"clear": 747, "blocked": 235}}
{"cmd": "beam", "event": "measured", "median": 747, "sd": 6.5, "min": 735, "max": 754}
{"cmd": "beam", "event": "changed", "t": 126010.4, "level": 402}
{"cmd": "beam", "event": "calibrated", "levels": {"clear": 747, "blocked": 235}, "warnings": []}
{"cmd": "beam", "event": "calibration_failed", "error": "blocked and clear are only 40 counts apart"}
```

Controller → sensor:

```json
{"type": "beam_measure"}
{"type": "beam_watch", "from": 747}
{"type": "beam_watch_off"}
{"type": "beam_levels", "a": {"median": 747, "sd": 6.5, "min": 735, "max": 754}, "b": {"median": 235, "sd": 4.0, "min": 229, "max": 241}}
```

(`beam_levels` hands the sensor both measurements so it derives and stores the levels.)

Client → controller:

```json
{"cmd": "beam_calibrate"}
```

Controller → all clients other than the sensor:

```json
{"type": "beam", "event": "break", "t": 123456.7, "level": 231, "edge": "nose", "direction": "forward"}
{"type": "beam", "event": "lost"}
{"type": "beam", "event": "calibration", "phase": "measuring" | "creeping" | "measuring_second" | "done" | "failed", "detail": "..."}
```

Sensor events are relayed as `type: "beam"` messages. The controller adds `edge`/`direction` to break, restore and pass only while the motor is running (speed > 0), using the direction at the moment it receives the event. The controller sends `lost` when no heartbeat has arrived for about 3 seconds or the sensor disconnects, and the next heartbeat after that counts as recovered.

The `status` message gains `features.sensor`: `true` while a sensor is connected, `false` otherwise. It also gains a `beam` object with the latest heartbeat (`state`, `level`, `calibrated`) and whether a calibration is running, or `null` with no sensor. Clients that don't know these fields ignore them.

### Controller firmware

- Recognizes a client as the sensor by its `hello`. Remembers which connection it is. A second sensor replaces the first.
- **Connect before hello.** Today the controller bumps `connectedClients` and resets `lastMessageTime` the moment any client connects. It must not count a connection, or let it feed the safety timer, until that connection has said something. A hello as the sensor means it never counts, even for a moment.
- **Sensor messages never touch `lastMessageTime`**, and the sensor never counts in `connectedClients`. This must have a test where the parsing allows one.
- Runs calibration as above. The calibration creep is the firmware's own move: while it runs, the 30-second safety stop doesn't apply to it (no person has to keep pinging), but its own time limits do.
- Relays beam events, tracks heartbeats for `lost`, and reports `features.sensor` and `beam` in `status`.
- Parsing of the new messages goes in `lib/Command` (or a sibling library) so it's covered by `pio test -e native`.

### Throttle app

- When `features.sensor` is true: a small beam-state indicator (clear / blocked / lost / not calibrated) and a "Calibrate sensor" button.
- The button explains in a line what will happen ("the loco will creep until it finds the beam") before it starts, shows the progress phases while running, and offers Stop, which sends the existing `stop`.
- The rest of the beam UI is project 3. Keep this small enough to fit the existing layout without a redesign.
- `frontend/mock-server.ts` gains a pretend sensor: `features.sensor` and a calibration run that walks through its phases, so the app can be developed without hardware.

### Elsewhere

- `docs/PROTOCOL.md` documents the new messages.
- `docs/ARCHITECTURE.md`: the sensor is now a WiFi client of the controller, not a USB device of the Mac. The rule "clients enforce motor care, not the firmware" gets its first exception: the controller's own calibration creep, with its limits spelled out.
- `tools/train/README.md` notes that the sensor now runs WiFi firmware, and that the bench kit still reads its USB serial lines.

## Calls I made

These are my decisions, made where a builder would otherwise have had to guess. The user can overrule any of them.

- **`tools/train` gets no WiFi support.** The user wants the Mac out, so bridging it would be effort spent on something being retired. It keeps working over USB for bench work.
- The change-detection rule (40% of A and 150 counts, 2 samples), the move limits (10 s forward, then 20 s reverse) and the 0.15 speed cap. The builder may tune the numbers on real hardware; the shape stays.
- Leaving the loco where calibration stops it, rather than backing it out.
- The controller's direction labels apply only while the motor is running.

## Left to the builder

- Where the sensor firmware lives. My call: move it from `tools/train/sensor/` to `firmware/beam-sensor/`, with its own `platformio.ini` that reads the root `secrets.ini` and the root `lib/`, since it no longer belongs to the Mac tools. Keep the `d1_mini_selftest` env. Update the bench kit's references to the new path.
- How the sensor finds the controller: resolve `MDNS_HOSTNAME` over mDNS, with an optional fixed address in `secrets.ini` as a fallback.
- How calibration is stored on the sensor (a small file in LittleFS, or EEPROM emulation).
- Exact field names, the heartbeat period, the `lost` timeout and the reconnect backoff, within the shape above.
- How the app's beam indicator and button look, within the existing design.

## How we'll know it works

- `pio test -e native` covers the C++ detector (ported cases from the JS tests), the calibration logic with all its abort paths, and the new message parsing, including the safety-timer rule.
- `cd frontend && npm test` covers the new app state and the button, against the mock server's pretend sensor. The Node suite stays green.
- On the real layout, with no Mac involved beyond flashing (sensor on USB power only), from a phone or browser:
  - press Calibrate with the loco out of the beam: it creeps, stops in the beam, and reports levels near 750 / 235;
  - again with the loco in the beam: it creeps out and reports the same levels;
  - press Stop mid-creep: the loco stops at once;
  - break the beam by hand: the indicator shows blocked;
  - unplug the sensor: `lost`; plug it back in: it recovers;
  - with the sensor connected and the app closed, a moving train still stops at the 30-second safety timeout.
- The controller is only flashed after confirming its port by its silence on serial (the sensor streams readings, the controller doesn't), always with the port passed explicitly.
