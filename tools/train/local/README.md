# local/

Your own files. Everything in this folder except this README is git-ignored, so it is never committed and a
`git pull` never overwrites it. The scripts create what they need here.

| Path | What | Made by |
|---|---|---|
| `sensor_levels.json` | the open-beam and blocked readings for your emitter and receiver | `node calibrate.mjs` |
| `loco_profile.json` | speeds, length and stopping behaviour of your locomotive | `node learn-loco.mjs` |
| `results/` | `light_test_results.csv`, `speedtrap_results.json` | `light-test.mjs`, `speed-trap.mjs` |
| `traces/` | raw sensor traces (`*.csv`) and run logs, for replaying through the sensor module | the test scripts |
| `shows/`, `layout.json` | shows and track layout you author | the show runtime (coming) |
| `sounds/`, `packs/` | your own sound files and sound packs | you |

Move to a new machine or share a setup by copying this folder. To keep several setups, point `TRAIN_LOCAL` at another
folder: `TRAIN_LOCAL=~/train-kitchen node calibrate.mjs`.

Without `sensor_levels.json` the sensor module (`calibrate.mjs`, `sensor-watch.mjs`, `creep-stop.mjs`) refuses to
start and tells you to calibrate. The older scripts still on `lib/levels.mjs` fall back to built-in defaults (clear 344,
blocked 30), which are wrong for most setups, so calibrate first. `BEAM_CLEAR` and `BEAM_BLOCKED` in the environment
override the file.
