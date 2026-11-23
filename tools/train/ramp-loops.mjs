#!/usr/bin/env node
// Three loops, a little faster each time, then slow down and park on the nose.
//
// Usage: node ramp-loops.mjs [--dry] [--plan] [--start=0.40] [--final=0.65] [--allow-fast] [--creep=6]
//   --plan   print the final-loop plan for the default numbers and exit (no sensor, no train)
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// Start with the loco's nose in the beam (on the mark, the beam reading low) and local/loco_profile.json present.
//   loop 1  ramp to --start, lap at that throttle        (nose passes the beam at the end of the loop)
//   loop 2  ramp to the midpoint, lap
//   loop 3  ramp to --final, cruise, ramp down to 30%, hold briefly, ramp to creep, creep until the nose
//           breaks the beam, stop
// Every ramp is 1 s per 0.1 of throttle (the web UI's rate; motor care). The throttle only goes to zero at creep speed.
//
// The loop-3 timing is dead reckoning, calibrated on loop 2: the lap period measured between the loop-1 and
// loop-2 passes scales the speed model from loco_profile.json, then the cruise is placed so the nose reaches
// the beam at the end of a planned creep. The trip is armed only once the throttle is at creep, so an early
// arrival at speed is never stopped abruptly; the loco then just creeps on round to the beam.
// Speeds above 30% are an extrapolation of the profile fit, which is why loop 2 is used to calibrate.

import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { LEVELS } from "./lib/levels.mjs";

import { HOST, PORT } from "./lib/config.mjs";
import { localPath } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split("=")[1]) : d; };
const dry = flag("dry");

const prof = JSON.parse(readFileSync(localPath("loco_profile.json"), "utf8"));
const FIT_A = prof.fit.offsetInS, FIT_B = prof.fit.inPerSecPerUnitThrottle;
const SOLID = prof.signature?.solid === true;
const vm = (thr) => Math.max(0.5, FIT_A + FIT_B * thr);   // in/s from the profile fit (extrapolated above 30%)

const LOOP_IN = 134;
const T1 = opt("start", 0.40), T3 = opt("final", 0.65);
const T2 = Math.round(((T1 + T3) / 2) * 100) / 100;
const HOLD = 0.30, CREEP = 0.10;              // slow-down stage and creep throttle
const HOLD_S = 0.5, CREEP_S = opt("creep", 6); // planned time at 30%, planned creep time before the beam
const RAMP_S_PER_0_1 = 1;                      // seconds per 0.1 of throttle, both directions
const RAMP_INTERVAL = 100, MIN_TB = 0.3, LATENCY_S = 0.05;
const MAX_SHOW_MS = 150000, CREEP_MAX_MS = 90000, STALE_MS = 400, MIN_PASS_LED_MS = 500;
const CLEAR_HOLD_MS = 600, PLATEAU_MIN = LEVELS.plateauMin, PLATEAU_SPREAD = LEVELS.plateauSpread, NOSE_DROP = LEVELS.noseDrop;
const TRIP = LEVELS.trip, LEAVE_DELTA = LEVELS.leaveDelta;
const MAX_SAFE_IN_S = 9.0;
const RED = [1000, 0, 0], GREEN = [0, 1000, 0], BLUE = [0, 0, 1000], YELLOW = [1000, 1000, 0], PURPLE = [600, 0, 1000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (ms) => sleep(Math.max(0, ms - Date.now()));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r2 = (x) => Math.round(x * 100) / 100;

// ---- speed model and the final-loop plan ----
const rampPart = (a, b, k) => { const dur = (Math.abs(b - a) / 0.1) * RAMP_S_PER_0_1; return { dur, dist: k * vm((a + b) / 2) * dur }; };

function planFinal(from, top0, k) {
  let top = top0;
  for (;;) {
    const A = rampPart(from, top, k);
    const C = top > HOLD ? rampPart(top, HOLD, k) : { dur: 0, dist: 0 };
    const D = { dur: HOLD_S, dist: k * vm(HOLD) * HOLD_S };
    const E = rampPart(HOLD, CREEP, k);
    const F = { dur: CREEP_S, dist: k * vm(CREEP) * CREEP_S };
    const tB = (LOOP_IN - (A.dist + C.dist + D.dist + E.dist + F.dist)) / (k * vm(top));
    if (tB >= MIN_TB || top <= HOLD + 0.001) return { top, tB: Math.max(0, tB), A, C, D, E, F };
    top = r2(top - 0.05);
  }
}

function describePlan(p, k) {
  return [
    `final loop plan (speed scale k = ${k.toFixed(3)}):`,
    `  ramp ${Math.round(T2 * 100)}% -> ${Math.round(p.top * 100)}%  ${p.A.dur.toFixed(1)} s`,
    `  cruise ${Math.round(p.top * 100)}% (about ${(k * vm(p.top)).toFixed(1)} in/s, ${(k * vm(p.top) * 220 * 3600 / 63360).toFixed(0)} mph at 1:220)  ${p.tB.toFixed(1)} s`,
    `  ramp ${Math.round(p.top * 100)}% -> 30%  ${p.C.dur.toFixed(1)} s, hold 30%  ${p.D.dur.toFixed(1)} s`,
    `  ramp 30% -> 10%  ${p.E.dur.toFixed(1)} s, creep  about ${p.F.dur.toFixed(1)} s to the beam`,
  ].join("\n");
}

if (flag("plan")) {
  console.log(`loops: ${Math.round(T1 * 100)}% -> ${Math.round(T2 * 100)}% -> ${Math.round(T3 * 100)}%`);
  console.log(describePlan(planFinal(T2, T3, 1), 1));
  process.exit(0);
}

if (vm(T3) > MAX_SAFE_IN_S && !flag("allow-fast")) {
  console.error(`${Math.round(T3 * 100)}% would be about ${vm(T3).toFixed(1)} in/s, above the ${MAX_SAFE_IN_S} in/s guard (add --allow-fast to override)`);
  process.exit(1);
}
if (T3 > 0.70) { console.error("final throttle above 70% is not allowed"); process.exit(1); }

// ---- sensor ----
spawnSync("stty", ["-f", PORT, "115200", "raw", "-echo", "-hupcl"]);
const samples = [];
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

const plateau = (w) => w.length > 5 && w[w.length - 1].t - w[0].t >= CLEAR_HOLD_MS - 40 &&
  Math.min(...w.map((x) => x.v)) >= PLATEAU_MIN &&
  Math.max(...w.map((x) => x.v)) - Math.min(...w.map((x) => x.v)) <= PLATEAU_SPREAD;

async function main() {
  await sleep(1500);
  const recent = samples.slice(-20).map((s) => s.v);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const parked = median(recent);
  const spread = Math.max(...recent) - Math.min(...recent);
  console.log(`parked reading ${parked} (spread ${spread}); loops ${Math.round(T1 * 100)}% -> ${Math.round(T2 * 100)}% -> ${Math.round(T3 * 100)}%`);
  if (spread > 80) throw new Error("sensor reading is not steady; not moving");
  if (parked >= PLATEAU_MIN && !dry) throw new Error(`the nose is not in the beam (reading ${parked}): park the train on the mark first (node creep-stop.mjs)`);
  if (dry) { console.log("dry run: sensor fine, train not moved"); console.log(describePlan(planFinal(T2, T3, 1), 1)); return; }

  const { send, close } = await connect();
  let stopped = false, finishedOk = false, cur = 0, finalArmed = false, ledLocked = false;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const quietStop = () => { if (!stopped) { stopped = true; cur = 0; send({ cmd: "speed", value: 0 }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  let t0 = 0;
  const log = (msg) => console.log(`${t0 ? "+" + ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + " s" : "   start  "}  ${msg}`);
  const led = ([r, g, b]) => send({ cmd: "led", r, g, b });
  const setThr = (v) => { cur = v; send({ cmd: "speed", value: v }); };

  async function ramp(from, to) {
    const dur = Math.max((Math.abs(to - from) / 0.1) * RAMP_S_PER_0_1 * 1000, 1);
    const steps = Math.max(Math.ceil(dur / RAMP_INTERVAL), 1), start = Date.now();
    for (let i = 1; i <= steps; i++) {
      await sleepUntil(start + (i * dur) / steps);
      if (stopped) return;
      setThr(Math.round((from + (to - from) * (i / steps)) * 1000) / 1000);
    }
  }
  // Slow down to a standstill the way the web UI does; only a creep-speed throttle is cut straight to zero.
  async function gentleStop() {
    if (stopped) return;
    if (cur > CREEP) await ramp(cur, CREEP);
    quietStop();
  }

  // ---- beam tracking: leave -> arm -> passes ----
  let phase = "parked", moveCount = 0, win = [], clearLevel = 0, noseBelow = 0, noseFirstT = 0, noseFirstH = 0, recover = 0;
  let passLedAt = 0, below = 0, tripV = 0, tripAt = 0, resolveTrip = () => {};
  const tripPromise = new Promise((r) => (resolveTrip = r));
  const passes = [];
  onSample = (s) => {
    if (phase === "parked") {
      moveCount = Math.abs(s.v - parked) > LEAVE_DELTA ? moveCount + 1 : 0;
      if (moveCount >= 2 && t0) { phase = "away"; log("train is leaving the house"); }
    }
    win.push(s);
    while (win.length && s.t - win[0].t > CLEAR_HOLD_MS) win.shift();
    const clear = plateau(win);
    const lowNow = clearLevel > 0 && s.v < clearLevel - NOSE_DROP;
    if (lowNow) { if (!noseBelow++) { noseFirstT = s.t; noseFirstH = s.h; } } else noseBelow = 0;
    recover = clearLevel > 0 && !lowNow ? recover + 1 : 0;
    if (phase === "away" && clear) {
      phase = "armed"; clearLevel = median(win.map((x) => x.v));
      log("clear of the sensor");
    } else if (phase === "armed" && noseBelow >= 2) {
      phase = "inpass"; passes.push({ t: noseFirstT, h: noseFirstH });
      log(`loop ${passes.length} done: nose passes the beam at ${Math.round(cur * 100)}%`);
      if (!ledLocked) { led(PURPLE); passLedAt = Date.now(); }
    } else if (phase === "inpass" && (clear || (SOLID && recover >= 4))) {
      phase = "armed"; if (clear) clearLevel = median(win.map((x) => x.v));
      if (!ledLocked) setTimeout(() => { if (!ledLocked && !stopped) led(GREEN); }, Math.max(0, passLedAt + MIN_PASS_LED_MS - Date.now()));
    }
    if (finalArmed && !stopped) {
      below = s.v < TRIP ? below + 1 : 0;
      if (below >= 2) { tripAt = s.h; tripV = s.v; quietStop(); resolveTrip(); }
    }
  };
  const waitPass = async (n, ms) => {
    const end = Date.now() + ms;
    while (passes.length < n && Date.now() < end && !stopped) await sleep(10);
    return passes.length >= n;
  };

  let dog;
  try {
    send({ cmd: "direction", value: true });   // this resets the LED to its status colour
    await sleep(300);
    log("signal RED: holding"); led(RED); await sleep(3000);
    log("signal YELLOW: about to move"); led(YELLOW); await sleep(1000);
    t0 = Date.now();
    log(`signal GREEN: go! ramp to ${Math.round(T1 * 100)}%`);
    led(GREEN);
    dog = setInterval(() => {
      const l = samples[samples.length - 1];
      if (!stopped && (!l || Date.now() - l.h > STALE_MS)) { console.error("sensor went quiet; stopping"); stop(); }
      if (!stopped && Date.now() - t0 > MAX_SHOW_MS) { console.error("time limit; stopping"); stop(); }
    }, 100);

    // ---- loop 1 ----
    const clock0 = samples[samples.length - 1].t;
    await ramp(0, T1);
    if (!(await waitPass(1, (LOOP_IN / vm(T1)) * 2000 + 8000))) { log("no pass detected at the end of loop 1; stopping safely"); await gentleStop(); return; }
    const T1m = (passes[0].t - clock0) / 1000;
    log(`loop 1 took ${T1m.toFixed(2)} s`);

    // ---- loop 2 ----
    await ramp(T1, T2);
    if (!(await waitPass(2, (LOOP_IN / vm(T2)) * 2000 + 6000))) { log("no pass detected at the end of loop 2; stopping safely"); await gentleStop(); return; }
    const pass2H = passes[1].h;
    const T2m = (passes[1].t - passes[0].t) / 1000 - LATENCY_S;
    const r12 = rampPart(T1, T2, 1), v2 = vm(T2);
    const k = LOOP_IN / (v2 * (T2m - r12.dur) + r12.dist);
    log(`loop 2 took ${(T2m + LATENCY_S).toFixed(2)} s at ${Math.round(T2 * 100)}%: speed ${(k * v2).toFixed(1)} in/s, ${(k * v2 * 220 * 3600 / 63360).toFixed(0)} mph at 1:220, k = ${k.toFixed(3)}`);
    let top = T3;
    if (!(k > 0.7 && k < 1.3)) { log(`speed model is off by too much (k = ${k.toFixed(2)}); the final loop will slow down at 30%`); top = HOLD; }
    const plan = planFinal(T2, top, k);
    console.log(describePlan(plan, k));
    if (plan.top < top) log(`${Math.round(top * 100)}% does not fit with the slow-down; using ${Math.round(plan.top * 100)}%`);

    // ---- loop 3: ramp up, cruise, slow down, creep, stop on the nose ----
    log(`loop 3: ramp to ${Math.round(plan.top * 100)}%`);
    await ramp(T2, plan.top);
    if (stopped) return;
    const tCruiseEnd = Date.now() + Math.max(0, plan.tB * 1000 - (Date.now() - pass2H - plan.A.dur * 1000));
    log(`cruising at ${Math.round(plan.top * 100)}%`);
    await sleepUntil(tCruiseEnd);
    if (stopped) return;
    ledLocked = true; led(YELLOW);
    log("slowing: YELLOW");
    if (plan.top > HOLD) await ramp(plan.top, HOLD);
    await sleep(plan.D.dur * 1000);
    await ramp(HOLD, CREEP);
    if (stopped) return;
    finalArmed = true;
    log(`creeping at ${Math.round(CREEP * 100)}%: waiting for the nose`);
    const outcome = await Promise.race([tripPromise.then(() => "tripped"), sleep(CREEP_MAX_MS).then(() => "no trip")]);
    if (outcome !== "tripped") { stop(); log("no nose trip while creeping; stopped"); return; }
    log(`parked: nose broke the beam (reading ${tripV}). Signal RED`);
    led(RED);
    await sleep(4000);
    log("ready for the next job: BLUE");
    led(BLUE);
    await sleep(1500);
    console.log(`          final reading ${samples[samples.length - 1].v}`);
    finishedOk = true;
  } finally {
    if (dog) clearInterval(dog);
    if (!finishedOk) { if (!stopped) stop(); send({ cmd: "led_auto" }); }
    await close();
  }
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); }).then(() => process.exit(0));
