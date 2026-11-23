# Train automation with a beam sensor

Scripts that run the train around the oval and park it where it was told to, using a break-beam sensor at the train house. They talk to the controller over the same WebSocket as the web UI (port 81) and read the sensor over USB serial. Nothing here changes the controller firmware or the frontend.

## Why a sensor

Without one, position is dead-reckoning (speed x time), which lands within about ±2" per lap. The beam turns that into a measurement: the script creeps at 10% and stops the instant the train breaks the beam.

## Hardware

| Part | Notes |
|---|---|
| Arduino Uno R4 Minima | reads the sensor, USB to the Mac (`/dev/cu.usbmodem…`) |
| Clear 5 mm 940 nm IR LED + 220 Ω | the emitter (from the Allecin 60-piece IR kit), across 5V and GND, about 16 mA |
| Black 3 mm IR dome + 22 kΩ | the receiver, behaves as a phototransistor; the node goes to **A0** |
| 2 mini breadboards (17 columns) | one for the emitter, one for the receiver, on opposite sides of the track |

**Circuit.** Emitter: `5V → 220 Ω → clear LED (long leg to the resistor) → GND`. Receiver: `5V → black dome (long leg) → short leg → node → 22 kΩ → GND`, with `A0` on the node. A clear beam reads **high** (about 340 of 1023 at the current spacing; it once sat at 187 for a while with nothing in the way) and a blocked beam reads low (about 30 to 75 for the solid loco depending on aim, since some light gets round it; about 12 with the emitter off). The 940 nm light is invisible, and room light adds almost nothing (about 11 counts). Two wires carry 5V and GND from the receiver board, under the track, to the emitter board. The 22 kΩ replaced a 10 kΩ to raise the signal after the pair was moved apart.

**Placement.** The emitter and receiver sit just outside the rails, directly across from each other, at the **exit end of the train house**, far enough from the track that the loco does not touch them. Spacing, aim and the resistor all change the clear level, so re-measure after any move (see Beam levels). A mini breadboard's two halves are not connected across the centre channel, so check that A0, the dome's short leg and the resistor share a column.

**Beam height.** The beam crosses the solid body of the single loco. An earlier photoresistor setup was tuned at window height on a Japanese commuter EMU (windows 850 to 975, walls and joins below about 650); the IR pair has not been tested with that train.

## Beam levels

No script hard-codes a reading. `lib/levels.mjs` scales every threshold (clear plateau, nose drop, trip, wall, solid-pass limit) from two numbers in `sensor_levels.json`:

```json
{ "clear": 340, "blocked": 73 }
```

`clear` is the open beam, `blocked` is the solid loco in the beam. Update both after moving or re-aiming the sensor (read them with `python3 -I read-a0.py 3`), or override with `BEAM_CLEAR` and `BEAM_BLOCKED` in the environment. The fractions are the old photoresistor thresholds re-expressed on the same scale, so behaviour matches what the scripts were tuned for.

## Sensor firmware

`sensor/` is a small PlatformIO project that prints `<A0 reading>,<microseconds>` per line at 115200 baud, about 50 per second. The timestamp is the sensor's own clock, so the scripts that want precise timing (`learn-loco.mjs`) are not at the mercy of USB arrival times. The other scripts read only the first number.

```bash
cd tools/train/sensor
pio run -t upload        # add upload_port to platformio.ini if it picks the wrong port
```

The scripts open the port with `stty` (macOS syntax). The Arduino must be plugged straight into the Mac: through a hub with a USB-C to USB-A adapter it only got power and never enumerated.

## Scripts

All scripts need Node 22+ (global `WebSocket`). The controller's address and the sensor's serial port are found automatically (`lib/config.mjs`: `ztrain.local` resolved to an IP, and the only `/dev/cu.usbmodem*`); set `TRAIN_HOST` or `SENSOR_PORT` to override. Both change (DHCP, which USB port). Most scripts take `--dry`, which checks the sensor and does not move the train. All of them send `stop` on Ctrl-C.

| Script | What it does |
|---|---|
| `laps.mjs` | Timed laps with no sensor: `node laps.mjs <1-5> [30\|35\|40]`. Also `node laps.mjs nudge <fwd\|back> <seconds>` for hand positioning at 10%. |
| `creep-stop.mjs` | Creep forward at 10% and stop when the nose breaks the beam. Start with the nose a few inches short of the beam; it gives up after 8 s (`--max=<seconds>` for longer; a full lap at creep is about 56 s). This puts the train on "the mark". |
| `tail-stop.mjs` | Single solid loco: from the mark (nose in the beam), creep forward at 10% and stop when the tail clears the beam. |
| `tail-nose.mjs` | From the mark: creep forward and stop on the tail, wait 4 s, creep back and stop on the nose. |
| `loops-tail.mjs` | Leave, do one loop, and on the second loop stop with the tail on the beam. |
| `signal-show.mjs` | Two loops with the controller LED as a signal. Red, yellow, green go, purple at the pass (or `--party` for the beat show), yellow while slowing, red when parked, then blue. Ends parked on the nose. Start with the nose in the beam (on the mark); it refuses to run otherwise. Use `--loco` for the speeds in `loco_profile.json`, and `--sound` for sound effects (see Sound). The ramp-down is timed from the loop-1 lap, standing start included. |
| `ramp-loops.mjs` | Three loops, a little faster each (`--start=0.40 --final=0.65`), then ramp to 30%, then creep onto the nose. Calibrated on loop 2, because speeds above 30% are extrapolated from the profile; needs `--allow-fast` above 9 in/s. `--plan` prints the final-loop plan. |
| `light-test.mjs` | Shuttles the loco across the beam (about 1" past it each way, at 10%) and reports clear and blocked levels, noise and pass-time repeatability; appends a row to `light_test_results.csv`. Use `--label=` to name the lighting condition. |
| `sound-demo.mjs` | Plays the sound set in the order a show uses it, with no train. |
| `import-sounds.py` | Copies real sounds from the sibling `e235-sounds` and `eki-pi` projects into `sounds/`. |
| `speed-trap.mjs` | Times the train past the beam at several throttle settings and reports speed in scale mph, plus the loop length. |
| `learn-loco.mjs` | Learns a new locomotive on its own: finds it, measures its length and speed table, and learns how it stops. Writes `local/loco_profile.json`. Uses `lib/beam.mjs`. `--resume` and `--stages=find,length,speeds,stops` run parts of it. `--in-beam` starts with the nose already in the beam. |
| `read-a0.py` | Bench helper: `python3 -I read-a0.py 3` prints min, max and mean of A0 over 3 s. |

The scripts are deliberately standalone, so the sensor and connection helpers repeat across files.

## Sound

`signal-show.mjs --sound` plays effects on the Mac through `afplay` (`--volume=0.5` by default). Sound files live in `sounds/` and are git-ignored. Some are generated (`lib/synth.mjs`, an impression, not a recording of an EF210); the rest are real clips copied from two sibling projects by `python3 -I import-sounds.py`, which needs `../e235-sounds` (a BVE sound archive for the JR East E235) and `../eki-pi` next to this repo. Those sounds belong to their authors and stay on this machine. A file already in `sounds/` is always used, so you can drop your own over any name.

| When | Sound |
|---|---|
| Red, before departure | idle blower hum, then a chime |
| Yellow | the E235 departure brake release (yellow lasts until it ends) |
| Green | JR horn and the E235 inverter start-up clip; the loco creeps out at 10% for 3 s (`--creep-out=<s>`) before climbing to cruise, then a steady inverter hum while running |
| Each pass of the beam | a 2.3 s horn |
| Curves | flange squeals, a different clip each time (four clips, random order, slight volume variation), cut 0.1 s before the curve ends |
| Slowing | the E235 slow-down clip, then a quieter hum while creeping |
| Creeping | a brake squeal as it drops to creep |
| Parked | air release and the brake loosening, then a chime when the light goes blue |

The flange squeals are placed by time from the speed model, not by the beam. The curve distances (a short bend at 5.5 to 12" that diverts the track around a dock, then tight curves at 37 to 57" and 104 to 124" from the sensor) are estimates from a description of the track; override with `--curves=5.5-12,37-57,104-124`.

## Your files

Everything specific to your layout, loco and room lives in `local/`, which is git-ignored apart from its README: the
sensor calibration, the loco profile, results and raw traces (see `local/README.md`). `lib/paths.mjs` is the one place
that knows where it is; set `TRAIN_LOCAL` to keep several setups side by side.

## Modules (work in progress)

The scripts above predate a cleaner split into reusable modules. Two exist so far; both are tested without hardware (`node --test test/*.test.mjs`), and the older scripts do not use them yet.

**Sensor (`lib/sensor/`)** turns beam readings into events and owns calibration.
- `createSensor({ source })`: sources are `SerialSource` (the Arduino) and `ReplaySource` (a recorded or synthetic trace); anything with `start(cb)` / `stop()` works.
- Events: `ready`, `break`, `restore`, `pass` (duration, minimum level), `nose` / `tail` (only once you call `sensor.setDirection("forward" | "reverse")`; the sensor cannot see direction by itself), `drift` (the open-beam level no longer matches calibration, or the beam sits steadily half-blocked), `lost` / `recovered` (no readings).
- `await sensor.waitFor("pass", { timeoutMs })`, `sensor.collect(ms)`, `sensor.recent()`.
- Thresholds are fractions of the span between the calibrated clear and blocked levels (`DETECTOR_DEFAULTS` in `detector.mjs`), so the same config suits any emitter, receiver or distance.
- `node calibrate.mjs` measures the two levels (you place the loco; it never moves the train) and writes `local/sensor_levels.json`. `node sensor-watch.mjs` prints events live; `--replay=<csv>` needs no hardware.

**Sound (`lib/sound/`)** is a library of packs, picked by id or category.
- A pack is a folder with a `pack.json` (format in `lib/sound/pack.mjs`); the repo holds manifests only. `packs/synth` is generated (`node sound-test.mjs list` makes its files); `packs/jr-east` points at the clips `import-sounds.py` copies into `sounds/`.
- `lib.play("horn.depart")`, `lib.play("flange")` (a category picks a member; an exact id wins over a category), `lib.fill("flange", { ms: 2400, cutMs: 100 })`, `lib.loop("run", "motion.run")`. Variants carry weights, no-repeat, and gain/rate jitter. `lib.check([...])` fails early if a sound or file is missing.
- The playback engine is swappable: `afplay` is one implementation of `play(path, { volume, seconds, rate }) -> { done, stop }`. Pass `engine: "null"`, `"afplay"` or your own object, or `registerEngine(name, factory)`.
- `node sound-test.mjs list | play | fill | loop | check` to audition and verify (`--engine=null` is silent).

### Controller (`lib/controller`)

The WebSocket link to the train as a module: connect, keepalive, ramps, and the safety rules in code rather than in each
script. `node creep-stop.mjs` is the smallest example.

- `connectController()` finds the host (`TRAIN_HOST`, else `ztrain.local`), pings every 5 s and emits `status` and `disconnect`.
- `rampTo(v)` / `halt()` ramp at 1 s per 0.1 of throttle. `setSpeed()` to zero, or `setDirection()`, throws a `MotorCareError`
  while the throttle is above creep (0.10): no abrupt stops or reversals at speed. `turnAround()` does it properly.
- `guardedMove({ forward, speed, until, maxMs })` is the only way to move without a ramp: it needs a guard (a beam event),
  a time limit and a creep speed, and refuses otherwise. It stops quietly (speed 0) when the guard fires, times out or the link drops.
- `emergencyStop()` sends `stop` at once and is never refused.

### Shows (`lib/show`, `show.mjs`)

A show is a plain JSON file (`z-show/1`) that ties sensor events to controller moves and sounds. Export and import is just
the file; `examples/shows/lap.json` is a complete one, `local/shows/` is where yours go.

```
node show.mjs list
node show.mjs validate lap        # fields, sound ids, zones, blind runs: moves and plays nothing
node show.mjs sim lap             # runs on a virtual clock with a ghost sensor and prints the timeline
node show.mjs run lap --no-sound  # for real (add --set=cruise=0.2 to override a setting)
```

Steps (`"do"`): `direction`, `ramp`, `halt`, `wait`, `wait-for` (a sensor event), `creep` (a guarded move that stops on a
beam event, creep speed only; it does not move if the beam is already in that state), `wait-zone`, `sound`, `fill`, `loop`,
`stop-loop`, `stop-sounds`, `led`, `led-auto`, `repeat`, `parallel` (branches run together), `log`. Numbers can be `"$name"`
from the show's `settings`. `start: "blocked"` makes the runner check the nose is on the mark first. The field list for each
step is at the top of `lib/show/schema.mjs`; the validator names the path of every mistake.

- **Parallel for waits.** A `ramp` blocks until it finishes, and a beam event during it is gone before the next step starts
  listening. Put the ramp and the `wait-for` in separate `parallel` branches (see the example).
- **The blind-run rule is checked.** Ramping above creep (0.10) with no `wait-for`, `creep` or `wait-zone` before the next
  slow-down is a validation error, and so is ending the show above creep.
- **Zones** come from a layout file (`z-layout/1`: `loopIn` and named `zones` as inches of nose travel past the beam;
  `examples/layout.example.json`, yours is `local/layout.json`). The position is estimated from the loco's speed model and
  re-anchored on every beam edge, good to about an inch at creep and worse at speed, so use zones for effects (a squeal
  through a curve) and slow-downs with a beam-guarded `creep` after them, never for stopping. `wait-zone` has a time limit
  (60 s by default).
- **If anything goes wrong** (a step fails, Ctrl-C, the sensor stops reporting) sounds stop and the loco ramps down to a quiet
  stop. A second Ctrl-C is an emergency stop.
- `sim` uses the real runtime, controller and sound-library checks; only the sensor (a ghost that answers after a fixed
  delay), the WebSocket and the audio are faked, so it checks order and commands, not your layout's timing.

## Show settings

Every number, distance and clip name in `signal-show.mjs` (pauses, creep-out time, curve positions, sound gains, which clip plays at which moment) lives in `lib/show-config.mjs`. Change them without editing the script:

```bash
node lib/show-config.mjs                              # print every setting and its default (no hardware)
node signal-show.mjs --loco --sound --creep-out=5     # short aliases: --volume --creep --cruise --creep-out --curves
node signal-show.mjs --loco --sound --soundSet.gain.hum=0.3 --hold.redStartMs=6000   # dotted keys reach any setting
node signal-show.mjs --loco --sound --config=my_show.json   # a JSON file of overrides, deep-merged over the defaults
```

Unknown settings are rejected, so a typo cannot silently do nothing.

## Room light

`light-test.mjs` measured the sensor under a desk lamp (an IKEA LED lamp, which gives off almost no 940 nm light): far away, near the track, and aimed straight at the receiver. Nothing moved: clear 340, blocked 29 to 30, noise sd under 2 counts, and a pass time that repeats to about 10 ms (about 0.03" of loco travel at creep). Incandescent bulbs and sunlight were not tested. The beam is steady (not modulated), so strong IR from those would add directly to the clear reading. The kit's 38 kHz receivers would ignore it, but need the emitter pulsed at 38 kHz.

## How the stops work

- **Clear beam** is a flat plateau (within 6 counts) above half the blocked-to-clear span for 0.6 s. The level drifts a few counts, so it is measured, not fixed.
- **Nose** needs two consecutive low readings in `signal-show.mjs`, so one stray sample is not counted as a train. With a solid loco the tail counts as cleared after four readings back above the nose level, so the pass LED follows the loco closely.
- **Nose** is the first reading well below the clear level after a clear beam. **Joins and the middle car** are skipped by requiring a long clean run of windows (1.0 s) before a wall, and by ignoring the first 3.2 s after the nose.
- **Final-approach check.** Before the ramp-down, every one of the last 30 readings must be at least 20 above the stop level. It does not ask for a flat line: the clear reading wobbles a few percent while the train runs (338 to 352 seen), and the earlier flat-line version aborted a show.
- **A wall** needs two or more consecutive readings below the wall level (72% of the span, 256 at the current levels). A single stray low sample is ignored.
- **Final approach.** `signal-show.mjs` measures the lap period between the loop-1 and loop-2 passes, then starts the ramp-down so the train creeps for about 6 s before reaching the beam. Lap speed varies by about ±3%, which moves the creep length by about ±2 s.

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

`laps.mjs` carries calibration constants fitted when the loop was assumed to be 158.5". The fit absorbed the error, so its timed laps still land close, but its in/s figures are not true speeds.

## Controller behaviour these scripts rely on

- The firmware stops the motor after 30 s with no message, so every script pings every 5 s.
- `stop` blinks the status LED magenta four times. The signal show uses `speed 0` for its final stop to avoid hiding the red.
- The `direction` command resets the LED to its status colour, so set LED colours after it.
- With no client connected the status LED is blue. Disconnecting returns it there.

## Motor care

Stopping or reversing a locomotive at any significant speed is hard on the motor.

- Cut the throttle to zero only at creep speed, about 2.5 in/s or less. From anything faster, ramp down the way the web UI does (1 s per 0.1 of throttle).
- Never change direction while moving. Stop, pause, then reverse.
- `stop` (the controller's emergency stop) is for aborts and Ctrl-C only.
