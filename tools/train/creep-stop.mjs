#!/usr/bin/env node
// Creep forward at 10% and stop the train when the beam sensor trips.
//
// Usage: node creep-stop.mjs [--dry] [--max=<seconds>]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (the sensor Arduino's serial port)
//
// The beam must be clear before it moves. Levels come from local/sensor_levels.json (node calibrate.mjs), through the sensor
// module (lib/sensor): it supplies the break event, and a `lost` event if the readings stop while the train is moving.

import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { PORT } from "./lib/config.mjs";

const CREEP = 0.1;          // creep speed
const AFTER_MS = 1500;      // keep watching after the stop
const maxArg = process.argv.find((x) => x.startsWith("--max="));
const MAX_CREEP_MS = maxArg ? Number(maxArg.split("=")[1]) * 1000 : 8000;  // give up and stop after this long (a full lap at creep is about 56 s)
const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sensor = createSensor({ source: new SerialSource({ port: PORT }), emitSamples: true });
sensor.on("error", (e) => { console.error("sensor error:", e.message); process.exit(1); });

async function main() {
  // 1. Check the beam is clear before moving anything.
  await sensor.start();
  await sleep(1500);
  const recent = sensor.recent(20);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const th = sensor.thresholds;
  console.log(`beam check: ${recent.length} samples, lowest ${Math.min(...recent.map((s) => s.v))}, state ${sensor.state} (breaks below ${th.break.toFixed(0)})`);
  if (sensor.state !== "clear") throw new Error(`beam is not clear (state ${sensor.state}, reading ${sensor.lastReading}); not moving`);
  if (dry) { console.log("dry run: sensor fine, train not moved"); return; }

  const ctl = await connectController();
  process.on("SIGINT", () => { ctl.emergencyStop(); process.exit(130); });
  process.on("SIGTERM", () => { ctl.emergencyStop(); process.exit(130); });

  let result, elapsed = 0, brk = null;
  try {
    // The guard is the beam: the loco only moves while we are waiting for it, and a lost sensor stops it.
    const move = await ctl.guardedMove({
      forward: true, speed: CREEP, maxMs: MAX_CREEP_MS,
      until: () => sensor.waitFor("break", { timeoutMs: MAX_CREEP_MS + 1000 }).then((e) => { brk = e; }),
      abort: sensor.waitFor("lost", { timeoutMs: MAX_CREEP_MS + 1000 }).catch(() => new Promise(() => {})),
    });
    elapsed = move.elapsedMs;
    result = { guard: "tripped", timeout: "no trigger in time", abort: "sensor went quiet", disconnect: "controller connection lost" }[move.result];
    await sleep(AFTER_MS);
  } catch (e) {
    ctl.emergencyStop(); throw e;
  } finally {
    await ctl.close();
  }

  if (result === "tripped") {
    console.log(`TRIPPED ${elapsed} ms after the speed command; reading ${brk.level}`);
    const around = sensor.recent(200).filter((s) => s.h >= brk.h - 100 && s.h <= brk.h + 400).map((s) => s.v);
    console.log("readings around the trip:", around.join(" "));
    console.log("final reading:", sensor.lastReading);
  } else {
    console.log(`STOPPED WITHOUT TRIP: ${result}`);
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => { sensor.stop(); process.exit(); });
