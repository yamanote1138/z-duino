# Lab notes

Measurements and observations behind the tools in this folder: how the beam sensor behaves, how fast one loco runs, how the motor and controller respond. They come from one setup (one loco, one oval), so expect your own numbers to differ; `node learn-loco.mjs` and `node light-test.mjs` measure yours. How to use the tools is in [README.md](README.md).

## Room light

`light-test.mjs` measured the sensor under a desk lamp (an IKEA LED lamp, which gives off almost no 940 nm light): far away, near the track, and aimed straight at the receiver. Nothing moved: clear 340, blocked 29 to 30, noise sd under 2 counts, and a pass time that repeats to about 10 ms (about 0.03" of loco travel at creep). Incandescent bulbs and sunlight were not tested. The beam is steady (not modulated), so strong IR from those would add directly to the clear reading. The kit's 38 kHz receivers would ignore it, but need the emitter pulsed at 38 kHz.

## How the stops work

- **Clear beam** is a flat plateau (within 6 counts) above half the blocked-to-clear span for 0.6 s. The level drifts a few counts, so it is measured, not fixed.
- **Nose** needs two consecutive low readings, so one stray sample is not counted as a train.
- **Nose** is the first reading well below the clear level after a clear beam. **Joins and the middle car** are skipped by requiring a long clean run of windows (1.0 s) before a wall, and by ignoring the first 3.2 s after the nose.
- **Final-approach check.** Before the ramp-down, every one of the last 30 readings must be at least 20 above the stop level. It does not ask for a flat line: the clear reading wobbles a few percent while the train runs (338 to 352 seen), and the earlier flat-line version aborted a show.
- **A wall** needs two or more consecutive readings below the wall level (72% of the span, 256 at the current levels). A single stray low sample is ignored.
- **Final approach.** A show starts slowing at a point the `wait-approach` step works out from the speed table (the ground the ramp covers, about 10 in from 0.3 to creep and about 4 in from 0.2, plus 5 in of running at creep, plus a 3 in margin), then ramps down to creep and creeps until the beam breaks. The beam, never a timer, does the stopping. The margin is there because the position estimate ran 1 in behind the loco forward and 3 to 5 in behind in reverse by the end of a lap (measured from how long the creep took after the slow-down point). The estimate is brought up to date whenever a command goes out; before that, a pause after a guarded stop kept integrating the creep speed.

## Measured numbers

| | |
|---|---|
| Loop length | about 134" (3.41 m), from the lap period and the pass time |
| Train length | 272 mm (3 cars x 88 mm, 2 gaps x 4 mm) |
| Scale | Z, 1:220 |

| Throttle | Speed | Scale speed |
|---|---|---|
| 40% | 8.64 in/s | 108 mph (174 km/h) |
| 30% | 6.53 in/s | 82 mph (131 km/h) |
| 20% | 4.50 in/s | 56 mph (91 km/h) |
| 15% | 2.94 in/s | 37 mph (59 km/h) |
| 10% | about 1.96 in/s | about 24 mph (39 km/h) |

Throttle is not linear at the low end: 15% to 20% gains more speed per step than 20% to 40%.

### Locomotive profile (single solid loco, from `learn-loco.mjs`, IR sensor, 2026-11-20)

Solid body with no windows, 3.00" (76 mm) long as measured with the IR beam (the photoresistor setup measured 2.89"). The beam reads about 26 to 28 while it is in front of the sensor, and the edges are sharp (about 0.39 s nose to tail at 8 in/s).

| Throttle | Speed | At 1:220 |
|---|---|---|
| 8% | 1.80 in/s | 23 mph |
| 10% | 2.35 in/s | 29 mph |
| 12% | 2.92 in/s | 36 mph |
| 15% | 3.75 in/s | 47 mph |
| 20% | 5.38 in/s | 67 mph |
| 25% | 6.58 in/s | 82 mph |
| 30% | 8.13 in/s | 102 mph |

Fit over the whole range: `v = -0.49 + 28.65 x throttle` (in/s). It never stalled down to 8% and carried on 0" after a stop at 8%, 9% and 10% throttle (9 trials, 0 to 20 ms response). The tools cap the target speed at 9 in/s as a derailment guard.

## Controller behaviour the tools rely on

- The firmware stops the motor after 30 s with no message, so every script pings every 5 s.
- The status LED is optional (firmware `HAS_STATUS_LED`, default on). The controller reports it as `features.led`; `lib/controller` skips `led` and `led_auto` when it is false. The notes below apply when one is fitted.
- `stop` blinks the status LED magenta four times. Shows use `speed 0` for stopping to avoid hiding the colour they set.
- The `direction` command resets the LED to its status colour, so set LED colours after it.
- With no client connected the status LED is blue. Disconnecting returns it there.

## Motor care

Stopping or reversing a locomotive at any significant speed is hard on the motor.

- Cut the throttle to zero only at creep speed, about 2.5 in/s or less. From anything faster, ramp down the way the web UI does (1 s per 0.1 of throttle).
- Never change direction while moving. Stop, pause, then reverse.
- `stop` (the controller's emergency stop) is for aborts and Ctrl-C only.
