import test from "node:test";
import assert from "node:assert/strict";
import { Detector } from "../lib/sensor/detector.mjs";
import { createSensor, ReplaySource } from "../lib/sensor/index.mjs";
import { deriveLevels, summarize } from "../lib/sensor/calibration.mjs";

const LEVELS = { clear: 340, blocked: 30 };
// 20 ms samples: build a list of { t, v } from [value, count] runs, with a little deterministic noise
function trace(runs, noise = 2) {
  const out = []; let t = 0, k = 0;
  for (const [v, n] of runs) for (let i = 0; i < n; i++) { out.push({ t, h: t, v: v + ((k++ * 7) % (2 * noise + 1)) - noise }); t += 20; }
  return out;
}
function run(samples, setup = () => {}) {
  const d = new Detector({ levels: LEVELS }), ev = [];
  for (const e of ["ready", "break", "restore", "nose", "tail", "pass", "drift"]) d.on(e, (x) => ev.push([e, x]));
  setup(d);
  for (const s of samples) d.push(s);
  return { d, ev, names: ev.map((e) => e[0]) };
}

test("a clean crossing gives break, restore and one pass of the right length", () => {
  const { names, ev } = run(trace([[340, 60], [30, 64], [340, 60]]));
  assert.deepEqual(names, ["ready", "break", "restore", "pass"]);
  const pass = ev.find((e) => e[0] === "pass")[1];
  assert.ok(Math.abs(pass.durationMs - 64 * 20) < 60, `duration ${pass.durationMs}`);
  assert.ok(pass.minLevel < 40);
  // a solid object stays low all the way through; the host-clock edges bracket the pass
  assert.ok(pass.maxLevel < 60, `maxLevel ${pass.maxLevel}`);
  assert.ok(pass.h1 - pass.h0 > 0 && Number.isFinite(pass.h0), `h0 ${pass.h0} h1 ${pass.h1}`);
});

test("a pass with gaps (windows) reports a high maxLevel", () => {
  const { ev } = run(trace([[340, 60], [30, 20], [260, 4], [30, 20], [340, 60]]));
  const pass = ev.find((e) => e[0] === "pass")[1];
  assert.ok(pass.maxLevel > 200, `maxLevel ${pass.maxLevel}`);
});

test("one stray low reading is ignored", () => {
  const { names } = run(trace([[340, 40], [30, 1], [340, 40]]));
  assert.deepEqual(names, ["ready"]);
});

test("noise around the clear level does not chatter", () => {
  const { names } = run(trace([[340, 300]], 8));
  assert.deepEqual(names, ["ready"]);
});

test("direction labels the edges: forward = nose first, reverse = tail first", () => {
  let r = run(trace([[340, 30], [30, 40], [340, 30]]), (d) => d.setDirection("forward"));
  assert.deepEqual(r.names.filter((n) => n === "nose" || n === "tail"), ["nose", "tail"]);
  r = run(trace([[340, 30], [30, 40], [340, 30]]), (d) => d.setDirection("reverse"));
  assert.deepEqual(r.names.filter((n) => n === "nose" || n === "tail"), ["tail", "nose"]);
  r = run(trace([[340, 30], [30, 40], [340, 30]]));
  assert.equal(r.names.filter((n) => n === "nose" || n === "tail").length, 0);
});

test("starting inside the beam (the mark) gives a restore but no pass", () => {
  const { names, ev } = run(trace([[30, 40], [340, 40]]));
  assert.equal(ev[0][1].state, "blocked");
  assert.deepEqual(names, ["ready", "restore"]);
});

test("a clear level that sags a little reports drift once", () => {
  const { ev } = run(trace([[340, 20], [260, 400]]));   // 260: below calibration by 24% but still above the break level
  const drift = ev.filter((e) => e[0] === "drift");
  assert.equal(drift.length, 1);
  assert.equal(drift[0][1].kind, "low");
});

test("a steady half-blocked beam (the 187 episode) reports partial once, and a parked loco does not", () => {
  const half = run(trace([[340, 20], [190, 400]]));
  const d = half.ev.filter((e) => e[0] === "drift");
  assert.equal(d.length, 1);
  assert.equal(d[0][1].kind, "partial");
  const parked = run(trace([[340, 20], [30, 400]]));
  assert.equal(parked.ev.filter((e) => e[0] === "drift").length, 0);
});

test("a shallow partial block (a wobble) does not break the beam", () => {
  const { names } = run(trace([[340, 30], [290, 30], [340, 30]]));
  assert.deepEqual(names, ["ready"]);
});

test("bad levels are rejected", () => {
  assert.throws(() => new Detector({ levels: { clear: 30, blocked: 340 } }));
});

test("the sensor replays a crossing and waitFor resolves with the pass", async () => {
  const sensor = createSensor({ source: new ReplaySource({ samples: trace([[340, 60], [30, 64], [340, 60]]) }), levels: LEVELS });
  await sensor.start();
  const pass = await sensor.waitFor("pass", { timeoutMs: 3000 });
  assert.ok(pass.durationMs > 1000 && pass.durationMs < 1500);
  sensor.stop();
});

test("waitFor times out", async () => {
  const sensor = createSensor({ source: new ReplaySource({ samples: trace([[340, 10]]) }), levels: LEVELS });
  await sensor.start();
  await assert.rejects(sensor.waitFor("pass", { timeoutMs: 100 }), /timed out/);
  sensor.stop();
});

test("lost fires when readings stop, recovered when they resume", async () => {
  const src = { start(cb) { this.cb = cb; }, stop() {} };
  const sensor = createSensor({ source: src, levels: LEVELS, config: { staleMs: 100 } });
  const seen = []; sensor.on("lost", () => seen.push("lost")); sensor.on("recovered", () => seen.push("recovered"));
  await sensor.start();
  src.cb({ t: 0, h: Date.now(), v: 340 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sensor.state, "lost");
  src.cb({ t: 400, h: Date.now(), v: 340 });
  assert.deepEqual(seen, ["lost", "recovered"]);
  sensor.stop();
});

test("calibration: levels from two measurements, and a bad pair is refused", () => {
  const clear = summarize(Array(50).fill(340)), blocked = summarize(Array(50).fill(30));
  const { levels, warnings } = deriveLevels(clear, blocked);
  assert.equal(levels.clear, 340); assert.equal(levels.blocked, 30); assert.deepEqual(warnings, []);
  assert.throws(() => deriveLevels(summarize([100, 100, 100]), summarize([90, 90, 90])), /only 10 counts apart/);
  const noisy = deriveLevels(summarize([340, 300, 380, 340, 330, 350]), blocked);
  assert.ok(noisy.warnings.length > 0);
});

test("sensor.calibrate measures and applies new levels", async () => {
  const phases = [[340, 200], [30, 400]];
  const samples = []; let t = 0;
  for (const [v, n] of phases) for (let i = 0; i < n; i++) { samples.push({ t, v }); t += 20; }
  const sensor = createSensor({ source: new ReplaySource({ samples, realtime: true, speed: 20 }), levels: { clear: 300, blocked: 10 } });
  await sensor.start();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = await sensor.calibrate({ ms: 150, settleMs: 20, save: false, clearStep: async () => {}, blockedStep: async () => wait(60) });
  assert.equal(r.levels.clear, 340); assert.equal(r.levels.blocked, 30);
  assert.equal(sensor.levels.clear, 340);
  sensor.stop();
});

test("lightStats: clear noise, blocked level, swing and pass-time spread from synthetic crossings", async () => {
  const { lightStats } = await import("../lib/sensor/lighttest.mjs");
  const samples = [], passes = [];
  // 3 passes of 1.0, 1.1 and 1.0 s, 2 s apart, clear = 320 +/- 1, blocked = 30
  let t = 0;
  for (const dur of [1000, 1100, 1000]) {
    for (let k = 0; k < 100; k++, t += 20) samples.push({ t, v: 320 + (k % 2) });     // 2 s clear
    const t0 = t, t1 = t + dur; passes.push({ t0, t1 });
    for (; t < t1; t += 20) samples.push({ t, v: 30 });
  }
  for (let k = 0; k < 100; k++, t += 20) samples.push({ t, v: 320 + (k % 2) });
  const s = lightStats({ samples, passes, startT: -1000, clearMin: 250 });
  assert.equal(s.passes, 3); assert.equal(s.blockedMean, 30);
  assert.ok(Math.abs(s.clearMean - 320.5) < 0.1, String(s.clearMean)); assert.equal(s.clearMin, 320); assert.equal(s.clearMax, 321);
  assert.ok(Math.abs(s.swing - 290.5) < 0.1);
  assert.ok(Math.abs(s.passMeanS - 1.033) < 0.001); assert.ok(s.passSdMs > 40 && s.passSdMs < 55, String(s.passSdMs));
  assert.equal(s.fwdMeanS, 1.0); assert.equal(s.revMeanS, 1.1);
  assert.throws(() => lightStats({ samples, passes: [], clearMin: 250 }), /no passes/);
});
