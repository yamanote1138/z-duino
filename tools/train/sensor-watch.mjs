#!/usr/bin/env node
// Prints the sensor's events live. Read-only: it never moves the train.
// Usage: node sensor-watch.mjs [--seconds=30] [--samples] [--direction=forward|reverse] [--replay=<csv>]
//   --replay plays a recorded "seconds,reading" CSV instead of the serial port (no hardware needed).
import { createSensor, SerialSource, ReplaySource } from "./lib/sensor/index.mjs";

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : d; };
const secs = Number(arg("seconds", 30));
const replay = arg("replay");
let source;
if (replay) source = ReplaySource.fromCsv(replay);
else { const { loadConfigOrExit } = await import("./lib/config/index.mjs"); source = new SerialSource(loadConfigOrExit().sensor); }

const sensor = createSensor({ source, emitSamples: process.argv.includes("--samples") });
const t0 = Date.now(), ts = () => `+${((Date.now() - t0) / 1000).toFixed(2).padStart(6)} s`;
const show = (ev) => (e) => console.log(`${ts()}  ${ev.padEnd(9)} ${e ? JSON.stringify(e, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)) : ""}`);
for (const ev of ["ready", "break", "restore", "nose", "tail", "pass", "drift", "lost", "recovered", "error"]) sensor.on(ev, show(ev));
if (sensor.emitSamples) sensor.on("sample", (s) => console.log(`${ts()}  sample    ${s.v}`));
const dir = arg("direction"); if (dir) sensor.setDirection(dir);

const th = sensor.thresholds;
console.log(`levels: clear ${th.clear}, blocked ${th.blocked}; breaks below ${th.break.toFixed(0)}, restores at ${th.restore.toFixed(0)}${dir ? `; direction ${dir}` : ""}`);
await sensor.start();
await new Promise((r) => setTimeout(r, replay ? 1000 : secs * 1000));
console.log(`state ${sensor.state}, last reading ${sensor.lastReading}, clear estimate ${sensor.clearLevel}`);
sensor.stop();
process.exit(0);
