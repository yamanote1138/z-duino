#!/usr/bin/env node
// Move the loco a little by hand, or put it back on the mark. Creep speed only, and every move is guarded by the beam.
//
//   node nudge.mjs fwd <seconds>     creep forward for up to <seconds> (at most 6), stopping early at any beam event
//   node nudge.mjs back <seconds>    the same, in reverse
//   node nudge.mjs to-mark           put the loco back on the mark, from wherever it is (the nose just breaking the beam):
//                                      beam blocked: back off and come forward onto the edge (works nose-in or tail-in)
//                                      beam clear:   just short? creep forward a few seconds. just past? back over the beam and
//                                                    forward onto it. neither? creep round the loop until the beam breaks
//                                    Options: --near=5 (seconds to look nearby before the loop), --dry (only check the beam),
//                                    --direction=reverse (the mark for a reverse run: the tail just breaking the beam)
//
// A move that ends on a beam event is the point: you cannot nudge the loco past the sensor without it stopping there.
// Settings (controller address, sensor port) come from local/config.jsonc, env and flags (see `node config.mjs`).
// The loco goes at creep speed (0.10) with a beam or time limit, so a stop here is never abrupt.

import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { returnToMark } from "./lib/track/index.mjs";
import { loadLayout, loadLoco, speedModel } from "./lib/show/index.mjs";
import { localPath } from "./lib/paths.mjs";
import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const flag = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const dry = argv.includes("--dry");
const CREEP = 0.1, MAX_NUDGE_S = 6;
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
const usage = () => fail("usage: node nudge.mjs fwd <seconds> | back <seconds> | to-mark [--near=5] [--direction=forward|reverse] [--dry]");

const [mode, secArg] = pos;
if (!["fwd", "back", "to-mark"].includes(mode)) usage();
let seconds = null;
if (mode !== "to-mark") {
  seconds = Number(secArg);
  if (!(seconds > 0)) usage();
  if (seconds > MAX_NUDGE_S) fail(`at most ${MAX_NUDGE_S} s per nudge (about ${Math.round(MAX_NUDGE_S * 2.35)} in at creep): nudge again if you need more`);
}
const nearS = Number(flag("near", 5));
if (!(nearS > 0)) fail("--near must be a number of seconds");
const direction = flag("direction", "forward");
if (direction !== "forward" && direction !== "reverse") fail(`--direction must be forward or reverse, not "${direction}"`);

const config = loadConfigOrExit(argv);
const source = new SerialSource(config.sensor);
const sensor = createSensor({ source });
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();
await new Promise((r) => setTimeout(r, 1200));
if (sensor.lastReading == null) fail(`no readings: ${source.lastError ? source.lastError.message : "the port is silent"}`);
const where = () => `beam ${sensor.state}, reading ${sensor.lastReading}`;
console.log(`start: ${where()}`);

if (dry) { console.log("dry run: nothing moved"); sensor.stop(); process.exit(0); }

const ctl = await connectController({ config });
process.on("SIGINT", () => { ctl.emergencyStop(); process.exit(130); });
const lost = new Promise((res) => sensor.on("lost", res));
const never = () => new Promise(() => {});
let code = 0;
try {
  if (mode === "to-mark") {
    const layoutFile = localPath("layout.json"), locoFile = localPath("loco_profile.json");
    const loopIn = existsSync(layoutFile) ? loadLayout(layoutFile).loopIn : undefined;
    const creepInS = existsSync(locoFile) ? speedModel(loadLoco(locoFile))(CREEP) || undefined : undefined;
    const ac = new AbortController(); process.removeAllListeners("SIGINT");
    let hits = 0; process.on("SIGINT", () => { if (++hits === 1) { console.log("\nstopping"); ac.abort(); } else { ctl.emergencyStop(); process.exit(130); } });
    const r = await returnToMark({ controller: ctl, sensor, signal: ac.signal, nearS, loopIn, creepInS, end: direction === "reverse" ? "tail" : "nose", onLog: (e) => console.log(`  ${(e.t / 1000).toFixed(1).padStart(5)} s  ${e.text}`) });
    await new Promise((res) => setTimeout(res, 500));
    if (!r.ok) throw new Error(r.error || "could not find the mark");
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
