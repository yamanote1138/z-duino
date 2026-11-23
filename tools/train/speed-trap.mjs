#!/usr/bin/env node
// Scale speed trap: the beam times the train (nose tip to tail tip) at several throttle settings.
//
// Usage: node speed-trap.mjs [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// speed = train length / pass time.  The loop length comes from the lap period vs the pass time
// of two consecutive laps at the same speed.  The status LED flashes a colour for each reading.
// Ends by parking on the nose (timed from the previous nose pass; see signal-show.mjs for the lap-timed version).

import { spawnSync } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";
import { LEVELS } from "./lib/levels.mjs";

import { HOST, PORT } from "./lib/config.mjs";

const TRAIN_MM = 272;                       // 3 cars x 88 mm + 2 gaps x 4 mm
const SCALE = 220;                          // Z scale 1:220
const SPEEDS = [0.40, 0.40, 0.30, 0.20, 0.15];
const PASS_TIMEOUT_S = { 0.40: 32, 0.30: 42, 0.20: 62, 0.15: 85 };  // generous per lap
const CRUISE = 0.4, CREEP = 0.1;
const CRUISE_AFTER_NOSE_MS = 13300;         // parking approach, timed from the last nose pass
const NOSE_MAX_MS = 7000;
const CLEAR_HOLD_MS = 600, PLATEAU_MIN = LEVELS.plateauMin, PLATEAU_SPREAD = LEVELS.plateauSpread, NOSE_DROP = LEVELS.noseDrop;
const TRIP = LEVELS.trip, TRIP_SAMPLES = 2;
const LEAVE_DELTA = LEVELS.leaveDelta, STALE_MS = 400, AFTER_MS = 1500;
const RAMP_INTERVAL = 100, RAMP_TIME_PER_SEGMENT = 1000;

const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---- sensor ----
spawnSync("stty", ["-f", PORT, "115200", "raw", "-echo", "-hupcl"]);
const samples = [];
let partial = "", started = false, onSample = () => {};
const rs = createReadStream(PORT);
rs.on("data", (buf) => {
  const now = Date.now();
  partial += buf.toString("latin1");
  const lines = partial.split("\n");
  partial = lines.pop();
  for (const ln of lines) {
    const v = parseInt(ln.trim(), 10);
    if (!started) { started = true; continue; }
    if (Number.isNaN(v)) continue;
    const s = { t: now, v };
    samples.push(s);
    onSample(s);
  }
});
rs.on("error", (e) => { console.error("sensor error:", e.message); process.exit(1); });

// ---- train ----
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

// The final-approach check asks one thing: is the beam open? Every one of the last 30 readings must sit above the midpoint
// between blocked and the clear level this run measured, so it holds if the clear level has moved since the last calibration.
// It does not ask for a flat line: the clear reading wobbles by a few percent while the train runs (338 to 352 seen), which aborted a show.
const lastFlat = (clear, n = 30) => {
  const w = samples.slice(-n).map((x) => x.v);
  if (w.length < 20) return { ok: false, why: `only ${w.length} readings` };
  const lo = Math.min(...w), hi = Math.max(...w);
  const need = Math.round(LEVELS.blocked + 0.5 * ((clear || LEVELS.clear) - LEVELS.blocked));   // halfway between blocked and the clear level this run measured
  return { ok: lo >= need, why: `last ${w.length} readings ${lo} to ${hi} (need all >= ${need}, halfway between blocked and the measured clear level)` };
};

async function main() {
  await sleep(1500);
  const recent = samples.slice(-20).map((s) => s.v);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const parked = median(recent);
  const spread = Math.max(...recent) - Math.min(...recent);
  console.log(`parked reading ${parked} (spread ${spread})`);
  if (spread > 80) throw new Error("sensor reading is not steady; not moving");
  if (parked >= LEVELS.plateauMin && !process.argv.includes("--dry")) throw new Error(`the nose is not in the beam (reading ${parked}): park the train on the mark first (node creep-stop.mjs)`);
  if (dry) { console.log("dry run: sensor fine, train not moved"); return; }

  const { send, close } = await connect();
  let stopped = false, cur = 0;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  let t0 = 0;
  const rel = (t) => ((t - t0) / 1000).toFixed(1);
  const log = (msg, t = Date.now()) => console.log(`+${rel(t).padStart(6)} s  ${msg}`);

  // ---- beam state machine: parked -> away -> armed -> inpass -> armed ... ----
  let phase = "parked", moveCount = 0, win = [], clearLevel = 0, thr = 0, noseT = 0, lastBelowT = 0;
  let waiter = null;
  let finalArmed = false, below = 0, tripAt = 0, tripV = 0, resolveTrip = () => {};
  const tripPromise = new Promise((r) => (resolveTrip = r));
  onSample = (s) => {
    win.push(s);
    while (win.length && s.t - win[0].t > CLEAR_HOLD_MS) win.shift();
    const clear = plateau(win);
    if (phase === "parked") {
      moveCount = Math.abs(s.v - parked) > LEAVE_DELTA ? moveCount + 1 : 0;
      if (moveCount >= 2 && t0) { phase = "away"; log("leaving the mark", s.t); }
    } else if (phase === "away") {
      if (clear) { clearLevel = median(win.map((x) => x.v)); thr = clearLevel - NOSE_DROP; phase = "armed"; }
    } else if (phase === "armed") {
      if (s.v < thr) { phase = "inpass"; noseT = s.t; lastBelowT = s.t; if (waiter) waiter.onNose(s.t); }
    } else if (phase === "inpass") {
      if (s.v < thr) lastBelowT = s.t;
      if (clear) {
        phase = "armed"; clearLevel = median(win.map((x) => x.v)); thr = clearLevel - NOSE_DROP;
        if (waiter) { const w = waiter; waiter = null; w.res({ noseT, tailT: lastBelowT }); }
      }
    }
    if (finalArmed && !stopped) {
      below = s.v < TRIP ? below + 1 : 0;
      if (below >= TRIP_SAMPLES) { tripAt = s.t; tripV = s.v; stop(); resolveTrip(); }
    }
  };
  // wait for the next complete pass; onNose fires when its nose arrives
  const nextPass = (timeoutMs, onNose = () => {}) => new Promise((res) => {
    const w = { res, onNose };
    waiter = w;
    setTimeout(() => { if (waiter === w) { waiter = null; res(null); } }, timeoutMs);
  });

  async function ramp(from, to) {
    const segments = Math.round(Math.abs(to - from) / 0.1);
    const duration = Math.max(segments * RAMP_TIME_PER_SEGMENT, 200);
    const steps = Math.max(Math.ceil(duration / RAMP_INTERVAL), 5);
    for (let i = 1; i <= steps; i++) {
      if (stopped) return;
      send({ cmd: "speed", value: Math.round((from + (to - from) * (i / steps)) * 1000) / 1000 });
      await sleep(RAMP_INTERVAL);
    }
    if (!stopped) send({ cmd: "speed", value: to });
    cur = to;
  }

  const results = [];
  const flash = (mph) => {
    const [r, g, b] = mph < 35 ? [0, 1000, 0] : mph < 70 ? [1000, 650, 0] : [1000, 0, 0];
    send({ cmd: "led", r, g, b });
    setTimeout(() => send({ cmd: "led_auto" }), 2500);
  };
  const radar = (setting, pass, label) => {
    const dt = (pass.tailT - pass.noseT) / 1000;
    const mmps = TRAIN_MM / dt;
    const mph = (mmps * SCALE) / 1000 * 3.6 / 1.609344;
    const r = { label, setting, passS: +dt.toFixed(3), mmps: +mmps.toFixed(1), inps: +(mmps / 25.4).toFixed(2),
                scaleMph: +mph.toFixed(0), scaleKmh: +(mph * 1.609344).toFixed(0), noseT: pass.noseT };
    results.push(r);
    log(`RADAR ${label}: ${Math.round(setting * 100)}% throttle: train took ${dt.toFixed(2)} s -> ${r.inps} in/s = ${r.mmps} mm/s = ${r.scaleMph} mph scale (${r.scaleKmh} km/h)`, pass.tailT);
    flash(mph);
    return r;
  };

  let dog;
  try {
    send({ cmd: "direction", value: true });
    await sleep(200);
    t0 = Date.now();
    log(`ramp to ${SPEEDS[0] * 100}%`);
    dog = setInterval(() => { if (!stopped && (!samples.length || Date.now() - samples[samples.length - 1].t > STALE_MS)) { console.error("sensor went quiet; stopping"); stop(); } }, 100);
    await ramp(0, SPEEDS[0]);

    for (let i = 0; i < SPEEDS.length; i++) {
      const sp = SPEEDS[i];
      const pass = await nextPass((PASS_TIMEOUT_S[sp] + (i === 0 ? 6 : 0)) * 1000);
      if (!pass || stopped) { log(`no pass seen at ${sp * 100}%; stopping safely`); await ramp(cur, 0); stop(); return; }
      radar(sp, pass, `pass ${i + 1}`);
      if (i === 1) {
        // two consecutive laps at 40%: lap period vs pass time gives the loop length
        const a = results[0], b = results[1];
        const T = (b.noseT - a.noseT) / 1000;
        const dtAvg = (a.passS + b.passS) / 2;
        const loopMm = TRAIN_MM * T / dtAvg;
        log(`LOOP: lap period ${T.toFixed(2)} s at 40%, pass ${dtAvg.toFixed(2)} s -> loop = ${(loopMm / 25.4).toFixed(0)}" (${(loopMm / 1000).toFixed(2)} m). Assumed 158.5" before.`);
        results.loopInches = +(loopMm / 25.4).toFixed(1);
      }
      const next = i + 1 < SPEEDS.length ? SPEEDS[i + 1] : CRUISE;
      if (next !== cur) await ramp(cur, next);
    }

    // parking: one more 40% lap, then ramp down and creep onto the nose
    let parkNose = 0;
    const pass = await nextPass(40000, (t) => { parkNose = t; });
    if (!pass || stopped) { log("no parking pass seen; stopping safely"); await ramp(cur, 0); stop(); return; }
    radar(CRUISE, pass, "parking pass");
    await sleep(Math.max(0, parkNose + CRUISE_AFTER_NOSE_MS - Date.now()));
    const fl = lastFlat(clearLevel); if (!fl.ok) { log("beam not clear before the final approach; stopping (" + fl.why + ")"); await ramp(cur, 0); stop(); return; }
    log("final approach: ramp down to creep");
    finalArmed = true;
    await ramp(CRUISE, CREEP);
    const outcome = await Promise.race([tripPromise.then(() => "tripped"), sleep(NOSE_MAX_MS).then(() => "no trip")]);
    stop();
    if (outcome === "tripped") log(`PARKED: nose broke the beam (reading ${tripV})`, tripAt);
    else log("no nose trip while creeping; stopped");
    await sleep(AFTER_MS);
    console.log(`          final reading ${samples[samples.length - 1].v} (parked reading before was ${parked})`);
  } finally {
    if (dog) clearInterval(dog);
    stop();
    send({ cmd: "led_auto" });
    send({ cmd: "direction", value: true });
    writeFileSync("speedtrap_results.json", JSON.stringify({ results, loopInches: results.loopInches }, null, 1));
    await close();
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
