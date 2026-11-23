#!/usr/bin/env node
// From the park mark: creep forward and stop on the tail, wait, then creep back and stop on the nose.
//
// Usage: node tail-nose.mjs [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// Landmarks are the solid end walls of the train. A wall shows as a sharp drop in the beam reading
// that comes after a clean stretch of windows. Joins and the middle car are skipped by requiring
// that clean run, and by ignoring the first ARM_MS of each leg.

import { spawnSync } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";
import { LEVELS } from "./lib/levels.mjs";

import { HOST, PORT } from "./lib/config.mjs";
import { localFile } from "./lib/paths.mjs";

const CREEP = 0.1;
const LEVEL = LEVELS.wall;           // below this is a wall; windows stay above it
const CLEAN_HOLD_MS = 1000;  // clean stretch (since the last real dip) needed before a wall counts
const TRIP_SAMPLES = 2;      // consecutive samples below LEVEL
const ARM_MS = 3200;         // ignore the first stretch of each leg (the joins)
const LEG_MAX_MS = 9500;     // give up on a leg after this long
const STALE_MS = 400;
const WAIT_BETWEEN_MS = 4000;
const AFTER_MS = 1500;

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
  let stopped = true;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  process.on("SIGINT", () => { send({ cmd: "stop" }); process.exit(130); });
  process.on("SIGTERM", () => { send({ cmd: "stop" }); process.exit(130); });

  // One creep leg: move at 10% until a wall drops the beam, then stop.
  async function leg(name, forward) {
    stopped = false;
    // A "dip" needs TRIP_SAMPLES consecutive readings below LEVEL; a single stray sample is ignored.
    // The clean run is measured from the end of the previous real dip to the start of this one.
    let lastDipEnd = 0, below = 0, firstBelow = 0;
    let trip = null, resolveTrip = () => {}, armAt = Infinity, t0 = 0;
    const dips = [];
    const legStartIdx = samples.length;
    const tripped = new Promise((r) => (resolveTrip = r));
    onSample = (s) => {
      if (stopped) return;
      if (s.v >= LEVEL) { below = 0; return; }
      below++;
      if (below === 1) firstBelow = s.t;
      if (below < TRIP_SAMPLES) return;
      if (below === TRIP_SAMPLES) {
        const clean = lastDipEnd ? firstBelow - lastDipEnd : 0;
        const why = firstBelow < armAt ? "(not armed)" : clean < CLEAN_HOLD_MS ? "(too little clean run)" : "(wall)";
        dips.push(`+${((firstBelow - t0) / 1000).toFixed(2)}s v=${s.v} clean=${(clean / 1000).toFixed(2)}s ${why}`);
        if (firstBelow >= armAt && clean >= CLEAN_HOLD_MS) { trip = { t: s.t, v: s.v, clean }; stop(); resolveTrip(); }
      }
      lastDipEnd = s.t;
    };
    send({ cmd: "direction", value: forward });
    await sleep(200);
    t0 = Date.now(); armAt = t0 + ARM_MS;
    send({ cmd: "speed", value: CREEP });
    console.log(`${name}: creeping ${forward ? "forward" : "backward"} at ${CREEP * 100}%`);
    const dog = setInterval(() => {
      const l = samples[samples.length - 1];
      if (!stopped && (!l || Date.now() - l.t > STALE_MS)) { console.error("sensor went quiet; stopping"); stop(); resolveTrip(); }
    }, 100);
    await Promise.race([tripped, sleep(LEG_MAX_MS)]);
    clearInterval(dog);
    const hit = !!trip;
    stop();
    await sleep(AFTER_MS);
    const final = samples[samples.length - 1].v;
    writeFileSync(localFile("traces", `trace_${name}.csv`), samples.slice(legStartIdx).map((x) => `${((x.t - t0) / 1000).toFixed(3)},${x.v}`).join("\n"));
    console.log(`${name}: dips seen (first sample below ${LEVEL}):\n  ` + (dips.join("\n  ") || "none"));
    if (hit) console.log(`${name}: STOP, wall hit ${((trip.t - t0) / 1000).toFixed(2)} s in (reading ${trip.v}, after ${(trip.clean / 1000).toFixed(2)} s clean); final reading ${final}`);
    else console.log(`${name}: no wall found within ${LEG_MAX_MS / 1000} s; stopped; final reading ${final}`);
    return hit;
  }

  try {
    const ok1 = await leg("tail", true);
    if (!ok1) { console.log("not reversing, since the tail was not found"); return; }
    console.log(`waiting ${WAIT_BETWEEN_MS / 1000} s...`);
    await sleep(WAIT_BETWEEN_MS);
    await leg("nose", false);
  } finally {
    stop();
    send({ cmd: "direction", value: true });
    await close();
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
