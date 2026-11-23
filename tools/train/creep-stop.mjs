#!/usr/bin/env node
// Creep forward at 10% and stop the train when the beam sensor trips.
//
// Usage: node creep-stop.mjs [--dry] [--max=<seconds>]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (the sensor Arduino's serial port)
//
// The beam must be clear before it moves. Levels come from local/sensor_levels.json (node calibrate.mjs), through the sensor
// module (lib/sensor): it supplies the break event, and a `lost` event if the readings stop while the train is moving.

import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { HOST, PORT } from "./lib/config.mjs";

const CREEP = 0.1;          // creep speed
const AFTER_MS = 1500;      // keep watching after the stop
const maxArg = process.argv.find((x) => x.startsWith("--max="));
const MAX_CREEP_MS = maxArg ? Number(maxArg.split("=")[1]) * 1000 : 8000;  // give up and stop after this long (a full lap at creep is about 56 s)
const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sensor = createSensor({ source: new SerialSource({ port: PORT }), emitSamples: true });
sensor.on("error", (e) => { console.error("sensor error:", e.message); process.exit(1); });

async function connect() {
  const ws = new WebSocket(`ws://${HOST}:81`);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`connect failed (${HOST})`)), { once: true });
    setTimeout(() => rej(new Error(`connect timeout (${HOST})`)), 5000);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const keepalive = setInterval(() => send({ cmd: "ping" }), 5000);
  const close = async () => { clearInterval(keepalive); await sleep(300); ws.close(); };
  return { send, close };
}

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

  const { send, close } = await connect();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  let result = "timeout", tStart = 0, brk = null;
  try {
    send({ cmd: "direction", value: true });
    await sleep(200);
    send({ cmd: "speed", value: CREEP });
    tStart = Date.now();
    const tripped = sensor.waitFor("break", { timeoutMs: MAX_CREEP_MS }).then((e) => { brk = e; return "tripped"; }, () => "no trigger in time");
    const lost = sensor.waitFor("lost", { timeoutMs: MAX_CREEP_MS + 1000 }).then(() => "sensor went quiet", () => new Promise(() => {}));
    result = await Promise.race([tripped, lost]);
    stop();
    await sleep(AFTER_MS);
  } finally {
    stop();
    send({ cmd: "direction", value: true });
    await close();
  }

  if (result === "tripped") {
    console.log(`TRIPPED ${brk.h - tStart} ms after the speed command; reading ${brk.level}`);
    const around = sensor.recent(200).filter((s) => s.h >= brk.h - 100 && s.h <= brk.h + 400).map((s) => s.v);
    console.log("readings around the trip:", around.join(" "));
    console.log("final reading:", sensor.lastReading);
  } else {
    console.log(`STOPPED WITHOUT TRIP: ${result}`);
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => { sensor.stop(); process.exit(); });
