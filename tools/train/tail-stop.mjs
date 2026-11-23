#!/usr/bin/env node
// Single loco: from the mark (nose in the beam), creep forward at 10% and stop when the tail clears the beam.
//
// Usage: node tail-stop.mjs [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// For a solid, windowless loco the beam is blocked from nose to tail, so the tail is the moment the
// reading jumps back up. Creep speed only: 10% is about 2.3 in/s for this loco, under the abrupt-stop limit.

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { LEVELS } from "./lib/levels.mjs";

import { HOST, PORT } from "./lib/config.mjs";
const CREEP = 0.10;
const BLOCKED_MAX = LEVELS.parkedMax;   // the loco must be sitting in the beam at the start
const CLEAR_MIN = LEVELS.trip;     // two readings above this = the tail has cleared
const MAX_MS = 8000, STALE_MS = 400, AFTER_MS = 1200;

const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const v = parseInt(ln.trim(), 10);          // first number on the line; a timestamp may follow
    if (!started) { started = true; continue; }
    if (Number.isNaN(v)) continue;
    const s = { t: now, v };
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
  const hi = Math.max(...recent), lo = Math.min(...recent);
  console.log(`beam reading at the start: ${lo} to ${hi}`);
  if (hi > BLOCKED_MAX) throw new Error("the loco is not sitting in the beam; not moving");
  if (dry) { console.log("dry run: loco is in the beam, not moved"); return; }

  const { send, close } = await connect();
  let stopped = false;
  const quietStop = () => { if (!stopped) { stopped = true; send({ cmd: "speed", value: 0 }); } };
  const hardStop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  process.on("SIGINT", () => { hardStop(); process.exit(130); });
  process.on("SIGTERM", () => { hardStop(); process.exit(130); });

  let above = 0, tripAt = 0, tripV = 0, resolveTrip = () => {};
  const tripped = new Promise((r) => (resolveTrip = r));
  onSample = (s) => {
    if (stopped) return;
    above = s.v >= CLEAR_MIN ? above + 1 : 0;
    if (above >= 2) { tripAt = s.t; tripV = s.v; quietStop(); resolveTrip(); }
  };
  const t0 = Date.now();
  try {
    send({ cmd: "direction", value: true });
    await sleep(200);
    send({ cmd: "speed", value: CREEP });
    const dog = setInterval(() => { const l = samples[samples.length - 1]; if (!stopped && (!l || Date.now() - l.t > STALE_MS)) { console.error("sensor went quiet; stopping"); hardStop(); resolveTrip(); } }, 100);
    await Promise.race([tripped, sleep(MAX_MS)]);
    clearInterval(dog);
    quietStop();
    await sleep(AFTER_MS);
    if (tripAt) console.log(`STOPPED: the tail cleared the beam ${((tripAt - t0) / 1000).toFixed(2)} s after the command (reading ${tripV}); final reading ${samples[samples.length - 1].v}`);
    else console.log(`no tail found within ${MAX_MS / 1000} s; stopped; final reading ${samples[samples.length - 1].v}`);
  } finally {
    hardStop();
    await close();
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
