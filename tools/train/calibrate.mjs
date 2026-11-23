#!/usr/bin/env node
// Calibrate the sensor: measure the open-beam and blocked levels and save them (local/sensor_levels.json).
// Usage: node calibrate.mjs [--ms=3000] [--no-save]
// It never moves the train: you set up each state by hand and press Enter. For a hands-free version, let the controller
// do the moving and call sensor.calibrate({ clearStep, blockedStep }) yourself.
import { createInterface } from "node:readline/promises";
import { createSensor, SerialSource, DEFAULT_FILE } from "./lib/sensor/index.mjs";
import { PORT } from "./lib/config.mjs";

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : d; };
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

const sensor = createSensor({ source: new SerialSource({ port: PORT }), levels: { clear: 1000, blocked: 0 } });   // levels are replaced by this run
await sensor.start();
await new Promise((r) => setTimeout(r, 800));
if (sensor.lastReading == null) { console.error(`no readings from ${PORT}`); process.exit(1); }
console.log(`reading now: ${sensor.lastReading}`);

try {
  const r = await sensor.calibrate({
    ms: Number(arg("ms", 3000)), save: !process.argv.includes("--no-save"),
    clearStep: async () => { await ask("\n1. Make sure NOTHING is in the beam (loco well clear). Press Enter to measure the open beam... "); },
    blockedStep: async () => { await ask("\n2. Put the loco in the beam (the part you want to detect). Press Enter to measure... "); },
  });
  const f = (m) => `median ${m.median}, range ${m.min} to ${m.max}, sd ${m.sd.toFixed(1)}, ${m.n} readings`;
  console.log(`\nclear:   ${f(r.clear)}\nblocked: ${f(r.blocked)}`);
  const th = sensor.thresholds;
  console.log(`\nlevels: clear ${r.levels.clear}, blocked ${r.levels.blocked} (span ${th.span}); the beam breaks below ${th.break.toFixed(0)} and restores at ${th.restore.toFixed(0)}`);
  for (const w of r.warnings) console.log(`warning: ${w}`);
  console.log(process.argv.includes("--no-save") ? "not saved (--no-save)" : `saved to ${DEFAULT_FILE}`);
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
rl.close(); sensor.stop(); process.exit();
