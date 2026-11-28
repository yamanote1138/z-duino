# Park on the mark: design

Projects 2 and 3 from the beam sensor work. Builds on `2026-11-27-beam-sensor-wifi-design.md` (the WiFi sensor, the relay, one-button calibration), which is done and working on the hardware.

## Why

The Mac is out of the picture: the controller and a browser run everything. The beam sensor is an add-on that, when present and calibrated, lets the controller know things about the loco (in the user's words: "is loco on mark, nudge to mark, shows, loco is passing"). Shows come later (project 4). They start from a known spot, so the first thing they need is a way to put the loco there from wherever it is, from the throttle app, without the Mac kit.

## What it is

- **Two parking spots**, both defined by the beam:
  - **Nose**: the nose just at the beam, loco short of it (heading forward, about to enter).
  - **Tail**: the tail just past the beam, loco beyond it.
  ```
  park on nose:   [=====>|        nose just at the beam
  park on tail:         |[=====>  tail just past the beam
                        ^ beam
  ```
- Two buttons in the throttle app, **Park on nose** and **Park on tail**. Each works from wherever the loco is: on the track somewhere, sitting in the beam, just short, just past.
- Afterwards every client sees **Parked on nose** / **Parked on tail** until the loco moves.
- **Passing** needs nothing new: the controller already relays `break` (with edge and direction), `restore` and `pass` (with duration) to every client. Shows will use those as triggers. The app doesn't need to show them.

## Goals

- A guarded creep the controller runs itself: creep at creep speed, stop on the board the instant the sensor reports the named beam event(s), or when its time limit runs out.
- The parking search runs in the app as a few guarded creeps in a row, same search as the Mac kit's `returnToMark` (`tools/train/lib/track/mark.mjs`).
- The controller reports `parked: "nose" | "tail" | null` in its status, worked out from how a guarded creep ended.
- The app's beam panel gets the two park buttons, progress text, Stop, and the parked line.
- The mock server simulates a loco on a loop so all of this can be developed without hardware.

## Non-goals

- Nudge buttons (short manual creeps). The user said no.
- Shows, sounds, LED effects tied to beam events (project 4).
- Merging the split passes a truck-height beam can produce (see Risks). Project 4 deals with it if it still matters after the beam is raised.
- Lap timing or a learned loop length.
- Any change to `tools/train`.

## Anti-goals (failure even if it works)

- The firmware ever moving the loco faster than creep speed on its own.
- A guarded creep that doesn't stop on its beam event.
- A phone locking or a browser tab closing that leaves the loco creeping past its own time limit.
- "Parked" shown when the loco has moved since.

## Constraints

- ESP8266 controller (4 KB stack, no big locals). Pure logic goes in a root `lib/` module and is unit-tested with `pio test -e native`; the sketch only wires it.
- Creep speed is the existing `CAL_SPEED` (default 0.15, the cap). The client can't choose a speed.
- The app is Vue 3 + Nuxt UI + Vitest, the existing `useTrainController.ts` and `BeamPanel.vue`.
- One-line code comments, one-line commit messages, American English, plain docs. Commit and push straight to `feature/train-beam-sensor`.
- Hardware: the beam is at truck height and the test loco has 3 trucks. Levels on the sensor: clear 716, blocked 0. At creep speed 0.1 the loco moves about 2.35 in/s; the loop is about 134 in.

## Approaches considered

- **A. The controller runs the whole search** (a second state machine beside calibration). Safe without the app, but the most new C++, and shows would still need a separate guarded-move command later.
- **B. The app drives the throttle and stops on events it hears.** Dropped: every stop goes sensor → controller → phone → controller, about half an inch late at creep speed, and a sleeping phone leaves the loco creeping until the 30 s safety timeout.
- **C. One guarded creep on the controller; the app strings them together.** Chosen by the user. Stops are as tight as A (on the board), a sleeping phone at worst leaves one creep to end on its own limit, shows get the exact command they'll need, and the search logic lives in TypeScript where it's easy to test and change.

## Decided

### The guarded creep (controller)

Command from a person's client:
```json
{"cmd": "creep", "forward": true, "until": ["break"], "maxMs": 8000, "afterMs": 0, "id": 7}
```
- `until`: one or two beam events, in order: `["break"]`, `["restore"]`, `["break", "restore"]`. The creep ends when they've happened in that order.
- `afterMs` (0–1000): keep creeping this long after the last event, to get well clear of an edge.
- `maxMs`: the time limit, capped at 120000.
- `id`: the client's number for this creep, echoed back so the app can match the result.
- Speed is always creep speed. It starts and stops without a ramp, as calibration does (allowed at creep speed).

Refused, with a reason sent only to the requester:
- no sensor connected; sensor not calibrated; calibration running; a creep already running; the train moving; bad arguments.

Ends, always with the motor stopped:
- `event`: the `until` events happened (plus `afterMs`).
- `timeout`: `maxMs` ran out first.
- `aborted`: a person's `stop`, `speed`, `direction` or `invert`; the sensor disconnecting, reconnecting or going quiet (1.5 s while moving, the same rule as calibration); a `beam_calibrate` request.

Messages to every person's client:
```json
{"type": "creep", "id": 7, "phase": "running"}
{"type": "creep", "id": 7, "phase": "ended", "result": "event" | "timeout" | "aborted", "detail": "...", "parked": "nose" | "tail" | null}
```

The 30 s safety timeout still applies: unlike calibration, a creep is something a person's client asked for, and that client keeps pinging (every 10 s). If the app goes away mid-creep, the creep still ends on its own events or limit.

### Parked (controller)

- A creep that ends on `event` with `afterMs` 0 sets `parked` from its direction and last event:
  - break while forward → nose; restore while reverse → nose
  - break while reverse → tail; restore while forward → tail
- Anything else clears it: any other creep result, any person speed above 0, calibration starting, the beam changing state while the motor is stopped (someone moved it by hand), the sensor disconnecting, a reboot.
- Status gains `"parked": "nose" | "tail" | null` inside `beam`.

### The parking search (app)

A pure module (`frontend/src/composables/parkSearch.ts`) that takes a `creep(forward, until, maxMs, afterMs)` function returning the result, plus the current beam state, and runs the Mac kit's search. Every step is one guarded creep; any `aborted` result ends the search.

Park on nose:
1. **Beam blocked** (the nose or the tail is in it): back off (reverse, until restore, afterMs 450, max 8 s), then forward until break (max 8 s). Parked on nose.
2. **Beam clear, just short?** Forward until break, max 5 s. Parked on nose.
3. **Just past?** Reverse until break then restore, max 12.5 s, afterMs 450; then forward until break, max 8 s. Parked on nose.
4. **Somewhere else:** forward until break, max 80 s (one lap at creep speed with margin, as the Mac kit worked it out). Parked on nose.
5. Otherwise it gives up, stopped, with a message saying what to check.

Park on tail: park on nose first, then forward until restore (max 8 s), then reverse until break (max 8 s). Parked on tail. (This seats the tail on the edge from the beam side, as the Mac kit does, rather than stopping on a moving restore.)

If the loco is already parked on the requested spot, the button does nothing but say so.

### The app (project 3)

```
 Beam: ● Blocked · 0                 Parked on nose
 [ Park on nose ]  [ Park on tail ]  [ Calibrate ]
 (while running)  Backing off the beam...    [ Stop ]
```
- The three buttons show only when a sensor is connected; park buttons are disabled while uncalibrated, calibrating, a search is running, or the train is moving.
- Progress text names the current step ("Backing off the beam", "Creeping forward onto the beam", "Looking round the loop (up to 80 s)"). The result line says where it parked or why it gave up.
- Stop sends the normal emergency stop, which ends the creep and the search.
- No confirm step for parking (the buttons say exactly what they do; Stop is right there). Calibrate keeps its confirm.
- If the page reloads mid-search, the search is gone; the current creep ends on its own and the panel shows whatever status says.

### Mock server

A pretend loco on a 134 in loop with a 3 in loco and the beam at 0: guarded creeps move it at 2.35 in/s, and it produces break/restore at the right moments, so the search can be tried end to end in `npm run dev:all`.

## Risks

- **Truck-height beam.** Gaps under the body read 380–595 against a restore threshold of 573. A gap that holds above 573 for 3 samples would look like a restore mid-loco: backing off would stop with the body still over the beam, and the next forward creep would seat "nose" on a middle truck. Seen once in a pass's max (595) but not as a restore. Raising the beam fixes it; until then the user should know a park can land on the wrong truck.
- **Event latency.** The stop happens after detection (2 samples, 40 ms) plus the sensor → controller hop. At 2.35 in/s that's a few hundredths to a tenth of an inch, fine for a mark.

## Calls I made

- The lap limit is a fixed 80 s in the app, not a setting (matches the Mac kit's 134 in loop at creep speed).
- Creep uses `CAL_SPEED`; there's no separate park speed.
- Refusals go only to the requester; results go to every person.
- The guarded creep doesn't exempt the 30 s safety timeout.
- No confirm step for parking.
- The 30 s safety timeout firing mid-creep ends it as `aborted` ("safety timeout").
- A refusal is `{"type": "creep", "id": 7, "phase": "refused", "detail": "..."}`, to the requester only.
- The app ends a running search when its socket closes, and when the user presses Stop between creeps, so no further creep is started. (A reconnect re-sends `invert`, which aborts any creep still running.)
- A 0.5 s stopped pause between creeps that change direction, as calibration does.
- The direction is left where the last creep put it (reverse after Park on tail, which suits a reverse run).
- `invert`, or the sensor saying hello again, also clears `parked`.
- Park on tail when already parked on nose skips straight to the tail steps.
- An event just before `maxMs` still counts: `afterMs` may run past the limit, but the creep never runs longer than `maxMs` + 1000.

## Left to the builder

- Names and layout of the new `lib/` module (the guarded creep and the parked rules), and how the sketch shares the sensor-quiet check with calibration.
- Exact progress wording, styling, and how the buttons wrap on a phone.
- How the mock loco is modeled, as long as the search can run end to end against it.

## How we'll know it works

- Native tests cover the guarded creep (every end, every refusal, every abort source) and every parked rule; Vitest covers the search (each of the 5 nose paths, the tail path, aborts) and the panel.
- On the hardware, from each starting position (in the beam, just short, just past, across the loop), Park on nose ends with the front truck at the beam's edge and the panel saying Parked on nose; Park on tail ends with the rear truck at the edge; Stop at any point stops the loco at once.
