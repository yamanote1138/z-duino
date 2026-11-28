# Train automation with a beam sensor

Tools that run the train around the oval and park it where it was told to, using a break-beam sensor at the train house: a sensor module, a sound library, shows (sequences in plain JSON that tie sensor events to throttle moves and sounds), and a web page to run them. They talk to the controller over the same WebSocket as the throttle app (port 81) and read the sensor over USB serial; nothing here changes the controller firmware or the app. How the pieces fit with the rest of the repo: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Quick start

Needs Node 22+ and nothing else: there are no packages to install.

**Try it with no train** (everything here runs offline)

```bash
cd tools/train
node --test --test-timeout=30000 test/*.test.mjs    # the whole suite, no hardware
node show.mjs list                                  # the shows you have, and the examples
node show.mjs sim full-lap                          # run a show on a virtual clock: nothing moves or plays
node serve.mjs --no-sensor --open                   # the web page, with no sensor or controller
```

Without your own layout or loco profile, `validate` and `sim` use the examples in `examples/` and say so. Without the audio files they warn instead of failing.

**With a train**

1. Build and flash the controller (see the repo's main README); it should answer at `ztrain.local`.
2. Wire the break-beam sensor (**Hardware** below) and flash its sketch: `pio run -d firmware/beam-sensor -t upload --upload-port <port>` from the repo root.
3. `node calibrate.mjs` measures the open-beam and blocked readings (interactive).
4. Park the loco with its nose in the beam, "the mark": `node nudge.mjs to-mark` from wherever it is (see **Returning to the mark** below), or `node creep-stop.mjs` from a few inches short of the beam.
5. `node learn-loco.mjs --in-beam` teaches the loco's length and speed table (about 8 minutes; it runs the loco around the loop at several speeds).
6. `node orient.mjs` (in your own terminal) checks which way "forward" moves the loco: you say which end led and whether it went right or left, and it flips the controller's invert flag if the back led. It saves `local/orientation.json`, which is what makes `--direction=reverse` mean tail-first and tells the page which way is right and left.
7. Measure your track. Measure the length of one lap along the rails with a piece of string, then `node measure-zones.mjs --loop-in=<inches> --save` and press a key as the nose reaches the start and end of a bend. Repeat with `--marks=` for more zones.
8. Run something: `node show.mjs run park-on-tail`, or `node serve.mjs --open` for the page. Add `--direction=reverse` to run any show the other way round.
9. Settings (controller address, sensor port, sound volume, ...): `cp config.example.jsonc local/config.jsonc` and edit it. See **Settings**.

Everything you create (calibration, loco profile, layout, shows, results, settings) goes in `local/`, which git ignores.

## Why a sensor

Without one, position is dead-reckoning (speed x time), which lands within about ±2" per lap. The beam turns that into a measurement: the script creeps at 10% and stops the instant the train breaks the beam.

## Hardware

| Part | Notes |
|---|---|
| Wemos D1 Mini | reads the sensor, USB to the Mac (`/dev/cu.usbserial-…`). An Uno R4 Minima also works (`/dev/cu.usbmodem…`, `pio run -e uno_r4_minima`) |
| Clear 5 mm 940 nm IR LED + 220 Ω | the emitter (from the Allecin 60-piece IR kit), across 5V and GND, about 17 mA |
| Black 3 mm IR dome + 22 kΩ | the receiver, behaves as a phototransistor; the node goes to **A0** |
| 2 mini breadboards (17 columns) | one for the emitter, one for the receiver, on opposite sides of the track |

**Circuit (D1 Mini).** Emitter: `5V → 220 Ω → clear LED (long leg to the resistor) → GND`. Receiver: `3V3 → black dome (long leg) → short leg → node → 22 kΩ → GND`, with `A0` on the node. The receiver **must** run from 3V3, not 5V: the D1 Mini's A0 tops out around 3.2 V. The D1 Mini sits on the receiver board; two 28 AWG wires carry 5V and GND under the track to the emitter board. Readings come out higher than on the Uno (same light, smaller full scale), so run `node calibrate.mjs` after the swap. The numbers below are from the Uno R4, where the receiver ran from 5V: A clear beam reads **high** (about 340 of 1023 at the current spacing; it once sat at 187 for a while with nothing in the way) and a blocked beam reads low (about 30 to 75 for the solid loco depending on aim, since some light gets round it; about 12 with the emitter off). The 940 nm light is invisible, and room light adds almost nothing (about 11 counts). Two wires carry 5V and GND from the receiver board, under the track, to the emitter board. The 22 kΩ replaced a 10 kΩ to raise the signal after the pair was moved apart.

**Placement.** The emitter and receiver sit just outside the rails, directly across from each other, at the **exit end of the train house**, far enough from the track that the loco does not touch them. Spacing, aim and the resistor all change the clear level, so re-measure after any move (see Beam levels). A mini breadboard's two halves are not connected across the centre channel, so check that A0, the dome's short leg and the resistor share a column.

**Beam height.** The beam crosses the solid body of the single loco. An earlier photoresistor setup was tuned at window height on a Japanese commuter EMU (windows 850 to 975, walls and joins below about 650); the IR pair has not been tested with that train.

## Beam levels

No script hard-codes a reading. The sensor module (`lib/sensor/detector.mjs`) scales every threshold from two numbers in `local/sensor_levels.json`, as fractions of the span between them (`DETECTOR_DEFAULTS` is the one place those fractions live: break below 70% of the span, restore at 80% and above, and so on):

```json
{ "clear": 340, "blocked": 73 }
```

`clear` is the open beam, `blocked` is the solid loco in the beam. Update both after moving or re-aiming the sensor (`node calibrate.mjs` measures both and writes `local/sensor_levels.json`), or override with `BEAM_CLEAR` and `BEAM_BLOCKED` in the environment.

## Sensor firmware

The sensor's firmware now lives in `firmware/beam-sensor/` at the repo root. It reports beam events to the controller over WiFi (calibrate it with the throttle app's Calibrate button), and it still prints `<A0 reading>,<microseconds>` per line at 115200 baud, about 50 per second, which is what these bench tools read over USB. The timestamp is the sensor's own clock, so the scripts that want precise timing (`learn-loco.mjs`) are not at the mercy of USB arrival times. The other scripts read only the first number.

```bash
pio run -d firmware/beam-sensor -t upload --upload-port /dev/cu.usbserial-XXXX   # from the repo root; WiFi comes from secrets.ini
```

The bench tools keep their own calibration (`local/sensor_levels.json`); the sensor's WiFi calibration lives on the sensor.

The sensor module opens the port with `stty` (macOS syntax). If the D1 Mini resets while plugged in, its boot text is skipped and the clock carries on. The board must be plugged straight into the Mac: through a hub with a USB-C to USB-A adapter it only got power and never enumerated.

## Scripts

All scripts need Node 22+ (global `WebSocket`). The controller's address and the sensor's serial port are found automatically (`ztrain.local` resolved to an IP, and the only `/dev/cu.usbmodem*` or `/dev/cu.usbserial-*`); override them in `local/config.jsonc` or with `TRAIN_HOST` and `SENSOR_PORT` (see **Settings** below). Both can change (DHCP, which USB port). Most scripts take `--dry`, which checks the sensor and does not move the train. All of them send `stop` on Ctrl-C.

| Script | What it does |
|---|---|
| `show.mjs` | Check, simulate and run a show (a JSON file): `node show.mjs list \| validate \| sim \| run <show> [--direction=forward\|reverse]`. See **Shows**. `run --reset` puts the loco on the mark first. |
| `serve.mjs` | The web page: run shows, audition sounds, import and export shows. See **The web page**. |
| `calibrate.mjs` | Measure the open-beam and blocked readings and write `local/sensor_levels.json`. Interactive; needs the sensor only. |
| `sensor-watch.mjs` | Print the sensor's events live, or replay a trace (`--replay=<csv>`). |
| `creep-stop.mjs` | Creep forward at 10% and stop when the nose breaks the beam. Start with the nose a few inches short of the beam; it gives up after 8 s (`--max=<seconds>` for longer; a full lap at creep is about 56 s). This puts the train on "the mark". |
| `orient.mjs` | Find out which way "forward" is (nose leading) and which way that is on the table; flips the invert flag if needed and writes `local/orientation.json`. Interactive; beam-guarded creeps only. See **Running a show the other way**. |
| `nudge.mjs` | Move the loco by hand, with the beam as the safety: `fwd <s>` / `back <s>` creep for up to 6 s and stop at any beam event; `to-mark` puts the loco back on the mark from wherever it is (**Returning to the mark**; `--direction=reverse` seats the tail on it instead). |
| `measure-zones.mjs` | Measure your layout's zones (curves, approach) by pressing a key as the nose reaches each mark during one slow lap. See **Shows**. |
| `sound-test.mjs` | List, play and check the sound library, with no train. |
| `config.mjs` | Print the settings in effect and where each came from (`--example` prints the documented template). |
| `light-test.mjs` | Shuttles the loco across the beam (about 1" past it each way, at 10%) and reports clear and blocked levels, noise and pass-time repeatability; appends a row to `light_test_results.csv`. Use `--label=` to name the lighting condition. |
| `import-sounds.py` | Copies real sounds from the sibling `e235-sounds` and `eki-pi` projects into `sounds/`. |
| `learn-loco.mjs` | Learns a new locomotive on its own: finds it, measures its length and speed table, and learns how it stops. Writes `local/loco_profile.json`. The speed table it writes is also the old `speed-trap`'s job (its log gives scale mph). `--resume` and `--stages=find,length,speeds,stops` run parts of it. `--in-beam` starts with the nose already in the beam. |

The jobs of the earlier hand-written scripts are now example shows in `examples/shows/`: `park-on-tail` (was `tail-stop`), `shuttle` (was `tail-nose`), `ramp-loops` (was `ramp-loops.mjs`), `full-lap` (was `signal-show`), with `lap`. They need your layout and loco profile where they use zones; `node show.mjs sim <name>` checks them without moving anything. Timed laps (`laps.mjs`) are gone: a move without a beam to stop it is not something these tools do (`nudge.mjs` is the guarded replacement).

## Settings

Defaults live in the code (`lib/config/index.mjs`). To change any, copy `config.example.jsonc` to `local/config.jsonc`, uncomment what you want and edit it; the example documents every key. Precedence, lowest to highest: **defaults, `local/config.jsonc`, environment variables (`TRAIN_HOST`, `SENSOR_PORT`, `TRAIN_LOCAL`), command-line flags** (`--host=`, `--sensor-port=`, `--port=`, `--volume=`, `--engine=`, `--packs=`, `--invert=`). A mistyped key or a wrong value is an error that names it. `node config.mjs` prints what is in effect and where each value came from. The file is JSON with `//` comments and trailing commas allowed; nothing in it is executed. Every script reads it.

`controller.invert` is sent to the controller when a tool connects. Left unset, nothing is sent: the controller forgets the flag on every reboot, the web app sets it per browser, and the controller has one flag, so whoever connected last wins.

## Sound

Shows and the web page play effects on the Mac through `afplay` (`sound.volume`, 0.5 by default). Sounds come in packs (`packs/*/pack.json`, listed in the `sound.packs` setting): `synth` is generated by `lib/synth.mjs` on first use (an impression of a loco, not a recording), and `jr-east` names real clips that `python3 -I import-sounds.py` copies into `local/sounds/` from two sibling projects, `../e235-sounds` (a BVE sound archive for the JR East E235) and `../eki-pi`, next to this repo. Those sounds belong to their authors and stay on this machine. Without the clips, `validate` and `sim` still work and only warn; a real run needs the files. To use your own sounds, write a pack like `packs/synth/pack.json` in `local/packs/` and add `local:packs/<name>` to `sound.packs`.

The table is the `full-lap` example show's sound design:

| When | Sound |
|---|---|
| Red, before departure | idle blower hum, then a chime |
| Yellow | the E235 departure brake release (yellow lasts until it ends) |
| Green | JR horn and the E235 inverter start-up clip, then a steady inverter hum while running |
| Bends | flange squeals filling each bend (a different clip each time, random order), cut 0.1 s before the bend ends |
| Slowing | the E235 slow-down clip, then a quieter hum while creeping |
| Creeping | a brake squeal as it drops to creep |
| Parked | air release and the brake loosening, then a chime when the light goes blue |

## Your files

Everything specific to your layout, loco and room lives in `local/`, which is git-ignored apart from its README: the
sensor calibration, the loco profile, results and raw traces (see `local/README.md`). `lib/paths.mjs` is the one place
that knows where it is; set `TRAIN_LOCAL` to keep several setups side by side.

## Modules

The scripts above are thin front ends over reusable modules in `lib/`, all tested without hardware (`node --test --test-timeout=30000 test/*.test.mjs`).

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
beam event, creep speed only; it does not move if the beam is already in that state), `wait-zone`, `wait-approach`, `sound`, `fill`, `loop`,
`stop-loop`, `stop-sounds`, `led`, `led-auto` (skipped, and logged as such, when the controller has no status LED: it is optional hardware, reported in the status message as `features.led`; `controller.led` in the settings can force it), `repeat`, `parallel` (branches run together), `log`. Numbers can be `"$name"`
from the show's `settings`. `start: "blocked"` makes the runner check the nose is on the mark first. The field list for each
step is at the top of `lib/show/schema.mjs`; the validator names the path of every mistake.

- **Parallel for waits.** A `ramp` blocks until it finishes, and a beam event during it is gone before the next step starts
  listening. Put the ramp and the `wait-for` in separate `parallel` branches (see the example).
- **The blind-run rule is checked.** Ramping above creep (0.10) with no `wait-for`, `creep` or `wait-zone` before the next
  slow-down is a validation error, and so is ending the show above creep.
- **Running a show the other way: `--direction=reverse`.** A show is written once, the way the layout was measured: the nose leads, the
  loco leaves the mark (the nose just in the beam) and travels one way (on Chad's layout, to the right). `--direction=reverse` on `show.mjs`
  `validate`, `sim` and `run` (and a Forward/Reverse switch on the page) turns it into its mirror image: the tail leads, the loco leaves
  the other way (to the left), and the tail is on the mark. `lib/show/orient.mjs` does it when the show is loaded: `direction` and
  `creep` steps run the other way and a wait for the `nose` edge becomes one for the `tail`; runs of zone `fill` steps are put in the
  order the loco meets the bends; and a show that starts on the mark first seats the tail there (forward until the tail clears the beam,
  then back until it breaks it: a few inches at creep, stopped by the beam, from either mark). In a reverse run a zone is met one loco
  length later, because the tail leads into each bend, and `wait-approach` measures from the end that leads. The show finishes with the
  tail on the mark, so the next reverse run starts there; `node nudge.mjs to-mark --direction=reverse` (or `show.mjs run --reset
  --direction=reverse`) puts the tail on it from anywhere. Write shows in the forward orientation only; a show written for reverse would be turned round twice.
- **Which way is forward: `orient.mjs`.** "Forward" is the loco's front leading. Which way the controller's forward really moves the loco
  depends on the track polarity and the motor leads, so `node orient.mjs` creeps forward a few inches (beam-guarded, either end first),
  asks which end led and whether it went right or left as you face the layout, flips `controller.invert` and checks again if the back
  led, and writes `local/orientation.json`. The tools send that invert whenever they connect (below `config.jsonc`, the environment
  and the flags; `node config.mjs` shows the source), and the page labels Forward and Reverse with the way they move. The controller has
  one invert flag and the throttle app sends its own, so whichever connected last wins: calibrate with the app's invert off.
- **Slowing for a stop: `wait-approach`.** `{ "do": "wait-approach", "from": "$cruise" }` waits until it is time to start slowing for a beam stop,
  then the show ramps to creep and `creep`s until the beam breaks. The point is worked out from the loco's speed table, not set by hand: the ground the
  ramp from `from` down to creep covers (about 10 in from 0.3, about 4 in from 0.2), plus `creepIn` inches at creep speed (default 5), plus `marginIn`
  (default 3) because the position estimate runs 1 to 5 in behind the loco by the end of a lap. It measures from the end that leads, so it works the
  same going forward (nose breaks the beam) and in reverse (tail does). Needs `loopIn` in the layout.
- **Zones** come from a layout file (`z-layout/1`: `loopIn` and named `zones` as inches of nose travel past the beam;
  `examples/layout.example.json`, yours is `local/layout.json`). The position is estimated from the loco's speed model and
  re-anchored on every beam edge, good to about an inch at creep and worse at speed, so use zones for effects (a squeal
  through a curve) and slow-downs with a beam-guarded `creep` after them, never for stopping. `wait-zone` has a time limit
  (60 s by default).
- **Measuring zones.** `node measure-zones.mjs --save` (in your own terminal: it reads your key presses) creeps one lap at
  0.08 while you press a key as the nose reaches the start and end of each bend, then writes the inches into
  `local/layout.json`. It shows the list of marks first and waits for SPACE before the loco moves. Inches come from the lap
  time (the beam events at both ends of the lap and `loopIn`), so the speed model is not involved. `--marks=` picks other
  marks (`zone.from`, `zone.to`; `a.to=b.from` is one press for two bends that run straight into each other), `--lag-ms=`
  takes your reaction time off, `--preview` prints the list without touching the loco. Optional `hints` in the layout
  describe each zone in the prompts.
- **If anything goes wrong** (a step fails, Ctrl-C, the sensor stops reporting) sounds stop and the loco ramps down to a quiet
  stop. A second Ctrl-C is an emergency stop.
- `sim` uses the real runtime, controller and sound-library checks; only the sensor (a ghost that answers after a fixed
  delay), the WebSocket and the audio are faked, so it checks order and commands, not your layout's timing.

## Returning to the mark

Every show that says `start: blocked` begins with the nose on the mark, and refuses to move if the beam says otherwise. `node nudge.mjs to-mark` (also the page's **Return to the mark** button, and `node show.mjs run <show> --reset`) puts the loco there from wherever it is, simplest thing first, every move at creep speed and stopped by a beam event:

1. **Beam blocked** (the nose or the tail is in it): back off until it clears, then creep forward until it breaks. That seats the nose on the edge whichever end was in the beam.
2. **Beam clear, just short of the mark?** Creep forward for a few seconds (`--near=5`, about 12 in): a break means it is there.
3. **Just past it?** Back up over the beam (break, then clear), then creep forward until it breaks.
4. **Neither:** creep forward round the loop until the beam breaks, for one lap's time plus a margin.
5. If even that fails, the loco is stopped and the message says what to check (something else blocking the beam, the loco off the track, the sensor not working).

Ctrl-C or STOP stops it at once, and so does losing the sensor. The logic is in `lib/track/mark.mjs`; `lib/track/physics.mjs` is a model of the track (a loco with a position, the beam where the geometry puts it, injectable faults) that the tests drive it with.

## The web page

`node serve.mjs --open` starts a page on `http://127.0.0.1:4040/` (this Mac only; no dependencies, nothing to build):

- **Shows**: your shows (`local/shows/`) and the examples. Pick one, change its settings, then Validate, Simulate (the
  timeline on a virtual clock; nothing moves or plays) or Run it on the train, with the log live beside it. Export a show as
  JSON, or import one (it is validated first and saved to `local/shows/`). `#local/<name>` in the address opens a show.
- **Sounds**: every sound in the packs, with gain and cut-off controls, to audition before putting one in a show.
- **Return to the mark**: a button that does what `nudge.mjs to-mark` does, stoppable like a show.
- **STOP** ramps the loco down like Ctrl-C; **E-STOP** sends the controller's stop command at once. Both are always on screen.
- One show at a time. A run needs the sensor working and, for `start: blocked`, the nose on the mark; sounds are off limits
  while a show runs. The service holds the sensor's serial port, so stop it before `calibrate.mjs` or `measure-zones.mjs`.
- `--no-sensor` runs the page without hardware (validate, simulate, import/export and sounds still work); `--port=`, `--volume=`.
- It only answers `127.0.0.1`/`localhost` and only JSON posts, so a web page open in your browser cannot start the train.
  The API (`lib/web/server.mjs`) is plain JSON plus an event stream; it is tested against the simulator (`test/web.test.mjs`).

## Lab notes

[NOTES.md](NOTES.md) holds the measurements and observations behind all this: sensor behaviour, the room-light test, how the stops work, the loco's speed table, and the motor-care rules the controller enforces.
