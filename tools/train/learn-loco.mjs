#!/usr/bin/env node
// Learn a locomotive with no help: find it, measure its length and speed, and learn how it stops.
//
// Usage: node learn-loco.mjs [--dry] [--resume] [--in-beam] [--stages=find,length,speeds,stops]
//   --in-beam  the loco starts with its nose already in the beam (clear level taken from local/sensor_levels.json)
// Settings: local/config.jsonc, TRAIN_HOST, SENSOR_PORT (see `node config.mjs`)
//
// Start with the loco on the track, facing forward, on the house side of the beam (or anywhere
// clear of it) and the beam reading clear. The sensor Arduino must run the timestamped sketch
// ("reading,microseconds" per line) so passes are timed on the sensor's clock.
//
//   find    step the throttle up until the loco breaks the beam; record its signature
//   length  two laps at 20%: lap period gives the speed (known loop length), pass time gives the length
//   speeds  throttle -> speed table, climbing to a safe limit and descending to the stall point
//   stops   shuttle at the beam: how far the loco carries on after stopping on its nose and its tail
//
// Writes local/loco_profile.json (and local/traces/loco_trace.csv). --resume reloads the profile to run later stages.
//
// The loco only ever slows with a ramp (1 s per 0.1 of throttle) from above creep speed, and only stops abruptly at creep
// speed or below: lib/controller refuses anything else (motor care). Ctrl-C ramps the loco down; a second Ctrl-C stops it at once.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { loadLayout } from "./lib/show/index.mjs";
import { localPath, localFile } from "./lib/paths.mjs";

const layoutFile = localPath("layout.json");
const LOOP_IN = (existsSync(layoutFile) ? loadLayout(layoutFile).loopIn : null) || 134;   // the lap length in inches: local/layout.json, else the 134" measured earlier
const SOLID_FRAC = 0.65;        // a pass that never rises above this fraction of the blocked-to-clear span is a solid loco (no windows)
const SAFE_MAX_IN_S = 9.0;      // never aim above this (the old train ran 8.6 in/s without trouble)
const MAX_THROTTLE = 0.45;
const START_LAG_S = 0.30;       // assumed delay from a speed command to first motion
// Motor care: cutting the throttle to zero, or reversing, at speed is hard on the motor.
const ABRUPT_STOP_MAX_IN_S = 2.5;   // only stop abruptly (speed 0) at or below this; ramp down above it
const MAX_RUN_MS = 25 * 60 * 1000;

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const resume = args.includes("--resume");
const inBeam = args.includes("--in-beam");
const stagesArg = (args.find((a) => a.startsWith("--stages=")) || "").slice(9);
const want = (s) => !stagesArg || stagesArg.split(",").includes(s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t00 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t00) / 1000).toFixed(0).padStart(4)} s] ${msg}`);
class Abort extends Error {}

// ---- sensor ----
const config = loadConfigOrExit(args);
const source = new SerialSource(config.sensor);
const sensor = createSensor({ source, emitSamples: true });
const samples = [];
sensor.on("sample", (x) => samples.push(x));
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();

// Resolves the event, or null if it does not come in `ms` (the stages treat that as "it never happened").
const waitFor = (ev, ms, pred = () => true) => sensor.waitFor(ev, { timeoutMs: ms, filter: pred }).catch((e) => {
  if (/timed out/.test(e.message)) return null;
  throw new Abort(e.message);
});

const profile = resume && existsSync(localPath("loco_profile.json")) ? JSON.parse(readFileSync(localPath("loco_profile.json"), "utf8")) : {};
const save = () => { profile.clearLevel = sensor.clearLevel; writeFileSync(localFile("loco_profile.json"), JSON.stringify(profile, null, 1)); };

async function main() {
  // ---- beam check ----
  if (sensor.state === "init") await waitFor("ready", 4000);
  if (sensor.state === "init" || sensor.state === "lost") throw new Abort(`no readings from the sensor: ${source.lastError ? source.lastError.message : "the port is silent"}`);
  if (inBeam ? sensor.state !== "blocked" : sensor.state !== "clear") throw new Abort(inBeam ? "--in-beam: the nose is not in the beam" : "the beam is not reading clear and steady (is the loco sitting in it? use --in-beam if so)");
  profile.clearLevel = sensor.clearLevel;
  log(inBeam ? `starting in the beam; clear level ${sensor.clearLevel}` : `beam clear at ${sensor.clearLevel}`);
  if (dry) { log("dry run: sensor fine, loco not moved"); return; }

  const ctl = await connectController({ config });
  let finished = false, stopping = false, interrupts = 0;
  const emergency = () => { try { ctl.emergencyStop(); } catch { /* the link is gone: the firmware stops the motor after 30 s */ } };
  const rampDownAndExit = (code) => { stopping = true; ctl.halt().then(() => process.exit(code), () => { emergency(); process.exit(code); }); };
  const refuse = () => { if (stopping) throw new Abort("interrupted"); };
  // An abrupt stop (speed 0) is only allowed by the controller at creep speed or below; ramp() down from anywhere above.
  const halt = () => { refuse(); ctl.setSpeed(0); };
  const setSpeed = (v) => { refuse(); ctl.setSpeed(v); };
  const setDir = async (fwd) => { refuse(); await ctl.setDirection(fwd); };
  const ramp = async (_from, to) => { refuse(); await ctl.rampTo(to); };
  const softStop = async () => { if (ctl.speed > 0) await ctl.halt(); };
  const bail = () => { if (++interrupts === 1) { console.log("\nstopping: ramping the loco down (Ctrl-C again for an emergency stop)"); rampDownAndExit(130); } else { emergency(); process.exit(130); } };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);
  const dog = setInterval(() => {
    if (stopping) return;
    if (ctl.speed > 0 && sensor.state === "lost") { console.error("sensor lost; stopping"); rampDownAndExit(1); }
    if (Date.now() - t00 > MAX_RUN_MS) { console.error("time limit; stopping"); rampDownAndExit(1); }
  }, 250);

  // throttle -> speed (in/s), interpolated or extrapolated from the measured points
  const points = () => (profile.points || []).slice().sort((a, b) => a.thr - b.thr);
  function speedAt(thr) {
    const p = points();
    if (!p.length) return null;
    if (p.length === 1) return p[0].v * thr / p[0].thr;
    let a = p[0], b = p[1];
    for (let i = 0; i < p.length - 1; i++) { a = p[i]; b = p[i + 1]; if (thr <= b.thr) break; }
    return a.v + ((b.v - a.v) / (b.thr - a.thr)) * (thr - a.thr);
  }
  function throttleFor(vTarget) {
    let best = null;
    for (let thr = 0.04; thr <= MAX_THROTTLE; thr += 0.005) {
      const v = speedAt(thr), ok = points().some((p) => Math.abs(p.thr - thr) < 0.2);
      if (v != null && v > 0 && ok && (best == null || Math.abs(v - vTarget) < best.err)) best = { thr: +thr.toFixed(3), err: Math.abs(v - vTarget) };
    }
    return best ? best.thr : 0.15;
  }

  try {
    await setDir(true);

    // ================= stage 1: find =================
    if (want("find")) {
      log("stage 1: find the loco (stepping the throttle up until it breaks the beam)");
      let fell = null, thrAtFall = 0;
      const fallP = waitFor("break", 120000).then((e) => { fell = e; thrAtFall = ctl.speed; });
      let thr = 0.04;
      while (!fell && thr <= 0.30) { setSpeed(thr); await sleep(700); if (!fell) thr = +(thr + 0.01).toFixed(2); }
      if (!fell) { log("holding 30% until it arrives"); setSpeed(0.30); await Promise.race([fallP, sleep(60000)]); }
      if (!fell) throw new Abort("the loco never reached the beam");
      log(`nose broke the beam at ${Math.round(thrAtFall * 100)}% throttle (an upper bound on the start-up throttle)`);

      let pass = null, lastBump = Date.now();
      waitFor("pass", 60000).then((p) => (pass = p));
      const t0 = Date.now();
      while (!pass && Date.now() - t0 < 60000) {
        await sleep(400);
        if (!pass && ctl.speed < 0.30 && Date.now() - lastBump > 5000) { setSpeed(+(ctl.speed + 0.02).toFixed(2)); lastBump = Date.now(); log(`slow in the beam; throttle up to ${Math.round(ctl.speed * 100)}%`); }
      }
      if (!pass) throw new Abort("the tail never cleared the beam");
      const lv = sensor.levels, solid = pass.maxLevel < lv.blocked + SOLID_FRAC * (lv.clear - lv.blocked);
      profile.signature = { solid, minLevel: pass.minLevel, maxInside: pass.maxLevel, meanInside: +pass.meanLevel.toFixed(0),
                            passS: +(pass.durationMs / 1000).toFixed(3), atThrottle: ctl.speed, startUpThrottleUpperBound: thrAtFall };
      log(`pass at ${Math.round(ctl.speed * 100)}%: ${(pass.durationMs / 1000).toFixed(2)} s nose to tail; beam inside ${pass.minLevel} to ${pass.maxLevel} (${solid ? "solid, no windows" : "has gaps or windows"})`);
      save();
    }

    // ================= stage 2: length =================
    if (want("length")) {
      log("stage 2: lap period and loco length at 20%");
      await ramp(ctl.speed || 0.06, 0.20);
      const rampEnd = Date.now(), passes = [];
      for (let k = 0; k < 2; k++) {
        const p = await waitFor("pass", 100000, (e) => e.h0 > rampEnd + 2000);
        if (!p) throw new Abort("no pass at 20%: the loco stalled or derailed");
        passes.push(p);
        log(`lap pass ${k + 1}: ${(p.durationMs / 1000).toFixed(3)} s nose to tail`);
      }
      const T = (passes[1].t0 - passes[0].t0) / 1000;
      const v = LOOP_IN / T;
      const dtS = (passes[0].durationMs + passes[1].durationMs) / 2000;
      const L = v * dtS;
      profile.lapAt20Pct = { periodS: +T.toFixed(3), speedInS: +v.toFixed(2) };
      profile.lengthIn = +L.toFixed(2);
      profile.lengthMm = +(L * 25.4).toFixed(0);
      profile.points = [{ thr: 0.20, v: +v.toFixed(3), dt: +dtS.toFixed(3), via: "lap period" }];
      log(`lap period ${T.toFixed(2)} s -> ${v.toFixed(2)} in/s at 20%; loco length ${L.toFixed(2)}" (${profile.lengthMm} mm)`);
      save();
      if (v > SAFE_MAX_IN_S) { log("already faster than the safe limit at 20%: slowing to 10%"); await ramp(ctl.speed, 0.10); }
    }

    // ================= stage 3: speeds =================
    if (want("speeds")) {
      if (!profile.points || !profile.lengthIn) throw new Abort("stage 3 needs the length from stage 2 (run with --resume)");
      log("stage 3: throttle -> speed table");
      const L = profile.lengthIn;
      async function measureAt(thr) {
        const guess = Math.max(speedAt(thr) || 1, 0.5);
        await ramp(ctl.speed, thr);
        const rampEnd = Date.now();
        const p = await waitFor("pass", ((LOOP_IN / guess) * 2 + 20) * 1000, (e) => e.h0 > rampEnd + 1500);
        if (!p) return null;
        const v = L / (p.durationMs / 1000);
        profile.points.push({ thr, v: +v.toFixed(3), dt: +(p.durationMs / 1000).toFixed(3), via: "pass time" });
        log(`${Math.round(thr * 100)}% throttle: ${(p.durationMs / 1000).toFixed(2)} s past the beam = ${v.toFixed(2)} in/s (${(v * 25.4).toFixed(0)} mm/s, ${(v * 220 * 3600 / 63360).toFixed(0)} mph at 1:220)`);
        save();
        return v;
      }
      for (const thr of [0.25, 0.30, 0.35, 0.40, 0.45]) {
        const pred = speedAt(thr);
        if (pred > SAFE_MAX_IN_S) { log(`stopping the climb: ${Math.round(thr * 100)}% would be about ${pred.toFixed(1)} in/s`); break; }
        if ((await measureAt(thr)) == null) throw new Abort(`no pass at ${Math.round(thr * 100)}%`);
      }
      for (const thr of [0.15, 0.12, 0.10, 0.08, 0.06]) {
        const pred = speedAt(thr);
        if (pred < 0.4) { log(`stopping the descent: ${Math.round(thr * 100)}% is predicted to stall (${pred.toFixed(2)} in/s)`); break; }
        if (LOOP_IN / pred > 90) { log(`stopping the descent: a lap at ${Math.round(thr * 100)}% would take ${(LOOP_IN / pred).toFixed(0)} s`); break; }
        const v = await measureAt(thr);
        if (v == null) { log(`no pass at ${Math.round(thr * 100)}%: it stalled; backing up to 20%`); profile.stallAtThrottle = thr; await ramp(ctl.speed, 0.20); break; }
      }
      // linear fit over the points at 15% and above
      const fit = points().filter((p) => p.thr >= 0.15);
      if (fit.length >= 2) {
        const n = fit.length, sx = fit.reduce((a, p) => a + p.thr, 0), sy = fit.reduce((a, p) => a + p.v, 0);
        const sxx = fit.reduce((a, p) => a + p.thr * p.thr, 0), sxy = fit.reduce((a, p) => a + p.thr * p.v, 0);
        const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
        profile.fit = { inPerSecPerUnitThrottle: +b.toFixed(2), offsetInS: +a.toFixed(2), zeroCrossingThrottle: +(-a / b).toFixed(3) };
        log(`fit (15% and up): v = ${a.toFixed(2)} + ${b.toFixed(2)} x throttle; extrapolates to zero at ${(100 * -a / b).toFixed(1)}%`);
      }
      save();
      await ramp(ctl.speed, 0.20);
    }

    // ================= stage 4: stops =================
    if (want("stops")) {
      if (!profile.points || profile.points.length < 2) throw new Abort("stage 4 needs the speed table (run stage 3 first)");
      log("stage 4: how the loco stops, shuttling at the beam");
      const capThr = (t) => Math.min(t, ctl.config.creepMax);   // abrupt stops are only allowed at creep speed or below
      const posThr = capThr(throttleFor(ABRUPT_STOP_MAX_IN_S - 0.1));
      const slow = points().filter((p) => p.v >= 0.8)[0];
      const testThrs = [...new Set([slow ? slow.thr : 0.08, throttleFor(2.0), throttleFor(ABRUPT_STOP_MAX_IN_S - 0.1)].map(capThr))].sort((a, b) => a - b);
      if (testThrs.some((t) => speedAt(t) > ABRUPT_STOP_MAX_IN_S + 0.2)) throw new Abort("a test throttle is above the abrupt-stop speed limit");
      log(`positioning at ${Math.round(posThr * 100)}%; testing stops at ${testThrs.map((t) => Math.round(t * 100) + "%").join(", ")}`);

      // get just past the beam, stop, then back in behind it
      log("lining up: waiting for a pass, then backing in behind the beam");
      await ramp(ctl.speed, 0.20);
      if (!(await waitFor("pass", 100000))) throw new Abort("no pass while lining up");
      await softStop(); await sleep(1500);
      async function backBehind() {
        await setDir(false); setSpeed(posThr);
        if (!(await waitFor("break", 40000))) { halt(); throw new Abort("never found the loco's tail backing up"); }
        if (!(await waitFor("restore", 40000))) { halt(); throw new Abort("the loco never backed out of the beam"); }
        await sleep(1500); halt(); await sleep(800);
      }
      async function returnBehind() {
        await setDir(false); setSpeed(posThr);
        if (!(await waitFor("restore", 40000))) { halt(); throw new Abort("never backed out of the beam"); }
        await sleep(1500); halt(); await sleep(800);
      }
      async function trialNose(thr) {
        await setDir(true);
        const tCmd = Date.now(); setSpeed(thr);
        const f = await waitFor("break", 25000); halt();
        if (!f) throw new Abort("the nose never reached the beam");
        const latencyMs = Date.now() - f.h;
        await sleep(1500);
        await setDir(false);
        const tRev = Date.now(); setSpeed(thr);
        const r = await waitFor("restore", 25000); halt();
        if (!r) throw new Abort("the loco never backed off the beam");
        const backS = (r.h - tRev) / 1000;
        return { approachS: +((f.h - tCmd) / 1000).toFixed(2), latencyMs, backS: +backS.toFixed(2), overshootIn: +Math.max(0, speedAt(thr) * (backS - START_LAG_S)).toFixed(2) };
      }
      async function trialTail(thr) {
        await setDir(true);
        setSpeed(thr);
        const f = await waitFor("break", 25000);
        if (!f) { halt(); throw new Abort("the nose never reached the beam (tail trial)"); }
        const r = await waitFor("restore", 40000); halt();
        if (!r) throw new Abort("the tail never cleared the beam");
        const latencyMs = Date.now() - r.h;
        await sleep(1500);
        await setDir(false);
        const tRev = Date.now(); setSpeed(thr);
        const f2 = await waitFor("break", 25000); halt();
        if (!f2) throw new Abort("the tail never came back to the beam");
        const backS = (f2.h - tRev) / 1000;
        return { passS: +((r.h - f.h) / 1000).toFixed(2), latencyMs, backS: +backS.toFixed(2), overshootIn: +Math.max(0, speedAt(thr) * (backS - START_LAG_S)).toFixed(2) };
      }

      await backBehind();
      profile.stops = [];
      for (const thr of testThrs) {
        const rows = [];
        for (let n = 1; n <= 3; n++) {
          const nose = await trialNose(thr);
          const tail = await trialTail(thr);
          await returnBehind();
          rows.push({ nose, tail });
          log(`${Math.round(thr * 100)}% (${speedAt(thr).toFixed(2)} in/s) trial ${n}: carried on ${nose.overshootIn}" past the beam after the nose edge, ${tail.overshootIn}" after the tail edge`);
        }
        profile.stops.push({ thr, inPerS: +speedAt(thr).toFixed(2), rows });
        save();
      }
      // finish parked on the nose at the slowest tested throttle
      const parkThr = testThrs[0];
      const fin = await trialNose(parkThr);
      log(`finished parked on its nose at ${Math.round(parkThr * 100)}% (carried on ${fin.overshootIn}" past the beam edge, then backed to it)`);
    }

    finished = true;
    save();
  } finally {
    clearInterval(dog);
    try { if (ctl.speed > 0) await ctl.halt(); } catch { emergency(); }   // finished or not: ramp down, never cut at speed
    try { if (ctl.speed === 0 && ctl.connected) await ctl.setDirection(true); } catch { /* leave the direction as it is */ }
    writeFileSync(localFile("traces", "loco_trace.csv"), samples.map((x) => `${(x.t / 1000).toFixed(3)},${x.v}`).join("\n"));
    await ctl.close();
  }
}

main().catch((e) => { console.error(e instanceof Abort ? `stopped: ${e.message}` : `error: ${e.message}`); process.exitCode = 1; }).finally(() => { sensor.stop(); process.exit(); });
