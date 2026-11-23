#!/usr/bin/env node
// Z-Duino lap runner: dead-reckoning laps on the loop, parking in the train house.
//
// Usage:
//   node laps.mjs <laps> [speed%=40] [--dry]     run N laps (30, 35 or 40) and stop
//   node laps.mjs nudge <fwd|back> <seconds>     10% nudge for fine positioning
//
// Env: TRAIN_HOST (default ztrain.local; the board's IP is more reliable than mDNS)
//
// Position is open-loop (no sensors), so the train should start on the park mark.
// Observed scatter is about +/-2.5" on one lap and +/-1.5" on two laps.

import { HOST } from "./lib/config.mjs";

// ---- Calibration (measured on the 6ft x 1ft Rokuhan Z oval) ----
const LOOP_IN = 158.5;       // loop length in inches
const NUDGE_SPEED = 0.1;     // fine positioning speed
const NUDGE_IN_PER_S = 1.9;  // measured distance per second at 10%
// distance = cruiseInPerS * (cruiseSeconds + rampEquivalentSeconds)
const CAL = {
  30: { cruiseInPerS: 7.55,  rampEq: 2.54 },
  35: { cruiseInPerS: 8.73,  rampEq: 3.54 },
  40: { cruiseInPerS: 10.18, rampEq: 3.44 },
};

// Firmware stops the motor after 30s with no messages, so ping while cruising.
const KEEPALIVE_MS = 5000;
// Ramp mirrors the web UI: linear, 100ms steps, 1000ms per 0.1 of speed.
const RAMP_INTERVAL = 100;
const RAMP_TIME_PER_SEGMENT = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cruiseSeconds(laps, speedPct) {
  const c = CAL[speedPct];
  if (!c) throw new Error(`speed must be one of ${Object.keys(CAL).join(", ")}`);
  return (laps * LOOP_IN) / c.cruiseInPerS - c.rampEq;
}

async function connect() {
  const ws = new WebSocket(`ws://${HOST}:81`);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`connect failed (${HOST})`)), { once: true });
    setTimeout(() => rej(new Error(`connect timeout (${HOST})`)), 5000);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const keepalive = setInterval(() => send({ cmd: "ping" }), KEEPALIVE_MS);
  const close = async () => {
    clearInterval(keepalive);
    await sleep(300);
    ws.close();
  };
  return { send, close };
}

async function ramp(send, from, to) {
  const segments = Math.round(Math.abs(to - from) / 0.1);
  const duration = Math.max(segments * RAMP_TIME_PER_SEGMENT, 200);
  const steps = Math.max(Math.ceil(duration / RAMP_INTERVAL), 5);
  for (let i = 1; i <= steps; i++) {
    send({ cmd: "speed", value: Math.round((from + (to - from) * (i / steps)) * 1000) / 1000 });
    await sleep(RAMP_INTERVAL);
  }
  send({ cmd: "speed", value: to });
}

async function guarded(fn) {
  const { send, close } = await connect();
  const bail = () => { send({ cmd: "stop" }); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);
  try {
    await fn(send);
  } catch (err) {
    console.error("error:", err.message);
    process.exitCode = 1;
  } finally {
    send({ cmd: "stop" });
    send({ cmd: "direction", value: true });
    await close();
  }
}

async function runLaps(laps, speedPct, dry) {
  const cruise = cruiseSeconds(laps, speedPct);
  const speed = speedPct / 100;
  const rampS = Math.max(Math.round(speed / 0.1), 2);
  const total = cruise + 2 * rampS;
  console.log(`${laps} lap(s) at ${speedPct}%: cruise ${cruise.toFixed(2)}s, total ~${total.toFixed(0)}s`);
  if (dry) return;
  await guarded(async (send) => {
    send({ cmd: "direction", value: true });
    await ramp(send, 0, speed);
    await sleep(cruise * 1000);
    await ramp(send, speed, 0);
    send({ cmd: "stop" });
  });
  console.log("done");
}

async function nudge(dir, seconds) {
  const inches = (seconds * NUDGE_IN_PER_S).toFixed(1);
  console.log(`nudge ${dir} ${seconds}s (~${inches}")`);
  await guarded(async (send) => {
    send({ cmd: "direction", value: dir === "fwd" });
    await sleep(200);
    send({ cmd: "speed", value: NUDGE_SPEED });
    await sleep(seconds * 1000);
  });
}

// ---- CLI ----
const args = process.argv.slice(2).filter((a) => a !== "--dry");
const dry = process.argv.includes("--dry");
if (args[0] === "nudge") {
  const [, dir, secs] = args;
  if (!["fwd", "back"].includes(dir) || !(Number(secs) > 0) || Number(secs) > 10)
    throw new Error("usage: nudge <fwd|back> <seconds 0-10>");
  await nudge(dir, Number(secs));
} else if (args.length) {
  const laps = Number(args[0]);
  if (!(laps > 0) || laps > 5) throw new Error("laps must be between 1 and 5");
  await runLaps(laps, Number(args[1] || 40), dry);
} else {
  console.log("usage: node laps.mjs <laps> [30|35|40] [--dry] | node laps.mjs nudge <fwd|back> <seconds>");
}
