#!/usr/bin/env node
// Leave the mark, do one loop, then on the second loop stop with the TAIL on the beam.
//
// Usage: node loops-tail.mjs [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
//   1. ramp to 40%; log leaving, beam clear, and the lap-1 nose pass (at cruise)
//   2. cruise most of the next lap, ramp down to 10%
//   3. creep: note the nose arriving, then stop when the tail wall drops the beam
//      (a wall = 2+ readings below LEVEL after a clean stretch; armed 3.2 s after the nose)

import { spawnSync } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";

const HOST = process.env.TRAIN_HOST || "ztrain.local";
const PORT = process.env.SENSOR_PORT || "/dev/cu.usbmodem1101";

const CRUISE = 0.4, CREEP = 0.1;
const CRUISE_AFTER_NOSE_MS = 13300;  // cruise this long after the lap-1 nose pass, then ramp down
const LAP1_TIMEOUT_MS = 22000;       // abort if the nose never comes round
const NOSE_MAX_MS = 7000;            // after the ramp-down, give up if the nose never arrives
const TAIL_MAX_MS = 9500;            // after the nose arrives, give up if no tail wall is found
const CLEAR_HOLD_MS = 600, PLATEAU_MIN = 960, PLATEAU_SPREAD = 6, NOSE_DROP = 45;  // lap-1 detection
const LEVEL = 760;                   // below this = wall (windows stay above it)
const TRIP_SAMPLES = 2;              // consecutive samples below LEVEL = a real dip
const CLEAN_HOLD_MS = 1000;          // clean stretch needed before a wall counts
const ARM_AFTER_NOSE_MS = 3200;      // ignore dips this soon after the nose (the joins)
const LEAVE_DELTA = 40, STALE_MS = 400, AFTER_MS = 1500;
const RAMP_INTERVAL = 100, RAMP_TIME_PER_SEGMENT = 1000;

const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main() {
  await sleep(1500);
  const recent = samples.slice(-20).map((s) => s.v);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const parked = median(recent);
  const spread = Math.max(...recent) - Math.min(...recent);
  console.log(`parked reading ${parked} (spread ${spread})`);
  if (spread > 80) throw new Error("sensor reading is not steady; not moving");
  if (dry) { console.log("dry run: sensor fine, train not moved"); return; }

  const { send, close } = await connect();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  let t0 = 0;
  const rel = (t) => ((t - t0) / 1000).toFixed(2);
  const log = (msg, t = Date.now()) => console.log(`+${rel(t).padStart(6)} s  ${msg}`);
  const events = {};
  let finalArmed = false;
  let resolveNose = () => {}, resolveTrip = () => {};
  const nosePromise = new Promise((r) => (resolveNose = r));
  const tripPromise = new Promise((r) => (resolveTrip = r));
  let tripAt = 0, tripV = 0;

  // lap-1 state
  let moveCount = 0, armed = false, tailWait = false, clearLevel = 0, win = [];
  const plateau = (w) => w.length > 5 && w[w.length - 1].t - w[0].t >= CLEAR_HOLD_MS - 40 &&
    Math.min(...w.map((x) => x.v)) >= PLATEAU_MIN &&
    Math.max(...w.map((x) => x.v)) - Math.min(...w.map((x) => x.v)) <= PLATEAU_SPREAD;
  // final-lap state
  let fBelow = 0, fFirst = 0, lastDipEnd = 0;
  const dips = [];

  onSample = (s) => {
    if (!events.left) {
      moveCount = Math.abs(s.v - parked) > LEAVE_DELTA ? moveCount + 1 : 0;
      if (moveCount >= 2 && t0) { events.left = s.t; log(`leaving: beam reading moved off the parked ${parked} (now ${s.v})`, s.t); }
    }
    win.push(s);
    while (win.length && s.t - win[0].t > CLEAR_HOLD_MS) win.shift();
    const clear = plateau(win);
    if (events.left && !armed && !events.nose && clear) {
      armed = true; clearLevel = median(win.map((x) => x.v));
      log(`beam clear at ${clearLevel}, train is away from the mark`);
    }
    if (armed && !events.nose && s.v < clearLevel - NOSE_DROP) {
      events.nose = s.t; armed = false; tailWait = true;
      log(`LAP 1: nose passes the beam at cruise (reading ${s.v})`, s.t); resolveNose();
    }
    if (tailWait && clear) { tailWait = false; events.tail = s.t; log("lap 1: tail has cleared the beam"); }

    // final lap: first real dip is the nose; then stop on the tail wall
    if (finalArmed && !stopped) {
      if (s.v >= LEVEL) { fBelow = 0; return; }
      fBelow++;
      if (fBelow === 1) fFirst = s.t;
      if (fBelow < TRIP_SAMPLES) return;
      if (fBelow === TRIP_SAMPLES) {
        if (!events.finalNose) {
          events.finalNose = fFirst;
          log(`loop 2: nose arrives at the beam at creep (reading ${s.v}); tail wall armed in ${ARM_AFTER_NOSE_MS / 1000} s`, fFirst);
        } else {
          const clean = lastDipEnd ? fFirst - lastDipEnd : 0;
          const why = fFirst < events.finalNose + ARM_AFTER_NOSE_MS ? "(not armed)" : clean < CLEAN_HOLD_MS ? "(too little clean run)" : "(wall)";
          dips.push(`+${rel(fFirst)}s v=${s.v} clean=${(clean / 1000).toFixed(2)}s ${why}`);
          if (why === "(wall)") { tripAt = s.t; tripV = s.v; stop(); resolveTrip(); }
        }
      }
      lastDipEnd = s.t;
    }
  };

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
  }
  const stale = () => { const l = samples[samples.length - 1]; return !l || Date.now() - l.t > STALE_MS; };
  let dog;

  try {
    send({ cmd: "direction", value: true });
    await sleep(200);
    t0 = Date.now();
    log(`ramp to ${CRUISE * 100}%`);
    const up = ramp(0, CRUISE);
    dog = setInterval(() => { if (!stopped && stale()) { console.error("sensor went quiet; stopping"); stop(); } }, 100);
    await up;

    const gotNose = await Promise.race([nosePromise.then(() => true), sleep(LAP1_TIMEOUT_MS).then(() => false)]);
    if (!gotNose || stopped) {
      log("no lap-1 nose pass detected; stopping safely");
      await ramp(CRUISE, 0); stop();
      return;
    }
    console.log(`          lap 1 took ${((events.nose - events.left) / 1000).toFixed(2)} s from leaving to nose pass`);

    await sleep(Math.max(0, events.nose + CRUISE_AFTER_NOSE_MS - Date.now()));
    if (stopped) return;
    if (!plateau(samples.slice(-30))) { log("beam is not clear before the final approach; stopping"); await ramp(CRUISE, 0); stop(); return; }

    log("loop 2: ramp down to creep, nose and tail detection armed");
    finalArmed = true;
    await ramp(CRUISE, CREEP);
    const creepStart = Date.now();
    if (!stopped) log("creeping at 10%");
    const watcher = (async () => {
      for (;;) {
        await sleep(100);
        if (stopped) return "stopped";
        if (!events.finalNose && Date.now() - creepStart > NOSE_MAX_MS) return "no nose";
        if (events.finalNose && Date.now() - events.finalNose > TAIL_MAX_MS) return "no tail";
      }
    })();
    const outcome = await Promise.race([tripPromise.then(() => "tripped"), watcher]);
    stop();
    if (outcome === "tripped") {
      log(`STOP: tail wall hit (reading ${tripV})`, tripAt);
      console.log(`          nose to tail wall: ${((tripAt - events.finalNose) / 1000).toFixed(2)} s`);
    } else {
      log(`stopped without finding the tail: ${outcome}`);
    }
    await sleep(AFTER_MS);
    console.log(`          final reading ${samples[samples.length - 1].v}`);
    console.log("          dips after the nose:\n            " + (dips.join("\n            ") || "none"));
  } finally {
    if (dog) clearInterval(dog);
    stop();
    send({ cmd: "direction", value: true });
    writeFileSync("trace_loops_tail.csv", samples.map((x) => `${((x.t - t0) / 1000).toFixed(3)},${x.v}`).join("\n"));
    await close();
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
