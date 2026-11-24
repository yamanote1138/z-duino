#!/usr/bin/env node
// Room-light test: shuttle the loco back and forth across the beam at creep speed and measure how steady the sensor is.
//
// Usage: node light-test.mjs [--label=<what changed>] [--cycles=5] [--overrun=<ms past the beam, default 450>] [--dry]
// Settings: local/config.jsonc, TRAIN_HOST, SENSOR_PORT (see `node config.mjs`)
//
// Start with the loco's nose in the beam (on the mark). It backs out until the beam is clear and a little further,
// then crosses the beam forward, carries on a little, stops, crosses back, and so on for --cycles round trips (each
// crossing is one pass). It ends by creeping forward onto the mark again. The whole move stays within about 4 inches
// of the beam, at creep speed, and every move is stopped by a beam event (with a time limit as a backstop); it only
// changes direction from a standstill, after a pause.
//
// Per run it reports and appends to local/results/light_test_results.csv:
//   clear level (mean, lowest, highest, noise sd), blocked level, swing, and how repeatable the pass time is
//   (the loco crosses at a constant speed, so the spread of its pass time is the spread of the edge timing).
// Run it once under each lighting condition and compare the rows.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { lightStats } from "./lib/sensor/lighttest.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { localFile } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const dry = args.includes("--dry");
const label = opt("label", "unlabelled");
const CYCLES = Math.max(1, Math.min(10, Number(opt("cycles", 5))));
const CREEP = 0.10;                                  // 2.35 in/s: the speed the stop tools use
const OVERRUN_MS = Number(opt("overrun", 450));      // carry on this long (about 1") after a pass or a clear
const PAUSE_MS = 700;                                // standstill between moves
const SEGMENT_MAX_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };

const config = loadConfigOrExit(args);
const source = new SerialSource(config.sensor);
const sensor = createSensor({ source, emitSamples: true });
const samples = [], passes = [];
sensor.on("sample", (s) => samples.push({ t: s.t, v: s.v }));
sensor.on("pass", (p) => passes.push(p));
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();
await sleep(1500);

const recent = sensor.recent(20).map((s) => s.v);
if (recent.length < 20) fail(`no sensor data: ${source.lastError ? source.lastError.message : "the port is silent"}`);
const spread = Math.max(...recent) - Math.min(...recent);
console.log(`parked reading ${sensor.lastReading} (spread ${spread}); label "${label}", ${CYCLES} round trips`);
if (spread > 80) fail("sensor reading is not steady; not moving");
if (sensor.state !== "blocked") fail(`the nose is not in the beam (the beam is ${sensor.state}): park the loco on the mark first (node nudge.mjs to-mark, or node creep-stop.mjs)`);
if (dry) { console.log("dry run: sensor fine, train not moved"); sensor.stop(); process.exit(0); }

const ctl = await connectController({ config });
process.on("SIGINT", () => { ctl.emergencyStop(); process.exit(130); });
const lost = new Promise((res) => sensor.on("lost", res));
let code = 0;

// One guarded move at creep speed: stop on the beam event, after the overrun, then stand still for the pause.
async function leg(forward, event, what) {
  sensor.setDirection(forward ? "forward" : "reverse");
  const r = await ctl.guardedMove({ forward, speed: CREEP, maxMs: SEGMENT_MAX_MS, afterMs: OVERRUN_MS, abort: lost, until: () => sensor.waitFor(event, { timeoutMs: SEGMENT_MAX_MS + 500 }) });
  if (r.result !== "guard") throw new Error(`${what}: the beam did not change (${r.result}); stopped`);
  await sleep(PAUSE_MS);
}

try {
  console.log("backing out of the beam");
  await leg(false, "restore", "backing out");
  const startT = samples.at(-1).t;
  passes.length = 0;   // backing out is not a pass of interest: only count crossings from here
  for (let c = 1; c <= CYCLES; c++) {
    for (const fwd of [true, false]) {
      const before = passes.length;
      await leg(fwd, "pass", fwd ? "forward pass" : "reverse pass");
      if (passes.length === before) throw new Error("no pass was recorded");
      const p = passes.at(-1);
      console.log(`  trip ${c} ${fwd ? "forward" : "reverse"}: in the beam ${(p.durationMs / 1000).toFixed(3)} s`);
    }
  }
  console.log("returning to the mark");
  sensor.setDirection("forward");
  const r = await ctl.guardedMove({ forward: true, speed: CREEP, maxMs: SEGMENT_MAX_MS, abort: lost, until: () => sensor.waitFor("break", { timeoutMs: SEGMENT_MAX_MS + 500 }) });
  if (r.result !== "guard") console.log("warning: the beam did not trip on the way back to the mark; the loco is not on the mark");
  await sleep(800);

  const stats = lightStats({ samples, passes: passes.slice(0, CYCLES * 2), startT, clearMin: sensor.thresholds.restore });
  const row = { label, when: new Date().toISOString(), ...stats };
  console.log(`\nsummary (${label})`);
  console.log(`  clear    mean ${row.clearMean}, lowest ${row.clearMin}, highest ${row.clearMax}, noise sd ${row.clearSd}  (${row.clearN} readings)`);
  console.log(`  blocked  mean ${row.blockedMean}  ->  swing ${row.swing}`);
  console.log(`  pass time  mean ${row.passMeanS} s, sd ${row.passSdMs} ms over ${row.passes} passes (forward ${row.fwdMeanS} s, reverse ${row.revMeanS} s)`);
  const file = localFile("results", "light_test_results.csv");
  if (!existsSync(file)) writeFileSync(file, Object.keys(row).join(",") + "\n");
  appendFileSync(file, Object.values(row).map((v) => String(v).replace(/,/g, ";")).join(",") + "\n");
  console.log("  appended to local/results/light_test_results.csv");
} catch (e) { console.error(`error: ${e.message}`); code = 1; }
try { ctl.setSpeed(0); } catch { /* already stopped */ }
await ctl.close(); sensor.stop();
process.exit(code);
