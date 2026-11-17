#!/usr/bin/env node
// Creep forward at 10% and stop the train when the beam sensor trips.
//
// Usage: node creep-stop.mjs [--dry]
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// The sensor Arduino prints one A0 reading per line (about 50 per second).
// Clear beam reads about 988, a blocked beam drops below 650.

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";

const HOST = process.env.TRAIN_HOST || "ztrain.local";
const PORT = process.env.SENSOR_PORT || "/dev/cu.usbmodem1101";
const CREEP = 0.1;          // creep speed
const TRIP = 800;           // stop when readings fall below this
const TRIP_SAMPLES = 2;     // consecutive samples below TRIP
const CLEAR_MIN = 900;      // beam must read at least this before we start
const MAX_CREEP_MS = 8000;  // give up and stop after this long
const STALE_MS = 400;       // stop if the sensor goes quiet while moving
const AFTER_MS = 1500;      // keep recording after the stop

const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sensor ----
spawnSync("stty", ["-f", PORT, "115200", "raw", "-echo", "-hupcl"]);
const samples = []; // {t, v}
let partial = "";
let started = false; // ignore the first partial line
let onSample = () => {};
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

async function main() {
  // 1. Check the beam is clear before moving anything.
  await sleep(1500);
  const recent = samples.slice(-20);
  if (recent.length < 20) throw new Error(`no sensor data from ${PORT}`);
  const lo = Math.min(...recent.map((s) => s.v));
  console.log(`beam check: ${recent.length} samples, lowest ${lo}`);
  if (lo < CLEAR_MIN) throw new Error(`beam is not clear (lowest ${lo}, need ${CLEAR_MIN}+); not moving`);
  if (dry) { console.log("dry run: sensor fine, train not moved"); return; }

  const { send, close } = await connect();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  let result = "timeout";
  let tStart = 0, tTrip = 0, tripValue = 0;
  try {
    let below = 0;
    const tripped = new Promise((resolve) => {
      onSample = (s) => {
        if (stopped) return;
        below = s.v < TRIP ? below + 1 : 0;
        if (below >= TRIP_SAMPLES) { tTrip = s.t; tripValue = s.v; stop(); resolve("tripped"); }
      };
    });
    send({ cmd: "direction", value: true });
    await sleep(200);
    send({ cmd: "speed", value: CREEP });
    tStart = Date.now();
    const stale = new Promise((resolve) => {
      const iv = setInterval(() => {
        const last = samples[samples.length - 1];
        if (!stopped && last && Date.now() - last.t > STALE_MS) { clearInterval(iv); resolve("sensor went quiet"); }
        if (stopped) clearInterval(iv);
      }, 100);
    });
    result = await Promise.race([tripped, stale, sleep(MAX_CREEP_MS).then(() => "no trigger in time")]);
    stop();
    await sleep(AFTER_MS);
  } finally {
    stop();
    send({ cmd: "direction", value: true });
    await close();
  }

  if (result === "tripped") {
    console.log(`TRIPPED ${tTrip - tStart} ms after the speed command; reading ${tripValue}`);
    const around = samples.filter((s) => s.t >= tTrip - 100 && s.t <= tTrip + 400).map((s) => s.v);
    console.log("readings around the trip (20 ms apart):", around.join(" "));
    console.log("final reading:", samples[samples.length - 1].v);
  } else {
    console.log(`STOPPED WITHOUT TRIP: ${result}`);
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
