# Park on the Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Park on nose / Park on tail buttons in the throttle app, built on a controller-side guarded creep that stops on beam events.

**Architecture:** A pure `lib/GuardedCreep` (creep state machine plus the parked rules) is wired into the controller sketch beside calibration. The app runs the Mac kit's search as a pure `parkSearch.ts` over a promise-returning `creep()` in `useTrainController.ts`; `BeamPanel.vue` gets the buttons. The mock server gets a pretend loco on a loop.

**Tech Stack:** PlatformIO espressif8266 + Unity native tests, ArduinoJson 7, links2004 WebSockets; Vue 3 + Nuxt UI + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-park-on-the-mark-design.md`

## Global Constraints

- One-line code comments; one-line commit messages (50–72 chars); American English; plain docs. Commit and push to `feature/train-beam-sensor` after each task.
- Creep speed is `CAL_SPEED` (default 0.1, capped 0.15); the client can't choose a speed.
- `creep` command: `until` is `["break"]`, `["restore"]` or `["break","restore"]`; `afterMs` 0–1000; `maxMs` 1–120000; total run never exceeds `maxMs` + 1000.
- Ends: `event`, `timeout`, `aborted`. Aborted by a person's `stop`, `speed`, `direction`, `invert`, `beam_calibrate`; the sensor disconnecting, reconnecting or going quiet (1.5 s while moving); the 30 s safety timeout ("safety timeout").
- Refused (to the requester only, `{"type":"creep","id":N,"phase":"refused","detail":...}`): "no sensor connected", "calibrate the sensor first", "calibration is running", "a creep is already running", "stop the train first", "bad creep arguments".
- Parked: event end with afterMs 0 → break+forward or restore+reverse = nose; break+reverse or restore+forward = tail. Cleared by any other creep end, person speed > 0, invert, calibration starting, a beam break/restore while no creep runs, sensor disconnect or hello, reboot.
- Search numbers: back off reverse until restore, max 8000, after 450; approach forward until break, max 8000; just short forward until break, max 5000; just past reverse until break,restore, max 12500, after 450; loop forward until break, max 80000; tail: forward until restore max 8000, then reverse until break max 8000. A 500 ms stopped pause before any creep that changes direction.
- Never flash without the user present; sensor is `/dev/cu.usbserial-201420`, controller `/dev/cu.usbserial-201430`; always pass `--upload-port`.

## Review Focus

- Stop pressed between two creeps of a search: no further creep is sent, and the panel shows it stopped.
- The socket dropping mid-creep: the pending creep resolves as aborted, the search ends, the panel isn't stuck running.
- A beam event arriving after a creep already ended (timed out or aborted): ignored, never sets parked.
- Parked cleared the moment the loco moves afterwards by the throttle, and on invert.
- A creep refused (uncalibrated, train moving): the panel shows the reason and the buttons come back.

---

### Task 1: GuardedCreep library and the creep command

**Files:** Create `lib/GuardedCreep/GuardedCreep.{h,cpp}`, `test/test_guarded_creep/test_guarded_creep.cpp`; modify `lib/Command/Command.{h,cpp}`, `test/test_command/test_command.cpp`.

**Interfaces (produces):**
```cpp
enum CreepEvent { CREEP_EV_BREAK = 1, CREEP_EV_RESTORE = 2 };
struct CreepRequest { bool valid = false; bool forward = true; uint8_t until[2] = {0, 0}; uint8_t nUntil = 0; unsigned long maxMs = 0, afterMs = 0; int id = 0; };
enum CreepEnd { CREEP_NONE, CREEP_EVENT, CREEP_TIMEOUT, CREEP_ABORTED };
enum Parked { PARKED_NONE, PARKED_NOSE, PARKED_TAIL };
struct CreepOutput { const char* error = nullptr; bool motor = false; float speed = 0; bool forward = true; bool started = false; bool ended = false; CreepEnd result = CREEP_NONE; const char* detail = ""; };
class GuardedCreep {
 public:
  static constexpr float MAX_SPEED = 0.15f; static const unsigned long GRACE_MS = 1000;
  explicit GuardedCreep(float speed);
  CreepOutput start(unsigned long now, const CreepRequest& r, bool sensorPresent, bool calibrated, bool calibrating, bool motorRunning);
  CreepOutput onBeam(unsigned long now, CreepEvent e);   // also clears parked when idle
  CreepOutput tick(unsigned long now);
  CreepOutput abort(const char* why);                    // no-op when idle
  bool running() const; int id() const; bool forward() const;
  Parked parked() const; void clearParked();
  static const char* resultName(CreepEnd); static const char* parkedName(Parked);   // "event"/"timeout"/"aborted"; "nose"/"tail"/nullptr
};
```
Command: `CMD_CREEP` with `CreepRequest creep` parsed from `forward`, `until`, `maxMs`, `afterMs` (default 0), `id` (default 0); `valid` false for anything outside the Global Constraints ranges or an unknown event name. `abortsCalibration` unchanged.

- [ ] Write tests in `test_guarded_creep`: `test_refusals_in_order` (each of the six refusal strings, in the order no sensor → invalid → calibrate → calibration running → already running → moving); `test_starts_at_creep_speed` (started, motor, speed 0.1, forward as asked); `test_speed_is_capped` (0.5 → 0.15); `test_stops_on_a_single_event` (break → ended, CREEP_EVENT, speed 0); `test_waits_for_both_events_in_order` (restore first ignored, then break, then restore ends it); `test_after_ms_keeps_creeping` (event at 1000, still running at 1449, ended at 1450); `test_times_out` (no event, ended CREEP_TIMEOUT at maxMs, speed 0); `test_after_ms_past_the_limit_is_capped` (event at maxMs-100 with afterMs 1000 ends by maxMs+1000); `test_abort_stops` (detail = why, CREEP_ABORTED, speed 0; idle abort is a no-op); `test_parked_rules` (all four direction × event cases; afterMs > 0 → none; timeout → none); `test_parked_cleared_by_idle_beam_event_and_clear` (parked nose, then onBeam while idle → none; clearParked → none); `test_events_after_the_end_are_ignored` (timeout, then break → no output, parked none); `test_a_new_creep_clears_parked`. In `test_command`: `test_parses_creep`, `test_creep_two_events`, `test_creep_rejects_bad_arguments` (maxMs 0 and 120001, afterMs 1001, until [], ["pass"], three events → valid false).
- [ ] `pio test -e native`: FAIL (no library, no CMD_CREEP).
- [ ] Implement. `start` returns `error` for refusals with motor untouched.
- [ ] `pio test -e native`: all PASS. Commit "lib: guarded creep with parked rules, creep command". Push.

### Task 2: Controller integration

**Files:** Modify `firmware/z-duino/z-duino.ino` (version 2.7.0).

**Interfaces (consumes):** Task 1.

- [ ] Wire `GuardedCreep creep(CAL_SPEED)`: on `CMD_CREEP` from a person call `start`; on error send the refused message to that client only; on start broadcast `{"type":"creep","id","phase":"running"}`. Every end broadcasts `{"type":"creep","id","phase":"ended","result","detail","parked"}` (parked as name or null) and applies the motor. Before handling any person command, if `creep.running()` and (`abortsCalibration(t)` or `t == CMD_BEAM_CALIBRATE`) abort with "stopped" (stop) / "throttle used" (speed, direction, invert) / "calibration started" first. Sensor beam messages: `break`/`restore` go to `creep.onBeam` before relaying. Sensor gone, quiet, or hello: abort with the same details calibration uses, and `clearParked`. Safety timeout: abort "safety timeout" before stopping. `clearParked` on person speed > 0, invert, and calibration start. `tick` in `loop()`. The quiet-sensor check uses the tighter limit while `calibration.moving() || creep.running()`. Status `beam` gains `"parked"`.
- [ ] `pio run -e d1_mini` and with `-D HAS_STATUS_LED=0`: SUCCESS. `pio test -e native`: PASS. Commit "controller: guarded creep and parked status". Push.

### Task 3: Park search (app, pure)

**Files:** Create `frontend/src/composables/parkSearch.ts`, `frontend/test/parkSearch.test.ts`.

**Interfaces (produces):**
```ts
export type ParkTarget = 'nose' | 'tail'
export type CreepUntil = 'break' | 'restore'
export interface CreepResult { result: 'event' | 'timeout' | 'aborted' | 'refused'; detail: string; parked: ParkTarget | null }
export interface ParkDeps {
  creep(forward: boolean, until: CreepUntil[], maxMs: number, afterMs?: number): Promise<CreepResult>
  pause(ms: number): Promise<void>
  beamState(): string            // 'clear' | 'blocked' | other
  parked(): ParkTarget | null
  cancelled(): boolean
  onStep(text: string): void
}
export interface ParkResult { ok: boolean; parked: ParkTarget | null; detail: string }
export async function park(target: ParkTarget, deps: ParkDeps): Promise<ParkResult>
```
Step texts (exact): "Backing off the beam", "Creeping forward onto the beam", "Just short? Creeping forward", "Just past? Backing over the beam", "Looking round the loop (up to 80 s)", "Seating the tail: forward until it clears", "Backing the tail onto the beam". Results: ok details "Parked on nose" / "Parked on tail" / "Already parked on nose|tail"; failures: "the beam stays blocked when backing off: is something else in it?", "backed off the beam but could not find it again", "the beam did not break in 80 s: is the loco on the track?", "could not clear the beam with the tail", "cleared the beam but could not find it again with the tail", an aborted/refused creep's own detail, "stopped" when cancelled.

- [ ] Tests with a scripted fake `creep` that records each call (forward, until, maxMs, afterMs) and returns queued results: `blocked: backs off then approaches`; `clear: just short`; `clear: just past`; `clear: round the loop`; `gives up after the loop`; `tail: nose first, then seats the tail`; `tail when already parked on nose skips to the tail steps`; `already parked on the target does nothing`; `an aborted creep ends the search with its detail`; `cancelled between creeps sends no more creeps`; `pauses 500 ms before a creep that changes direction` (and not before one that doesn't). Each path asserts the exact call list with the Global Constraints numbers.
- [ ] `npx vitest run test/parkSearch.test.ts`: FAIL. Implement. PASS. Commit "frontend: park search over guarded creeps". Push.

### Task 4: App wiring and panel

**Files:** Modify `frontend/src/composables/useTrainController.ts`, `frontend/src/components/BeamPanel.vue`, `frontend/test/useTrainController.test.ts`, `frontend/test/BeamPanel.test.ts`.

**Interfaces:** consumes Task 3. Produces from `useTrainController()`: `parking: Ref<{ target: ParkTarget; step: string; running: boolean; ok?: boolean; detail?: string } | null>`, `parkLoco(target: ParkTarget): Promise<void>`; `BeamStatus` gains `parked: ParkTarget | null`.

- [ ] Tests: `creep` sends `{cmd:'creep', forward, until, maxMs, afterMs, id}` with increasing ids and resolves on the matching `ended` or `refused` (ignores other ids and `running`); a socket close resolves pending creeps as aborted "connection lost" and ends the search; `emergencyStop` during parking marks it cancelled (search sends nothing more) and still sends stop; status `beam.parked` lands in `beam`. BeamPanel: park buttons (`data-test="park-nose"`, `"park-tail"`) shown with a sensor, disabled while uncalibrated, calibrating, parking, or `currentSpeed > 0`; clicking calls `parkLoco`; step text and Stop (`calibrate-stop` reused or `park-stop`) while running; result line after; `data-test="parked"` shows "Parked on nose|tail" from status.
- [ ] `npm test`: FAIL. Implement (`pause` via setTimeout; `beamState`/`parked` read the `beam` ref; `onStep` updates `parking`). PASS; `npm run build` succeeds. Commit "frontend: park on nose and tail buttons". Push.

### Task 5: Mock loco

**Files:** Modify `frontend/mock-server.ts`.

- [ ] A pretend loco on a 134 in loop, 3 in long, beam at 0, starting 20 in short of the beam; status `beam.state` follows it; `creep` moves it at 2.35 in/s, emitting break/restore as nose/tail cross the beam, ending per the same rules (event/timeout/aborted on stop/speed/direction), setting `parked`. Refuse like the firmware when the mock sensor is uncalibrated or the train is moving.
- [ ] `npm run dev:all`, then from a scratch Node client run both parks from each start (in beam, short, past, far) and see Parked: PASS. `npm test` still PASS. Commit "mock: pretend loco for park testing". Push.

### Task 6: Docs, flash and try

**Files:** `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md` (the guarded creep as the second exception to "clients enforce motor care"), `CLAUDE.md` (protocol line, Key Files, Testing).

- [ ] Document as built. Commit "docs: guarded creep and parking". Push.
- [ ] With the user present: rebuild the app, flash the controller firmware and LittleFS on `/dev/cu.usbserial-201430`; confirm status shows `parked`; the user tries both buttons from several starting spots.
