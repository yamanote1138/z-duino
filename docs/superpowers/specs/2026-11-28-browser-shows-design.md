# Browser shows: design

## Why

The Mac is out. The user's full-lap show (`tools/train/examples/shows/full-lap.json`) ran on the Mac kit's show engine with `afplay`. It should run from the throttle app, with JR East sounds, so the layout puts on a proper departure and arrival with nothing but the controller, the sensor and a phone.

## What it is

- The app runs the Mac kit's own show engine (`tools/train/lib/show/runtime.mjs`, `position.mjs`, `schema.mjs`, `clock.mjs`) in the browser. Shows stay `z-show/1` JSON; the Mac kit keeps working.
- Glue in the app (`showHost.ts`): a controller adapter (the app's ramps, direction, LED; the show's `creep` step becomes the firmware's guarded creep), a sensor adapter (relayed beam events, `waitFor`), and a Web Audio sound player (play, loop slots with gain, stop).
- Sounds: from `jr-esu-sound-profiles/work/e235-0/esu_ready` (plus the JR horn and the synth chime), converted to AAC `.m4a` with `afconvert` by `frontend/scripts/import-sounds.sh` into `frontend/public/sounds/jr/` (git-ignored, like the other imported JR sounds), with a `pack.json` mapping show ids to files.
- A new show, `jr-lap.json`: parked on nose, red signal, compressor; seseragi melody, door close, yellow, brake release, green, horn; accelerate to cruise, one lap; slow in the approach, creep onto the nose; brake squeal, air, red, door open, blue chime.
- **Measure loco**: from parked on nose, run laps at 0.45 and 0.35 (lap period break to break gives in/s from the 134 in loop; the pass time gives the length), then single passes at 0.25 and 0.15 (in/s from the length). Fits a line through the points. Saved in the browser's localStorage; the JR lap button needs it.

## Non-goals

- Flange squeals and curve zones (later), announcements, a show editor, sound in the firmware, saving the profile on the controller.

## Anti-goals

- The loco ever moving faster than the show asks, or not stopping on Stop.
- A creep that starts a direction change at speed.

## Decided

- Loop length 134 in (the user confirmed).
- The profile lives in the browser (the user chose).
- Seseragi is the one station melody; no announcements; flange later (the user).
- Firmware: a guarded creep may start while the loco is already moving at or below creep speed in the same direction (the show ramps down to creep, then creeps onto the beam). `.m4a` is served as `audio/mp4`.
- The Mac kit's creep cap rises from 0.10 to 0.15 to match the firmware.
- Stop in the app aborts the show; the engine's own clean-up ramps down and resets the LED.
