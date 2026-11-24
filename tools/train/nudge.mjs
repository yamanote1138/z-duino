#!/usr/bin/env node
// Move the loco a little by hand, or put it back on the mark. Creep speed only, and every move is guarded by the beam.
//
//   node nudge.mjs fwd <seconds>     creep forward for up to <seconds> (at most 6), stopping early at any beam event
//   node nudge.mjs back <seconds>    the same, in reverse
//   node nudge.mjs to-mark           from anywhere clear of the beam: back over the beam, then forward until the nose
//                                    breaks it again (the mark). Gives up after --max=<seconds> (default 75: a lap at creep)
//   node nudge.mjs to-mark --dry     only check the beam, move nothing
//
// A move that ends on a beam event is the point: you cannot nudge the loco past the sensor without it stopping there.
// Settings (controller address, sensor port) come from local/config.jsonc, env and flags (see `node config.mjs`).
// The loco goes at creep speed (0.10) with a beam or time limit, so a stop here is never abrupt.

import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const flag = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const dry = argv.includes("--dry");
const CREEP = 0.1, MAX_NUDGE_S = 6;
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
const usage = () => fail("usage: node nudge.mjs fwd <seconds> | back <seconds> | to-mark [--max=75] [--dry]");

const [mode, secArg] = pos;
if (!["fwd", "back", "to-mark"].includes(mode)) usage();
let seconds = null;
if (mode !== "to-mark") {
  seconds = Number(secArg);
  if (!(seconds > 0)) usage();
  if (seconds > MAX_NUDGE_S) fail(`at most ${MAX_NUDGE_S} s per nudge (about ${Math.round(MAX_NUDGE_S * 2.35)} in at creep): nudge again if you need more`);
}
const maxS = Number(flag("max", 75));
if (!(maxS > 0)) fail("--max must be a number of seconds");

const config = loadConfigOrExit(argv);
const source = new SerialSource(config.sensor);
const sensor = createSensor({ source });
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();
await new Promise((r) => setTimeout(r, 1200));
if (sensor.lastReading == null) fail(`no readings: ${source.lastError ? source.lastError.message : "the port is silent"}`);
const where = () => `beam ${sensor.state}, reading ${sensor.lastReading}`;
console.log(`start: ${where()}`);

if (mode === "to-mark" && sensor.state !== "clear") { sensor.stop(); fail(sensor.state === "blocked" ? "the beam is already blocked: the loco is on the beam (use fwd/back to move it)" : `the beam is ${sensor.state}`); }
if (dry) { console.log("dry run: nothing moved"); sensor.stop(); process.exit(0); }

const ctl = await connectController({ config });
process.on("SIGINT", () => { ctl.emergencyStop(); process.exit(130); });
const lost = new Promise((res) => sensor.on("lost", res));
const never = () => new Promise(() => {});
let code = 0;
try {
  if (mode === "to-mark") {
    sensor.setDirection("reverse");
    console.log("reversing at creep until the loco has passed back over the beam...");
    let r = await ctl.guardedMove({
      forward: false, speed: CREEP, maxMs: Math.round(maxS * 1000), afterMs: 450, abort: lost,
      until: async () => { await sensor.waitFor("break", { timeoutMs: maxS * 1000 }); await sensor.waitFor("restore", { timeoutMs: 15000 }); },
    });
    if (r.result !== "guard") throw new Error(`stopped without passing over the beam (${r.result}); the loco is stopped, nothing more was tried`);
    await new Promise((res) => setTimeout(res, 800));
    if (sensor.state !== "clear") throw new Error(`the beam is ${sensor.state} after reversing; stopping here`);
    sensor.setDirection("forward");
    r = await ctl.guardedMove({ forward: true, speed: CREEP, maxMs: 8000, abort: lost, until: () => sensor.waitFor("break", { timeoutMs: 9000 }) });
    if (r.result !== "guard") throw new Error(`did not reach the mark (${r.result})`);
    await new Promise((res) => setTimeout(res, 600));
    console.log(`on the mark: ${where()}`);
  } else {
    const forward = mode === "fwd";
    sensor.setDirection(forward ? "forward" : "reverse");
    const anyEdge = Promise.race([sensor.waitFor("break", { timeoutMs: seconds * 1000 + 1000 }), sensor.waitFor("restore", { timeoutMs: seconds * 1000 + 1000 })]).catch(never);
    const r = await ctl.guardedMove({ forward, speed: CREEP, maxMs: Math.round(seconds * 1000), until: anyEdge, abort: lost });
    await new Promise((res) => setTimeout(res, 600));
    console.log(`${r.result === "guard" ? "stopped at a beam event" : r.result === "timeout" ? "time up" : r.result} after ${(r.elapsedMs / 1000).toFixed(1)} s; ${where()}`);
  }
} catch (e) { console.error(`error: ${e.message}`); code = 1; }
try { ctl.setSpeed(0); } catch { /* already stopped */ }
await ctl.close(); sensor.stop();
process.exit(code);
