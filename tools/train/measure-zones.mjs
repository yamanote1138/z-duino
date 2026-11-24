#!/usr/bin/env node
// Measure the zones in your layout by hand: the loco creeps one lap and you press a key as the nose reaches each mark.
//
//   node measure-zones.mjs                 run it in your own terminal (it needs your keystrokes)
//   node measure-zones.mjs --save          also write the result into local/layout.json
// Options: --speed=0.08 (creep only, up to 0.10)   --lag-ms=0 (your reaction time, taken off every mark)
//          --marks=slight-right.from,slight-right.to,...   (default: the start and end of all four bends, in track order:
//            slight-right, slight-left, turn-left, turn-right; any zone name works, a new one is created when you --save)
//
// Start with the nose on the mark (beam blocked). The loco moves forward at creep speed and stops by itself when the nose
// returns to the beam. Any key = a mark; q or Ctrl-C = stop the loco now.
// Inches come from the lap time: the beam events at the start and the end of the lap fix the average speed (the layout's
// loopIn is the lap length), so the speed model is not involved. If loopIn is wrong, every inch here scales with it.

import { readFileSync, writeFileSync } from "node:fs";
import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { loadLayout, validateLayout } from "./lib/show/index.mjs";
import { localPath } from "./lib/paths.mjs";
import { loadLoco, speedModel } from "./lib/show/index.mjs";
import { existsSync } from "node:fs";

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const speed = Number(flags.speed ?? 0.08), lagMs = Number(flags["lag-ms"] ?? 0);
const DEFAULT_MARKS = ["slight-right.from", "slight-right.to=slight-left.from", "slight-left.to", "turn-left.from", "turn-left.to", "turn-right.from", "turn-right.to"].join(",");
const names = (m) => m.split("=");   // "a.to=b.from": one press that counts for both edges (a curve that turns straight into the opposite curve: the point of reverse curvature)
const marks = String(flags.marks || DEFAULT_MARKS).split(",");
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
if (!(speed > 0 && speed <= 0.1)) fail("--speed must be above 0 and at most 0.10 (creep speed)");
if (!process.stdin.isTTY && !flags.preview) fail("run this in a terminal: it reads your key presses");

const layoutFile = localPath("layout.json");
const layout = loadLayout(layoutFile);
const problems = validateLayout(layout);
if (problems.length) fail(`layout:\n  ${problems.join("\n  ")}`);
if (!layout.loopIn) fail("the layout needs loopIn (the lap length in inches)");
for (const m of marks.flatMap(names)) { const [z, e] = m.split("."); if (!z || !["from", "to"].includes(e)) fail(`bad mark "${m}" (use zone.from or zone.to; an unknown zone name makes a new zone when you --save; existing: ${Object.keys(layout.zones).join(", ")})`); }
const loco = existsSync(localPath("loco_profile.json")) ? loadLoco() : { fit: { inPerSecPerUnitThrottle: 28.65, offsetInS: 0 } };
const WORDS = { from: "START", to: "END" };
// What to look for, in plain words. "Nose" = the front of the loco.
const describe = (m) => {
  if (m.includes("=")) { const [a, b] = names(m).map((n) => n.split(".")[0]); return `the NOSE is at the point of reverse curvature: where ${a} turns into ${b} (the curve stops bending one way and starts bending the other). ONE press for both`; }
  const [z, e] = m.split("."); const h = layout.hints && layout.hints[z] ? ` (${layout.hints[z]})` : ""; return e === "from" ? `the NOSE reaches the START of ${z}: where the straight ends and it begins${h}` : `the NOSE leaves ${z}: where it is straight again${h}`; };

const printBanner = () => console.log(`
==================== measuring ${[...new Set(marks.flatMap(names).map((m) => m.split(".")[0]))].join(", ")} ====================
The loco will creep forward at ${speed} for one lap (about ${Math.round(layout.loopIn / (speedModel(loco)(speed) || 1.8))} s) and stop by itself when the nose is back at the beam.
You press ANY KEY at each of these moments, in this order ("nose" = the front of the loco):
${marks.map((m, i) => `   ${i + 1}. ${describe(m)}`).join("\n")}
Each numbered line above is ONE key press: 7 in all. (Where one bend flows straight into the next, that is a single press for both.)
After the last one there is nothing more to do. q or Ctrl-C stops the loco at once.
Every few seconds I print a rough position, so you know when a mark is coming.
=====================================================================
`);
printBanner();
if (flags.preview) process.exit(0);
const config = loadConfigOrExit();
const source = new SerialSource(config.sensor);
const sensor = createSensor({ source });
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();
await new Promise((r) => setTimeout(r, 1200));
if (sensor.state !== "blocked") { sensor.stop(); fail(`the beam is ${sensor.state} (reading ${sensor.lastReading ?? "?"}): put the nose on the mark first`); }
const ctl = await connectController({ config });
sensor.setDirection("forward");

let tStart = null;
const send = ctl.send.bind(ctl);
ctl.send = (o) => { if (o.cmd === "speed" && o.value > 0 && tStart === null) tStart = Date.now(); return send(o); };

const taps = [];
let aborted = false, go = false, release;
const started = new Promise((r) => { release = r; });
const lost = new Promise((res) => sensor.on("lost", res));
const stopNow = () => { aborted = true; try { ctl.setSpeed(0); } catch { /* already stopped */ } };
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on("data", (b) => {
  const k = b.toString();
  if (k === "\x03" || k === "q") {
    if (!go) { process.stdin.setRawMode(false); console.log("\nNot started: nothing moved."); process.exit(0); }
    stopNow(); return;
  }
  if (!go) { if (k === " ") { go = true; release(); } else console.log("  (press SPACE to start, or q to quit: nothing moves until then)"); return; }
  if (tStart === null || taps.length >= marks.length) return;
  taps.push(Date.now());
  const done = marks[taps.length - 1], next = marks[taps.length];
  console.log(`  ✔ mark ${taps.length} of ${marks.length} taken: ${label(done)}`);
  if (next) console.log(`\n  NEXT (${taps.length + 1} of ${marks.length}): press a key when ${describe(next)}\n`);
  else console.log(`\n  That was the last mark. Nothing more to press: the loco will finish the lap and stop at the beam by itself.\n`);
});
const label = (m) => names(m).map((n) => { const [z, e] = n.split("."); return `${z} ${WORDS[e]}`; }).join(" / ");

console.log(`The beam is blocked, so the nose is on the mark. Read the list above.\n>>> Press SPACE when you are ready to start the loco (q to quit). Nothing moves until you do. <<<`);
await started;
sensor.setDirection("forward");
if (sensor.state !== "blocked") { console.log(`\nThe beam is ${sensor.state} now, so the loco is not on the mark. Nothing moved; run it again.`); process.stdin.setRawMode(false); await ctl.close(); sensor.stop(); process.exit(1); }
console.log(`\nGO: the loco is moving. Watch the nose.\n\nNEXT (1 of ${marks.length}): press a key when ${describe(marks[0])}\n`);
const ticker = setInterval(() => { if (tStart !== null) console.log(`     ... about ${Math.round(speedModel(loco)(speed) * (Date.now() - tStart) / 1000)} in past the beam (rough estimate)`); }, 5000);

let tRestore = null, tBreak = null, error = null;
try {
  const r = await ctl.guardedMove({
    forward: true, speed, maxMs: Math.ceil((layout.loopIn / 1.2) * 1000) + 20000, abort: lost,
    until: async () => {
      await Promise.race([sensor.waitFor("restore", { timeoutMs: 20000 }).then(() => { tRestore = Date.now(); }), new Promise((_, rej) => { const t = setInterval(() => { if (aborted) { clearInterval(t); rej(new Error("stopped by you")); } }, 50); })]);
      const brk = sensor.waitFor("break", { timeoutMs: Math.ceil((layout.loopIn / 1.2) * 1000) + 10000 });
      await Promise.race([brk, new Promise((_, rej) => { const t = setInterval(() => { if (aborted) { clearInterval(t); rej(new Error("stopped by you")); } }, 50); })]);
      tBreak = Date.now();
    },
  });
  if (r.result !== "guard") error = `the lap ended without the nose returning to the beam (${r.result})`;
} catch (e) { error = e.message; }
try { ctl.setSpeed(0); ctl.ledAuto(); } catch { /* disconnected */ }
clearInterval(ticker);
process.stdin.setRawMode(false); process.stdin.pause();
console.log("\n=== lap finished: working out the numbers ===");

if (error || aborted) console.log(`\nNO RESULT: ${error || "stopped by you"}. Nothing was saved; the loco is stopped. Put the nose on the beam and run it again.`);
else if (taps.length < marks.length) console.log(`\nNO RESULT: only ${taps.length} of ${marks.length} marks were taken. Nothing was saved. Put the nose on the beam and run it again.`);
else {
  const lapS = (tBreak - tStart) / 1000, v = layout.loopIn / lapS;
  console.log(`\nlap: ${lapS.toFixed(1)} s for ${layout.loopIn} in = ${v.toFixed(2)} in/s on average (the speed model says ${speed === 0.08 ? "1.81" : "?"} at 0.08)`);
  if (tRestore) console.log(`tail left the beam ${((tRestore - tStart) / 1000).toFixed(2)} s after the start (the loco is 3 in long: ${(v * (tRestore - tStart) / 1000).toFixed(1)} in at that average speed)`);
  const found = {};
  marks.forEach((m, i) => {
    const inches = Math.max(0, v * ((taps[i] - lagMs - tStart) / 1000));
    for (const n of names(m)) found[n] = Math.round(inches * 2) / 2;   // half an inch: finer than a keypress
    console.log(`  ${label(m).padEnd(40)} ${inches.toFixed(1)} in  ->  ${Math.round(inches * 2) / 2} in`);
  });
  if (flags.save) {
    const file = JSON.parse(readFileSync(layoutFile, "utf8"));
    for (const [m, x] of Object.entries(found)) { const [z, e] = m.split("."); (file.zones[z] ??= {})[e === "from" ? "fromIn" : "toIn"] = x; }
    for (const z of new Set(Object.keys(found).map((m) => m.split(".")[0]))) {
      const zz = file.zones[z];
      if (!(zz.toIn > zz.fromIn)) { console.log(`not saved: zone ${z} would end before it starts (${zz.fromIn} to ${zz.toIn}); mark it again`); process.exit(1); }
      zz.note = `measured by hand ${new Date().toISOString().slice(0, 10)} (${Object.keys(found).filter((m) => m.startsWith(z + ".")).join(", ")}); other edges are estimates`;
    }
    const problems2 = validateLayout(file);
    if (problems2.length) { console.log(`not saved:\n  ${problems2.join("\n  ")}`); process.exit(1); }
    writeFileSync(layoutFile, JSON.stringify(file, null, 2) + "\n");
    console.log(`\nSAVED to ${layoutFile}. Nothing more to do here: tell Claude it is done.`);
  } else console.log("\nNOT SAVED. If these look right, run it again with --save (or tell Claude the numbers).");
}
await ctl.close(); sensor.stop();
process.exit(0);
