# Train automation with a beam sensor

Scripts that run the train around the oval and park it where it was told to, using a break-beam sensor at the train house. They talk to the controller over the same WebSocket as the web UI (port 81) and read the sensor over USB serial. Nothing here changes the controller firmware or the frontend.

## Why a sensor

Without one, position is dead-reckoning (speed x time), which lands within about ±2" per lap. The beam turns that into a measurement: the script creeps at 10% and stops the instant the train breaks the beam.

## Hardware

| Part | Notes |
|---|---|
| Arduino Uno R4 Minima | reads the sensor, USB to the Mac (`/dev/cu.usbmodem…`) |
| Green 5 mm LED + 220 Ω | the light source, across 5V and GND |
| Photoresistor + 10 kΩ | divider from 5V; the midpoint goes to **A0** |
| 2 mini breadboards (17 columns) | one for the LED, one for the photoresistor, on opposite sides of the track |

**Circuit.** `5V → photoresistor → node → 10 kΩ → GND`, with `A0` on the node. Separately, `5V → 220 Ω → LED → GND`. A clear beam reads **high** (about 983 to 988 of 1023) and a blocked beam reads low. Two wires carry 5V and GND from the sensor board to the LED board.

**Placement.** The LED and photoresistor sit just outside the rails, directly across from each other, at the **exit end of the train house**. Keep them as close to the track as practical and at the same height. A mini breadboard's two halves are not connected across the centre channel, so check that A0 and the photoresistor share a half and a column.

**Beam height.** The scripts were tuned with the beam at window height on a Japanese commuter EMU: windows read about 850 to 975, the solid end walls and the joins drop below about 650, and a fully blocked beam reads about 170 to 560 depending on which part of the nose is in it.

## Sensor firmware

`sensor/` is a small PlatformIO project that prints one `analogRead(A0)` per line at 115200 baud, about 50 per second.

```bash
cd tools/train/sensor
pio run -t upload        # add upload_port to platformio.ini if it picks the wrong port
```

The scripts open the port with `stty` (macOS syntax) and default to `/dev/cu.usbmodem1101`. Override with `SENSOR_PORT`.

## Scripts

All scripts need Node 22+ (global `WebSocket`). Set `TRAIN_HOST` to the controller's IP; mDNS (`ztrain.local`) was unreliable for WebSocket connections. Most scripts take `--dry`, which checks the sensor and does not move the train. All of them send `stop` on Ctrl-C.

| Script | What it does |
|---|---|
| `laps.mjs` | Timed laps with no sensor: `node laps.mjs <1-5> [30\|35\|40]`. Also `node laps.mjs nudge <fwd\|back> <seconds>` for hand positioning at 10%. |
| `creep-stop.mjs` | Creep forward at 10% and stop when the nose breaks the beam. Start with the nose a couple of inches short of the beam. |
| `tail-nose.mjs` | From the mark: creep forward and stop on the tail, wait 4 s, creep back and stop on the nose. |
| `loops-tail.mjs` | Leave, do one loop, and on the second loop stop with the tail on the beam. |
| `signal-show.mjs` | Three loops with the controller LED as a signal. Red, yellow, green go, purple at each pass (or `--party` for the beat show), yellow while slowing, red when parked, then blue. Ends parked on the nose. |
| `speed-trap.mjs` | Times the train past the beam at several throttle settings and reports speed in scale mph, plus the loop length. |
| `read-a0.py` | Bench helper: `python3 -I read-a0.py 3` prints min, max and mean of A0 over 3 s. Port is hard-coded at the top. |

The scripts are deliberately standalone, so the sensor and connection helpers repeat across files.

## How the stops work

- **Clear beam** is a flat plateau near the top of the range for 0.6 s. The level drifts a few counts, so it is measured, not fixed.
- **Nose** is the first reading well below the clear level after a clear beam. **Joins and the middle car** are skipped by requiring a long clean run of windows (1.0 s) before a wall, and by ignoring the first 3.2 s after the nose.
- **A wall** needs two or more consecutive readings below 760. A single stray low sample is ignored.
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

`laps.mjs` carries calibration constants fitted when the loop was assumed to be 158.5". The fit absorbed the error, so its timed laps still land close, but its in/s figures are not true speeds.

## Controller behaviour these scripts rely on

- The firmware stops the motor after 30 s with no message, so every script pings every 5 s.
- `stop` blinks the status LED magenta four times. The signal show uses `speed 0` for its final stop to avoid hiding the red.
- The `direction` command resets the LED to its status colour, so set LED colours after it.
- With no client connected the status LED is blue. Disconnecting returns it there.
