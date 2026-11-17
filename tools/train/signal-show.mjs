#!/usr/bin/env node
// Signal show: the controller's RGB LED acts as a railway signal for three loops.
//
//   red (3 s) -> yellow (1 s) -> green = go, dispatch at once (drag-race start)
//   -> purple while the train passes the sensor at the end of loops 1 and 2 (--party for a beat show)
//   -> yellow while slowing/creeping on loop 3 -> red when parked (4 s) -> blue (ready)
//
// Usage: node signal-show.mjs [--dry] [--party] [--loco [--cruise=<in/s>] [--creep=<s>] [--allow-fast]]
//   --loco takes its speeds from loco_profile.json (learn-loco.mjs); default cruise 8.8 in/s, creep aim 4 s.
// Env:   TRAIN_HOST (board IP), SENSOR_PORT (default /dev/cu.usbmodem1101)
//
// Start with the train parked on the mark (nose at the beam). It leaves, laps at 40%, and on loop 3
// ramps down and creeps until the nose breaks the beam. The ramp-down is timed from the lap period
// measured between the loop-1 and loop-2 passes, aiming for a ~6 s creep.
// The final stop uses speed 0: the "stop" command blinks the LED magenta and would hide the red.

import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";

const HOST = process.env.TRAIN_HOST || "ztrain.local";
const PORT = process.env.SENSOR_PORT || "/dev/cu.usbmodem1101";

const RED = [1000, 0, 0], GREEN = [0, 1000, 0], BLUE = [0, 0, 1000], YELLOW = [1000, 1000, 0];
const PURPLE = [600, 0, 1000];
const PARTY_COLORS = [RED, GREEN, BLUE, YELLOW, [0, 1000, 1000], [1000, 0, 1000], [1000, 1000, 1000]];
const PARTY_FRAME_MS = 50, PARTY_BPM = 128;
const HOLD_RED_START_MS = 3000, HOLD_YELLOW_START_MS = 1000, HOLD_RED_END_MS = 4000, HOLD_BLUE_END_MS = 1500;

let CRUISE = 0.4, CREEP = 0.1;
const LAP1_TIMEOUT_MS = 22000, LAP2_TIMEOUT_MS = 26000, CREEP_MAX_MS = 12000;
// Final approach is timed from the lap period measured between the loop-1 and loop-2 passes.
// remaining distance at ramp-down start = ramp distance + creep time x creep speed;
// ramp-down starts (T - remaining / cruise speed) after the loop-2 nose pass.
let CRUISE_IN_S = 8.64, CREEP_IN_S = 1.96, RAMP_DIST_IN = 15.9, CREEP_TARGET_S = 6.0;
const FALLBACK_AFTER_NOSE_MS = 12700;   // used only if the measured lap period looks wrong
const CLEAR_HOLD_MS = 600, PLATEAU_MIN = 960, PLATEAU_SPREAD = 6, NOSE_DROP = 45;
const TRIP = 800, TRIP_SAMPLES = 2, LEAVE_DELTA = 40, STALE_MS = 400, AFTER_MS = 1500;
const RAMP_INTERVAL = 100, RAMP_TIME_PER_SEGMENT = 1000;

const dry = process.argv.includes("--dry");
const partyMode = process.argv.includes("--party");   // beat show on passes instead of solid purple
const MIN_PASS_LED_MS = 1200;   // keep a fast pass visible: hold the pass colour at least this long
const MAX_IN_S = 9.0;           // derailment guard on the target cruise speed
const ABRUPT_STOP_MAX_IN_S = 2.5;  // motor care: only cut the throttle to zero at or below this speed
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
let locoLenIn = null;
if (process.argv.includes("--loco")) {
  // Single locomotive: speeds come from loco_profile.json (written by learn-loco.mjs).
  const prof = JSON.parse(readFileSync("loco_profile.json", "utf8"));
  const b = prof.fit.inPerSecPerUnitThrottle, a = prof.fit.offsetInS;
  const speedAt = (t) => a + b * t;
  const target = Number(arg("cruise") || 8.8);
  if (target > MAX_IN_S && !process.argv.includes("--allow-fast")) { console.error(`target ${target} in/s is above the ${MAX_IN_S} in/s limit (add --allow-fast to override)`); process.exit(1); }
  CRUISE = Math.round(((target - a) / b) * 100) / 100;
  CREEP = 0.10;
  CRUISE_IN_S = speedAt(CRUISE); CREEP_IN_S = speedAt(CREEP);
  RAMP_DIST_IN = speedAt((CRUISE + CREEP) / 2) * Math.max(Math.round((CRUISE - CREEP) / 0.1), 1);
  CREEP_TARGET_S = Number(arg("creep") || 4);
  locoLenIn = prof.lengthIn;
  console.log(`loco mode: cruise ${Math.round(CRUISE * 100)}% = ${CRUISE_IN_S.toFixed(2)} in/s (${(CRUISE_IN_S * 220 * 3600 / 63360).toFixed(0)} mph at 1:220), creep ${Math.round(CREEP * 100)}% = ${CREEP_IN_S.toFixed(2)} in/s, ramp distance ${RAMP_DIST_IN.toFixed(1)}"`);
}
if (CREEP_IN_S > ABRUPT_STOP_MAX_IN_S) { console.error(`creep speed ${CREEP_IN_S.toFixed(2)} in/s is above the abrupt-stop limit ${ABRUPT_STOP_MAX_IN_S} in/s`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// Port of the web app's partyBeat.ts: techno beat -> RGB frames.
function createPartyBeat(colors, bpm = PARTY_BPM) {
  const beatMs = 60000 / bpm;
  let currentBar = -1, colorIdx = -1;
  const kick = (phase, peak = 1) => 0.1 + (peak - 0.1) * Math.exp(-5 * phase);
  const hat = (phase) => (phase < 0.5 ? 0 : 0.45 * Math.exp(-22 * (phase - 0.5)));
  const clamp = (v) => Math.min(1000, Math.max(0, Math.round(v)));
  return (elapsedMs) => {
    const beat = elapsedMs / beatMs, beatIdx = Math.floor(beat), phase = beat - beatIdx;
    const bar = Math.floor(beatIdx / 4), beatInBar = beatIdx % 4;
    if (bar !== currentBar) {
      currentBar = bar;
      let next = colorIdx;
      while (next === colorIdx) next = Math.floor(Math.random() * colors.length);
      colorIdx = next;
    }
    const c = colors[colorIdx];
    let level, sparkle = 0;
    if (bar % 4 === 3 && beatInBar === 3) { const sub = phase * 4, hit = Math.floor(sub); level = kick(sub - hit, 0.6 + 0.1 * hit); }
    else { level = kick(phase); sparkle = hat(phase); }
    return [clamp(c[0] * level + 1000 * sparkle), clamp(c[1] * level + 1000 * sparkle), clamp(c[2] * level + 1000 * sparkle)];
  };
}

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
  let stopped = false, finishedOk = false;
  const stop = () => { if (!stopped) { stopped = true; send({ cmd: "stop" }); } };
  const quietStop = () => { if (!stopped) { stopped = true; send({ cmd: "speed", value: 0 }); } };
  const bail = () => { stop(); process.exit(130); };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);

  // ---- LED signal ----
  let partyTimer = null, lastKey = "";
  const led = ([r, g, b]) => send({ cmd: "led", r, g, b });
  const stopParty = () => { if (partyTimer) { clearInterval(partyTimer); partyTimer = null; } };
  const solid = (c) => { stopParty(); led(c); };
  const startParty = () => {
    if (partyTimer) return;
    const frame = createPartyBeat(PARTY_COLORS), t = Date.now();
    lastKey = "";
    partyTimer = setInterval(() => {
      const f = frame(Date.now() - t), key = f.join(",");
      if (key === lastKey) return;
      lastKey = key;
      led(f);
    }, PARTY_FRAME_MS);
  };

  let t0 = 0;
  const rel = (t) => ((t - t0) / 1000).toFixed(1);
  const log = (msg, t = Date.now()) => console.log(`${t0 ? "+" + rel(t).padStart(6) + " s" : "   start  "}  ${msg}`);

  let phase = "parked", moveCount = 0, win = [], clearLevel = 0, lastBelowT = 0, passLedAt = 0, tooFast = false;
  let finalArmed = false, below = 0, tripAt = 0, tripV = 0, resolveTrip = () => {};
  const tripPromise = new Promise((r) => (resolveTrip = r));
  let leftT = 0, noseT = 0, passNo = 0, noseWaiter = null;
  const noses = [];
  const waitNose = (ms) => new Promise((res) => {
    noseWaiter = res;
    setTimeout(() => { if (noseWaiter === res) { noseWaiter = null; res(false); } }, ms);
  });

  onSample = (s) => {
    if (phase === "parked") {
      moveCount = Math.abs(s.v - parked) > LEAVE_DELTA ? moveCount + 1 : 0;
      if (moveCount >= 2 && t0) { phase = "away"; leftT = s.t; log("train is leaving the house", s.t); }
    }
    win.push(s);
    while (win.length && s.t - win[0].t > CLEAR_HOLD_MS) win.shift();
    const clear = plateau(win);
    if (phase === "inpass" && s.v < clearLevel - NOSE_DROP) lastBelowT = s.t;
    if (phase === "away" && clear) {
      phase = "armed"; clearLevel = median(win.map((x) => x.v));
      log("clear of the sensor");
    } else if (phase === "armed" && !finalArmed && s.v < clearLevel - NOSE_DROP) {
      phase = "inpass"; noseT = s.t; passNo++; noses.push(s.t);
      log(`end of loop ${passNo}: train passing the sensor at cruise: ${partyMode ? "PARTY" : "PURPLE"}`, s.t);
      if (partyMode) startParty(); else solid(PURPLE);
      passLedAt = Date.now(); lastBelowT = s.t;
      if (noseWaiter) { const w = noseWaiter; noseWaiter = null; w(true); }
    } else if (phase === "inpass" && clear) {
      phase = "armed"; clearLevel = median(win.map((x) => x.v));
      if (locoLenIn) {
        const dt = (lastBelowT - noseT) / 1000 + 0.02, v = locoLenIn / dt;
        log(`loop ${passNo}: passed the beam in ${dt.toFixed(2)} s = ${v.toFixed(1)} in/s (${(v * 220 * 3600 / 63360).toFixed(0)} mph at 1:220)`);
        if (v > MAX_IN_S + 1.0) tooFast = true;
      }
      log(`loop ${passNo}: clear again: green`);
      setTimeout(() => { if (!finalArmed) solid(GREEN); }, Math.max(0, passLedAt + MIN_PASS_LED_MS - Date.now()));
    }
    if (finalArmed && !stopped) {
      below = s.v < TRIP ? below + 1 : 0;
      if (below >= TRIP_SAMPLES) { tripAt = s.t; tripV = s.v; quietStop(); resolveTrip(); }
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
  let dog;

  try {
    send({ cmd: "direction", value: true });   // note: this resets the LED to its status colour
    await sleep(300);
    log("signal RED: holding");
    solid(RED);
    await sleep(HOLD_RED_START_MS);
    log("signal YELLOW: about to move");
    solid(YELLOW);
    await sleep(HOLD_YELLOW_START_MS);
    t0 = Date.now();
    log(`signal GREEN: go! dispatching, ramp to ${Math.round(CRUISE * 100)}%`);
    solid(GREEN);
    dog = setInterval(() => { const l = samples[samples.length - 1]; if (!stopped && (!l || Date.now() - l.t > STALE_MS)) { console.error("sensor went quiet; stopping"); stop(); } }, 100);
    await ramp(0, CRUISE);

    for (const [n, timeout] of [[1, LAP1_TIMEOUT_MS], [2, LAP2_TIMEOUT_MS]]) {
      const ok = await waitNose(timeout);
      if (!ok || stopped) { log(`no pass detected at the end of loop ${n}; stopping safely`); await ramp(CRUISE, 0); stop(); return; }
      if (tooFast) { log("running faster than the limit; stopping safely"); await ramp(CRUISE, 0); stop(); return; }
    }
    const T = (noses[1] - noses[0]) / 1000;
    let afterMs = FALLBACK_AFTER_NOSE_MS;
    if (T > 12 && T < 20) {
      afterMs = (T - (RAMP_DIST_IN + CREEP_IN_S * CREEP_TARGET_S) / CRUISE_IN_S) * 1000;
      log(`measured lap period ${T.toFixed(2)} s: ramp-down in ${(afterMs / 1000).toFixed(2)} s, aiming for a ${CREEP_TARGET_S} s creep`);
    } else {
      log(`lap period ${T.toFixed(2)} s looks wrong; using the fixed timer`);
    }
    await sleep(Math.max(0, noseT + afterMs - Date.now()));
    if (stopped) return;
    if (!plateau(samples.slice(-30))) { log("beam not clear before the final approach; stopping"); await ramp(CRUISE, 0); stop(); return; }

    log("loop 3: slowing: YELLOW");
    solid(YELLOW);
    finalArmed = true;
    await ramp(CRUISE, CREEP);
    if (!stopped) log("creeping at 10%: yellow");
    const outcome = await Promise.race([tripPromise.then(() => "tripped"), sleep(CREEP_MAX_MS).then(() => "no trip")]);
    if (outcome !== "tripped") { stop(); log("no nose trip while creeping; stopped"); return; }

    log(`parked: nose broke the beam (reading ${tripV}). Signal RED`, tripAt);
    solid(RED);
    await sleep(HOLD_RED_END_MS);
    log("ready for the next job: BLUE");
    solid(BLUE);
    await sleep(HOLD_BLUE_END_MS);
    console.log(`          final reading ${samples[samples.length - 1].v}`);
    finishedOk = true;
  } finally {
    if (dog) clearInterval(dog);
    stopParty();
    if (!finishedOk) { stop(); send({ cmd: "led_auto" }); }   // abnormal exit: back to the status colour
    await close();  // on disconnect the controller returns to its idle colour: blue
  }
}

main().catch((e) => { console.error("error:", e.message); process.exitCode = 1; }).finally(() => process.exit());
