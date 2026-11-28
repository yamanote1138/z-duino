# Beam Sensor over WiFi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The beam sensor Wemos reports beam events over WiFi to the controller; the controller relays them and runs one-button calibration, driven from the throttle app.

**Architecture:** Pure logic lives in root `lib/` and is tested with `pio test -e native`: the detector port, calibration stats, the controller's calibration state machine, and client bookkeeping. Two thin sketches wire it to hardware: the new `firmware/beam-sensor/` (WebSocket client) and the existing controller sketch. The throttle app gets a small beam panel; the mock server gets a pretend sensor.

**Tech Stack:** PlatformIO (espressif8266, Unity for native tests), ArduinoJson 7, links2004 WebSockets (client and server), LittleFS; Vue 3 + Nuxt UI + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-beam-sensor-wifi-design.md`

## Global Constraints

- One-line code comments only; American English; light, plain docs.
- Commit messages are one line, 50–72 characters, no body.
- Never flash either board without the user present and the port confirmed (sensor streams `reading,micros` on serial; the controller is silent). Pass the port explicitly.
- Detector defaults copied from `tools/train/lib/sensor/detector.mjs`: breakFrac 0.7, restoreFrac 0.8, breakSamples 2, restoreSamples 3, estimateWindowMs 2000, driftFrac 0.2, driftAfterMs 4000, partialFrac 0.3, noisyFrac 0.1, maxPassSamples 4000 (on the board, cap the pass buffer at 512 samples; a longer pass reports no summary).
- deriveLevels: minSpan 60, maxNoiseFrac 0.05, wander warning when clear max−min > 0.3 × span.
- Calibration: measure 3000 ms; change = |v − A| ≥ 0.4 × A and ≥ 150 counts for 2 consecutive samples; forward up to 10000 ms, then reverse up to 20000 ms; settle 500 ms; `CAL_SPEED` default 0.15, the cap; heartbeat lost after 3000 ms.
- Sensor messages never touch `lastMessageTime`; the sensor never counts in `connectedClients`; a new connection counts only once it sends a non-hello message.
- tools/train gets no WiFi support. The existing serial bench path keeps working.

## Review Focus

- A `stop` arriving mid-calibration, in every phase: the motor stops and the run ends `failed` ("stopped").
- The sensor dropping or going quiet mid-creep: the motor stops at once.
- A speed/direction command from the throttle during calibration: refused or treated as abort, never mixed into the creep. (Pinned: any person motion command aborts.)
- A loco that starts in the beam: the creep finds the rise, and the higher level becomes clear.
- A controller without a sensor: `status` says `features.sensor: false`, `beam: null`, and `beam_calibrate` fails with "no sensor connected".

---

### Task 1: BeamDetector library (detector port, stats, change watch)

**Files:** Create `lib/BeamDetector/BeamDetector.h`, `lib/BeamDetector/BeamDetector.cpp`, `test/test_beam_detector/test_beam_detector.cpp`

**Interfaces (produces):**
- `struct BeamLevels { int clear; int blocked; }`
- `enum BeamEventType { BEAM_READY, BEAM_BREAK, BEAM_RESTORE, BEAM_PASS, BEAM_DRIFT }`, `enum DriftKind { DRIFT_LOW, DRIFT_HIGH, DRIFT_NOISY, DRIFT_PARTIAL }`
- `struct BeamEvent { BeamEventType type; double t; int level; bool blocked; double t0, t1, durationMs; int minLevel; double meanLevel; int maxLevel; DriftKind drift; double estimate, sd; }`
- `class BeamDetector { BeamDetector(BeamLevels); void setLevels(BeamLevels); int push(double t, int v, BeamEvent* out, int max); const char* state(); int clearEstimate(); BeamLevels levels(); }` — push returns the number of events written.
- `struct Stats { int n; int median; double mean, sd; int min, max; }`, `Stats summarize(const int* v, int n)`
- `struct Derived { bool ok; BeamLevels levels; char error[96]; char warnings[3][96]; int nWarnings; }`, `Derived deriveLevels(Stats a, Stats b)` — the higher median is clear.
- `class ChangeWatch { void start(int from); bool push(int v); }` — true once the change rule holds.

- [ ] Port every Detector case from `tools/train/test/sensor.test.mjs` (crossing, windows, stray sample, noise, start inside, sag→low drift once, half-blocked→partial once vs parked none, shallow wobble), the same `trace()` generator, LEVELS {340, 30}. Plus deriveLevels (refuses span < 60, orders a/b either way) and ChangeWatch (one stray sample ignored; a drop 750→230 fires; a rise 230→750 fires; a 100-count dip does not).
- [ ] Run `pio test -e native -f test_beam_detector`: FAIL (no library).
- [ ] Implement. Ring buffers sized for 20 ms sampling (clear window 2000 ms → 128 entries; pass ≤ 512).
- [ ] Run again: PASS. Commit.

### Task 2: Controller logic (calibration state machine, sensor-aware client bookkeeping, new commands)

**Files:** Create `lib/BeamCalibration/BeamCalibration.{h,cpp}`, `lib/Clients/Clients.{h,cpp}`, tests `test/test_beam_calibration/`, `test/test_clients/`; Modify `lib/Command/Command.{h,cpp}`, `test/test_command/test_command.cpp`

**Interfaces (produces):**
- Command: `CMD_HELLO` (with `bool isSensor` when role=="sensor"), `CMD_BEAM` (sensor message; `const char* event` is not kept — instead `char beamEvent[24]`), `CMD_BEAM_CALIBRATE`.
- `class Clients { void connected(uint8_t n); void disconnected(uint8_t n); void message(uint8_t n, bool isSensorHello); int people(); int sensor(); /* -1 none */ bool feedsSafety(uint8_t n); }` — a client is pending until its first message; a sensor hello makes it the sensor (replacing any old one); anything else makes it a person.
- `enum CalPhase { CAL_IDLE, CAL_MEASURE_A, CAL_CREEP_FWD, CAL_CREEP_REV, CAL_SETTLE, CAL_MEASURE_B, CAL_DERIVE, CAL_DONE, CAL_FAILED }`
- `struct CalOutput { bool motorChanged; float speed; bool forward; bool sendMeasure, sendWatch, sendWatchOff, sendLevels; int watchFrom; bool phaseChanged; const char* detail; }`
- `class BeamCalibration { BeamCalibration(float calSpeed); const char* start(unsigned long now, bool sensorPresent, bool motorRunning); /* nullptr = started, else refusal */ CalOutput tick(unsigned long now); CalOutput onMeasured(unsigned long now, Stats s); CalOutput onChanged(unsigned long now); CalOutput onResult(bool ok, const char* error); CalOutput abort(const char* why); CalPhase phase(); bool running(); const char* phaseName(); Stats a(); Stats b(); }` — speed clamped to ≤ 0.15. Phase names: measuring, creeping, measuring_second, done, failed.

- [ ] Tests: start refused without sensor / with motor running / while running; full run (measure A → creep fwd at 0.1 → changed → stop → settle 500 → measure B → sendLevels → result ok → done, motor stopped); fwd timeout at 10000 → reverse; reverse timeout at 20000 → failed with motor stopped; abort in each running phase stops motor; speed cap 0.5→0.15. Clients: pending client doesn't count; first non-hello makes a person; sensor hello never counts and `feedsSafety` false; second sensor replaces first; disconnect of sensor clears it. Command: hello sensor, beam with event, beam_calibrate.
- [ ] Run `pio test -e native`: FAIL. Implement. Run: PASS (all suites). Commit.

### Task 3: Sensor firmware on WiFi

**Files:** Create `firmware/beam-sensor/platformio.ini`, `firmware/beam-sensor/src/main.cpp`; Move/delete `tools/train/sensor/` (keep its `uno_r4_minima` serial-only env out; README points at the new path); `secrets.ini.example` gains `CONTROLLER_HOST` (optional fixed IP).

**Interfaces (consumes):** Task 1 library via `lib_extra_dirs = ../../lib`; root `secrets.ini` via `extra_configs = ../../secrets.ini`.

- [ ] Sketch: WiFi STA, mDNS-resolve `MDNS_HOSTNAME` (fallback `CONTROLLER_HOST`), `WebSocketsClient` to :81 with `setReconnectInterval(2000)`, hello on connect; 20 ms sampling keeps printing `reading,micros`; detector events → `beam` JSON; heartbeat every 1000 ms; handles `beam_measure` (3000 ms collect → `measured`), `beam_watch`/`beam_watch_off`, `beam_levels` (deriveLevels → save to LittleFS `/levels.json` → `calibrated` or `calibration_failed`). Loads levels at boot. Self-test env kept.
- [ ] `pio run -d firmware/beam-sensor` and `-e d1_mini_selftest`: SUCCESS. Commit.

### Task 4: Controller firmware integration

**Files:** Modify `firmware/z-duino/z-duino.ino`, `secrets.ini.example` (`CAL_SPEED`), `platformio.ini` (default `CAL_SPEED` if missing via `#ifndef` in the sketch).

- [ ] Wire Clients (connectedClients → `clients.people()`, safety timer only for `feedsSafety`), relay `beam` (adds edge/direction while speed > 0, from the raw JSON), heartbeat tracking → `lost`, `status` gains `features.sensor` and `beam`, calibration driven by `BeamCalibration` in `loop()`; any person `speed`/`direction`/`stop` during a run aborts it; safety timeout ignores the calibration's own move.
- [ ] `pio run -e d1_mini` and `pio test -e native`: SUCCESS / PASS. Commit.

### Task 5: Throttle app beam panel and mock sensor

**Files:** Modify `frontend/src/composables/useTrainController.ts`, `frontend/src/App.vue`, `frontend/mock-server.ts`; Create `frontend/src/components/BeamPanel.vue`, `frontend/test/BeamPanel.test.ts`; extend `frontend/test/useTrainController.test.ts`.

**Interfaces (produces):** controller exposes `hasSensor: Ref<boolean>`, `beam: Ref<{state, level, calibrated, calibrating} | null>`, `calibration: Ref<{phase, detail} | null>`, `calibrateSensor(): void`.

- [ ] Tests: status with `features.sensor` sets `hasSensor`; a `beam` calibration message updates `calibration`; `calibrateSensor` sends `{"cmd":"beam_calibrate"}`; BeamPanel hidden without sensor, shows state, button sends, Stop shown while calibrating.
- [ ] `npm test` FAIL → implement → PASS. `npm run build` succeeds. Mock server: `MOCK_SENSOR=1` (default on) reports a sensor and walks the phases over ~6 s. Commit.

### Task 6: Docs

**Files:** `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` (Key Files, Testing), `tools/train/README.md`, `docs/BUILD.md` (flashing the sensor).

- [ ] Document the messages as built and the calibration exception to "clients enforce motor care". Commit.
