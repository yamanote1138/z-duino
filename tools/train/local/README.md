# local/

Your own files. Everything in this folder except this README is git-ignored, so it is never committed and a
`git pull` never overwrites it. The scripts create what they need here.

| Path | What | Made by |
|---|---|---|
| `config.jsonc` | your settings (controller address, sensor port, sound volume and packs, ...); start from `../config.example.jsonc` | you |
| `sensor_levels.json` | the open-beam and blocked readings for your emitter and receiver | `node calibrate.mjs` |
| `loco_profile.json` | speeds, length and stopping behaviour of your locomotive | `node learn-loco.mjs` |
| `layout.json` | your track: the lap length and named zones (curves, approaches) as inches past the beam | `node measure-zones.mjs`, or by hand |
| `shows/` | shows (`z-show/1` JSON) you write or import | you, or the web page's Import |
| `results/` | `light_test_results.csv` | `light-test.mjs` |
| `traces/` | raw sensor traces (`*.csv`) and run logs, for replaying through the sensor module | the test scripts |
| `sounds/` | the real sound clips the `jr-east` pack uses | `python3 -I import-sounds.py` |
| `packs/` | your own sound packs; list one in `sound.packs` as `local:packs/<name>` | you |

Move to a new machine or share a setup by copying this folder. To keep several setups, point `TRAIN_LOCAL` at another
folder: `TRAIN_LOCAL=~/train-kitchen node calibrate.mjs`.

Without `sensor_levels.json` the sensor module (`calibrate.mjs`, `sensor-watch.mjs`, `creep-stop.mjs`, `show.mjs`) refuses
to start and tells you to calibrate. `BEAM_CLEAR` and `BEAM_BLOCKED` in the environment override the file.

`node config.mjs` shows which settings are in effect and where each came from.
