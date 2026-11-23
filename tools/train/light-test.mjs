#!/usr/bin/env node
// Room-light test: shuttle the loco back and forth across the beam at creep speed and measure how steady the sensor is.
//
// Usage: node light-test.mjs [--label=<what changed>] [--cycles=5] [--overrun=<ms past the beam, default 450>] [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// Start with the loco's nose in the beam (on the mark). It backs out until the beam is clear and a little further,
// then crosses the beam forward, carries on a little, stops, crosses back, and so on for --cycles round trips (each
// crossing is one pass). It ends by creeping forward onto the mark again. The whole move stays within about 4 inches
// of the beam, at 10% throttle, and only changes direction from a standstill after a pause.
//
// Per run it reports and appends to local/results/light_test_results.csv:
//   clear level (mean, lowest, highest, noise sd), blocked level, swing, and how repeatable the pass time is
//   (the loco crosses at a constant speed, so the spread of its pass time is the spread of the edge timing).
// Run it once under each lighting condition and compare the rows.

import { spawnSync } from "node:child_process";
import { createReadStream, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { LEVELS } from "./lib/levels.mjs";

import { HOST, PORT } from "./lib/config.mjs";
import { localFile } from "./lib/paths.mjs";
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : d; };
const dry = args.includes("--dry");
const label = opt("label", "unlabelled");
const CYCLES = Math.max(1, Math.min(10, Number(opt("cycles", 5))));

const CREEP = 0.10;                 // 2.35 in/s: the speed the stop scripts use
const OVERRUN_MS = Number(opt("overrun", 450));   // carry on this long (about 1") after a pass or a clear
const PAUSE_MS = 700;               // standstill between moves, and before any direction change
const SEGMENT_MAX_MS = 6000, STALE_MS = 400;
const TRIP = LEVELS.trip, CLEAR_MIN = LEVELS.clearMin, PLATEAU_MIN = LEVELS.plateauMin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---- sensor (reading,microseconds per line) ----
spawnSync("stty", ["-f", PORT, "115200", "raw", "-echo", "-hupcl"]);
const samples = [];
const crossings = [];   // one per pass: { fallIdx, riseIdx } (indexes into samples)
let partial = "", sawHeader = false, sensorClock = 0, prevUs = null, onSample = () => {};
const rs = createReadStream(PORT);
rs.on("data", (buf) => {
  const now = Date.now();
  partial += buf.toString("latin1");
  const lines = partial.split("\n");
  partial = lines.pop();
  for (const ln of lines) {
    if (!sawHeader) { sawHeader = true; continue; }
    const parts = ln.trim().split(",");
    const v = parseInt(parts[0], 10);
    if (Number.isNaN(v)) continue;
    let t = now;
    if (parts.length > 1) {
      const us = parseInt(parts[1], 10);
      if (!Number.isNaN(us)) { if (prevUs != null) sensorClock += ((us - prevUs) >>> 0) / 1000; prevUs = us; t = sensorClock; }
    }
    const s = { t, h: now, v };
    samples.push(s);
    onSample(s);
  }
});
rs.on("error", (e) => { console.error("sensor error:", e.message); process.exit(1); });

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
  await sleep(1500);
  const recent = samples.slice(-20).map((s) => s.v);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const parked = median(recent), spread = Math.max(...recent) - Math.min(...recent);
  console.log(`parked reading ${parked} (spread ${spread}); label "${label}", ${CYCLES} round trips`);
  if (spread > 80) throw new Error("sensor reading is not steady; not moving");
  if (parked >= PLATEAU_MIN) throw new Error(`the nose is not in the beam (reading ${parked}): park the loco on the mark first (node creep-stop.mjs)`);
  if (dry) { console.log("dry run: sensor fine, train not moved"); return; }

  const { send, close } = await connect();
  let stopped = false, moving = false;
  const hardStop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const bail = () => { hardStop(); process.exit(130); };
  process.on("SIGINT", bail); process.on("SIGTERM", bail);

  // Edge tracking on the trip level: two low readings = in the beam, three high readings after that = out.
  let state = "clear", lowN = 0, highN = 0, fallIdx = -1;
  let onRise = () => {}, cleared = 0;
  onSample = (s) => {
    const i = samples.length - 1;
    if (s.v >= CLEAR_MIN) cleared++; else cleared = 0;
    if (state === "clear") {
      lowN = s.v < TRIP ? lowN + 1 : 0;
      if (lowN >= 2) { state = "blocked"; fallIdx = i - 1; highN = 0; }
    } else {
      highN = s.v >= TRIP ? highN + 1 : 0;
      if (highN >= 3) { state = "clear"; lowN = 0; const c = { fallIdx, riseIdx: i - 2 }; crossings.push(c); onRise(c); }
    }
  };

  const setDir = async (fwd) => { send({ cmd: "direction", value: fwd }); await sleep(300); };
  const setSpeed = (v) => send({ cmd: "speed", value: v });
  const watchdog = setInterval(() => {
    const l = samples[samples.length - 1];
    if (moving && !stopped && (!l || Date.now() - l.h > STALE_MS)) { console.error("sensor went quiet; stopping"); hardStop(); }
  }, 100);

  // Run at creep until `until()` is true plus an overrun, then stop (creep speed, so a straight cut to zero is fine).
  async function run(fwd, until, what) {
    if (stopped) throw new Error("stopped");
    await setDir(fwd);
    moving = true; setSpeed(CREEP);
    const t0 = Date.now();
    while (!until() && !stopped && Date.now() - t0 < SEGMENT_MAX_MS) await sleep(10);
    if (!until()) { setSpeed(0); moving = false; throw new Error(`${what}: the beam did not change in ${SEGMENT_MAX_MS / 1000} s; stopped`); }
    await sleep(OVERRUN_MS);
    setSpeed(0); moving = false;
    await sleep(PAUSE_MS);
  }

  try {
    // 1. back out of the beam and a little further
    console.log("backing out of the beam");
    cleared = 0;
    await run(false, () => cleared >= 3, "backing out");
    state = "clear"; lowN = 0; crossings.length = 0;   // backing out looked like a pass: forget it
    const startIdx = samples.length;

    // 2. round trips: forward across, then back across
    for (let c = 1; c <= CYCLES; c++) {
      for (const fwd of [true, false]) {
        const before = crossings.length;
        await run(fwd, () => crossings.length > before, fwd ? "forward pass" : "reverse pass");
        const x = crossings[crossings.length - 1], f = samples[x.fallIdx], r = samples[x.riseIdx];
        console.log(`  trip ${c} ${fwd ? "forward" : "reverse"}: in the beam ${((r.t - f.t) / 1000).toFixed(3)} s`);
      }
    }

    // 3. back onto the mark: creep forward until the nose breaks the beam
    console.log("returning to the mark");
    let tripped = false; const prev = onSample;
    onSample = (s) => { prev(s); if (state === "blocked") tripped = true; };
    await setDir(true); moving = true; setSpeed(CREEP);
    const tm = Date.now();
    while (!tripped && !stopped && Date.now() - tm < SEGMENT_MAX_MS) await sleep(10);
    setSpeed(0); moving = false;
    if (!tripped) console.log("warning: the beam did not trip on the way back to the mark; the loco is not on the mark");
    await sleep(800);

    report(startIdx);
  } finally {
    clearInterval(watchdog);
    if (moving && !stopped) setSpeed(0);
    await close();
  }
}

function report(startIdx) {
  const S = samples, ts = (i) => S[i].t;
  const xs = crossings.slice(0, CYCLES * 2);
  // clear stretches: from 300 ms after a rise to 300 ms before the next fall (and the opening stretch before the first fall)
  const clearVals = [];
  const bounds = [{ a: startIdx, b: xs[0].fallIdx }];
  for (let k = 0; k + 1 < xs.length; k++) bounds.push({ a: xs[k].riseIdx, b: xs[k + 1].fallIdx });
  bounds.push({ a: xs[xs.length - 1].riseIdx, b: S.length - 1 });
  for (const { a, b } of bounds) for (let i = a; i <= b; i++) if (ts(i) - ts(a) > 300 && ts(b) - ts(i) > 300 && S[i].v >= TRIP) clearVals.push(S[i].v);
  // blocked: the middle of each pass
  const blockedVals = [], durations = [];
  for (const x of xs) {
    durations.push((ts(x.riseIdx) - ts(x.fallIdx)) / 1000);
    for (let i = x.fallIdx; i <= x.riseIdx; i++) if (ts(i) - ts(x.fallIdx) > 250 && ts(x.riseIdx) - ts(i) > 250) blockedVals.push(S[i].v);
  }
  const fwd = durations.filter((_, i) => i % 2 === 0), rev = durations.filter((_, i) => i % 2 === 1);
  const clearMean = mean(clearVals), blockedMean = blockedVals.length ? mean(blockedVals) : NaN;
  const row = {
    label, when: new Date().toISOString(), passes: xs.length, clearN: clearVals.length,
    clearMean: +clearMean.toFixed(1), clearMin: Math.min(...clearVals), clearMax: Math.max(...clearVals), clearSd: +sd(clearVals).toFixed(2),
    blockedMean: +blockedMean.toFixed(1), swing: +(clearMean - blockedMean).toFixed(1),
    passMeanS: +mean(durations).toFixed(3), passSdMs: +(sd(durations) * 1000).toFixed(1),
    fwdMeanS: +mean(fwd).toFixed(3), revMeanS: +mean(rev).toFixed(3),
  };
  console.log("\nsummary (" + label + ")");
  console.log(`  clear    mean ${row.clearMean}, lowest ${row.clearMin}, highest ${row.clearMax}, noise sd ${row.clearSd}  (${row.clearN} readings)`);
  console.log(`  blocked  mean ${row.blockedMean}  ->  swing ${row.swing}`);
  console.log(`  pass time  mean ${row.passMeanS} s, sd ${row.passSdMs} ms over ${row.passes} passes (forward ${row.fwdMeanS} s, reverse ${row.revMeanS} s)`);
  const file = localFile("results", "light_test_results.csv");
  if (!existsSync(file)) writeFileSync(file, Object.keys(row).join(",") + "\n");
  appendFileSync(file, Object.values(row).map((v) => String(v).replace(/,/g, ";")).join(",") + "\n");
  console.log(`  appended to local/results/light_test_results.csv`);
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); }).then(() => process.exit(0));
