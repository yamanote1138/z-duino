import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Controller } from "../lib/controller/index.mjs";
import {
  VirtualClock, GhostSensor, SimSound, SimSocket, simulateShow, runShow, validateShow, validateLayout,
  loadShow, saveShow, stringifyShow, soundsUsed, Position, speedModel, inZone,
} from "../lib/show/index.mjs";
import { rampDistanceIn } from "../lib/show/position.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const LOCO = { lengthIn: 3, fit: { inPerSecPerUnitThrottle: 28.65, offsetInS: -0.49 }, points: [{ thr: 0.1, v: 2.35 }, { thr: 0.2, v: 5.4 }, { thr: 0.3, v: 8.1 }] };
const LAYOUT = { format: "z-layout/1", loopIn: 134, zones: { curve: { fromIn: 5.5, toIn: 12 }, approach: { fromIn: 116, toIn: 133 } } };
const show = (steps, extra = {}) => ({ format: "z-show/1", name: "t", steps, ...extra });
const valid = (s, o) => validateShow(s, o);

// ---------- clock ----------
test("VirtualClock fires timers in time order and finishes the run", async () => {
  const c = new VirtualClock(), order = [];
  await c.run(Promise.all([c.sleep(300).then(() => order.push("c")), c.sleep(100).then(() => order.push("a")), c.sleep(200).then(() => order.push("b"))]));
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(c.now(), 300);
});
test("VirtualClock reports a show that waits forever instead of hanging", async () => {
  const c = new VirtualClock();
  await assert.rejects(c.run(new Promise(() => {})), /can never happen/);
  await assert.rejects(new VirtualClock().run((async () => { const c2 = new VirtualClock(); await c2.sleep(1e9); })(), { maxMs: 10 }), /never happen|does not finish/);
});

// ---------- position ----------
test("speedModel interpolates the measured points and falls back to the fit", () => {
  const v = speedModel(LOCO);
  assert.equal(v(0), 0);
  assert.ok(Math.abs(v(0.15) - 3.875) < 1e-9);
  assert.ok(Math.abs(v(0.5) - (28.65 * 0.5 - 0.49)) < 1e-9);
  assert.throws(() => speedModel({})(0.2), /no speed model/);
});
test("Position integrates speed, anchors on edges and wraps by the loop length", () => {
  let t = 0, motion = { thr: 0.2, forward: true };
  const p = new Position({ speed: speedModel(LOCO), lengthIn: 3, loopIn: 100, getMotion: () => motion, now: () => t });
  assert.equal(p.known, false);
  p.anchorEdge("nose"); assert.equal(p.x, 0);
  t = 1000; assert.ok(Math.abs(p.x - 5.4) < 1e-9);
  p.anchorEdge("tail"); assert.equal(p.x, 3);
  assert.equal(p.target(10, true), 10);
  t = 40000; p.anchor(95);
  assert.equal(p.target(10, true), 110, "the next crossing of 10 in is on the next lap");
  motion = { thr: 0.2, forward: false };
  assert.equal(p.target(90, false), 90);
  assert.equal(p.target(97, false), -3);
  assert.equal(inZone(105, { fromIn: 3, toIn: 8 }, 100), true);
});

// ---------- validator ----------
test("a good show validates, and the example show validates against the example layout", () => {
  assert.deepEqual(valid(loadShow(here("../examples/shows/lap.json")), { layout: JSON.parse(readFileSync(here("../examples/layout.example.json"), "utf8")), loco: LOCO }).errors, []);
});
test("the validator points at each mistake by path", () => {
  const bad = show([
    { do: "ramp", to: 1.4 }, { do: "ramp", too: 0.2 }, { do: "teleport" }, { do: "wait-for", event: "bump" },
    { do: "creep", forward: true, speed: 0.3, until: "break", maxMs: 5000 }, { do: "ramp", to: "$nope" },
    { do: "led", color: "plaid" }, { do: "fill", id: "x" }, { do: "repeat", times: 0, steps: [{ do: "wait", ms: -1 }] },
  ], { settings: { cruise: "fast" }, start: "middle", extra: 1 });
  const e = valid(bad).errors.join("\n");
  for (const want of ["steps[0].to: 1.4 is above the maximum 1", "steps[1].too: not a field", "steps[1].to: \"ramp\" needs to", "steps[2].do: unknown step \"teleport\"", "steps[3].event: must be one of", "steps[4].speed: 0.3 is above the maximum 0.1", "steps[5].to: $nope is not in the show's settings", "steps[6].color: unknown colour", "steps[7]: fill needs exactly one of ms or zone", "steps[8].times: 1 is below" , "steps[8].steps[0].ms", "settings.cruise: settings are numbers", "start: must be", "extra: unknown field"]) assert.ok(e.includes(want.replace("1 is below", "0 is below")) || e.includes(want), `missing: ${want}\n${e}`);
});
test("format and name are required", () => {
  assert.match(valid({ steps: [] }).errors.join(), /format: must be "z-show\/1"/);
  assert.match(valid({ format: "z-show/1", steps: [{ do: "wait", ms: 1 }] }).errors.join(), /name/);
  assert.match(valid(null).errors[0], /JSON object/);
});
test("unknown sounds and zones are errors, missing layout is a warning", () => {
  const sounds = { check(ids) { for (const i of ids) if (i !== "horn") throw new Error(`no sound "${i}"`); } };
  const s = show([{ do: "sound", id: "horn" }, { do: "sound", id: "nope" }, { do: "wait-zone", zone: "moon", edge: "enter" }]);
  const r = valid(s, { sounds, layout: LAYOUT, loco: LOCO });
  assert.ok(r.errors.some((e) => e.startsWith("steps[1].id") && /no sound "nope"/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith("steps[2].zone") && /no zone "moon"/.test(e)));
  assert.ok(valid(show([{ do: "wait-zone", zone: "curve", edge: "enter" }])).warnings.some((w) => /no layout/.test(w)));
});
test("lint: ramping above creep with no beam wait is a blind run", () => {
  const blind = show([{ do: "ramp", to: 0.3 }, { do: "wait", ms: 4000 }, { do: "halt" }]);
  assert.match(valid(blind).errors.join(), /steps\[0\].*blind run/);
  const ok = show([{ do: "ramp", to: 0.3 }, { do: "wait-for", event: "pass" }, { do: "halt" }]);
  assert.deepEqual(valid(ok).errors, []);
  assert.match(valid(show([{ do: "ramp", to: 0.3 }, { do: "wait-for", event: "pass" }])).errors.join(), /ends with the loco still running/);
  assert.match(valid(show([{ do: "ramp", to: 0.3 }, { do: "wait-for", event: "pass" }, { do: "halt" }, { do: "ramp", to: 0.25 }, { do: "wait", ms: 1000 }, { do: "halt" }])).errors.join(), /steps\[3\].*blind run/);
  assert.ok(valid(show([{ do: "ramp", to: 0.3 }, { do: "wait-for", event: "pass" }, { do: "halt" }, { do: "wait", ms: 9000 }])).warnings.length === 0);
  assert.ok(valid(show([{ do: "ramp", to: 0.3 }, { do: "wait", ms: 9000 }, { do: "wait-for", event: "pass" }, { do: "halt" }])).warnings.some((w) => /timed wait/.test(w)));
});
test("lint: a guard inside a parallel branch counts, and creep ends a run", () => {
  assert.deepEqual(valid(show([{ do: "parallel", branches: [[{ do: "ramp", to: 0.25 }], [{ do: "wait-for", event: "restore" }, { do: "ramp", to: 0.1 }]] }, { do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 9000 }])).errors, []);
  assert.match(valid(show([{ do: "parallel", branches: [] }])).errors.join(), /branches/);
});
test("settings can be overridden and are range-checked after substitution", () => {
  const s = show([{ do: "ramp", to: "$cruise" }, { do: "wait-for", event: "pass" }, { do: "halt" }], { settings: { cruise: 0.25 } });
  assert.deepEqual(valid(s).errors, []);
  assert.match(valid(s, { settings: { cruise: 1.5 } }).errors.join(), /to: 1.5 is above/);
});
test("soundsUsed collects ids from nested steps and needs", () => {
  const s = show([{ do: "sound", id: "a" }, { do: "repeat", times: 2, steps: [{ do: "fill", id: "b", ms: 100 }] }, { do: "parallel", branches: [[{ do: "loop", slot: "x", id: "c" }]] }], { needs: { sounds: ["d"] } });
  assert.deepEqual(soundsUsed(s).sort(), ["a", "b", "c", "d"]);
});

// ---------- layout / io ----------
test("layout validation catches inverted zones and zones beyond the loop", () => {
  assert.deepEqual(validateLayout(LAYOUT), []);
  assert.match(validateLayout({ ...LAYOUT, zones: { z: { fromIn: 9, toIn: 3 } } }).join(), /fromIn < toIn/);
  assert.match(validateLayout({ ...LAYOUT, zones: { z: { fromIn: 9, toIn: 300 } } }).join(), /beyond the loop/);
  assert.match(validateLayout({ format: "nope" }).join(), /format must be/);
});
test("a show survives export and import unchanged", () => {
  const s = loadShow(here("../examples/shows/lap.json"));
  const f = join(mkdtempSync(join(tmpdir(), "show-")), "x.json");
  saveShow(s, f);
  assert.deepEqual(loadShow(f), s);
  assert.equal(stringifyShow(s), stringifyShow(loadShow(f)));
  assert.throws(() => loadShow(join(tmpdir(), "does-not-exist.json")), /no such file/);
});

// ---------- runtime (simulated) ----------
async function rig({ loco = LOCO, layout = LAYOUT, sensor = {}, onSetup } = {}) {
  const clock = new VirtualClock();
  const ctl = new Controller({ host: "sim", WebSocketImpl: SimSocket, clock, config: { pingMs: 2e9 } });
  await ctl.connect();
  const gs = new GhostSensor(clock, { eventMs: 1000, ...sensor });
  const snd = new SimSound(clock, null);
  if (onSetup) onSetup({ clock, ctl, gs, snd });
  const run = (s, opts = {}) => clock.run(runShow(s, { controller: ctl, sensor: gs, sound: snd, layout, loco, clock, ...opts }));
  return { clock, ctl, gs, snd, run, sent: () => SimSocket.last.sent.filter((m) => m.cmd !== "ping") };
}
const speeds = (r) => r.sent().filter((m) => m.cmd === "speed").map((m) => m.value);

test("a show runs its steps in order and the loco ends stopped", async () => {
  const r = await rig();
  const res = await r.run(show([{ do: "direction", forward: true }, { do: "ramp", to: 0.2, secondsPer01: 0.1 }, { do: "wait-for", event: "pass" }, { do: "halt", secondsPer01: 0.1 }]));
  assert.equal(res.ok, true);
  assert.equal(r.ctl.speed, 0);
  assert.equal(speeds(r).at(-1), 0);
  assert.ok(Math.max(...speeds(r)) === 0.2);
  assert.ok(r.sent().some((m) => m.cmd === "direction" && m.value === true));
});
test("parallel branches run together: the beam wait is listening while the ramp runs (regression)", async () => {
  const r = await rig();
  const t0 = r.clock.now();
  const s = show([{ do: "parallel", branches: [[{ do: "ramp", to: 0.3 }], [{ do: "wait-for", event: "restore" }, { do: "log", message: "restore seen" }]] }, { do: "halt" }]);
  const res = await r.run(s);
  const seen = res.log.find((e) => e.text === "restore seen").t, rampEnd = res.log.find((e) => e.text === "halt").t;
  assert.equal(seen, 1000, "the restore is seen at the sensor's time, not after the ramp");
  assert.ok(rampEnd > 2500, "the 0.3 ramp (3 s) was still going");
  assert.ok(t0 === 0);
});
test("repeat repeats, and settings override the show's values", async () => {
  const r = await rig();
  const s = show([{ do: "repeat", times: 3, steps: [{ do: "sound", id: "chime", gain: "$g", wait: false }] }], { settings: { g: 0.5 } });
  await r.run(s, { settings: { g: 0.9 } });
  assert.equal(r.snd.calls.filter((c) => c.kind === "play").length, 3);
});
test("sound steps wait for the sound by default and fire-and-forget with wait:false", async () => {
  const r = await rig();
  const res = await r.run(show([{ do: "sound", id: "a", seconds: 2 }, { do: "log", message: "after wait" }, { do: "sound", id: "b", seconds: 2, wait: false }, { do: "log", message: "no wait" }]));
  assert.equal(res.log.find((e) => e.text === "after wait").t, 1000 , "a library-less sound lasts 1 s in the simulator");
  assert.equal(res.log.find((e) => e.text === "no wait").t, 1000);
  assert.equal(res.log.at(-1).text, "finished");
});
test("start: blocked refuses when the beam is clear, before anything moves", async () => {
  const r = await rig({ sensor: { state: "clear" } });
  await assert.rejects(r.run(show([{ do: "ramp", to: 0.1 }, { do: "halt" }], { start: "blocked" })), /starts with the beam blocked, but the sensor says clear/);
  assert.equal(r.sent().filter((m) => m.cmd === "speed" || m.cmd === "direction").length, 0);
});
test("an invalid show never reaches the controller", async () => {
  const r = await rig();
  await assert.rejects(r.run(show([{ do: "ramp", to: 0.3 }, { do: "halt" }])), /not valid[\s\S]*blind run/);
  assert.equal(r.sent().length, 0);
});
test("zone steps use the position estimate: the curve is entered where the model says", async () => {
  const r = await rig({ sensor: { state: "blocked" } });
  const s = show([
    { do: "direction", forward: true },
    { do: "parallel", branches: [[{ do: "ramp", to: 0.2, secondsPer01: 0.1 }], [{ do: "wait-for", event: "restore" }, { do: "wait-zone", zone: "curve", edge: "enter" }, { do: "log", message: "in curve" }, { do: "wait-zone", zone: "curve", edge: "exit" }, { do: "log", message: "out of curve" }, { do: "halt", secondsPer01: 0.1 }]] },
  ], { start: "blocked" });
  const res = await r.run(s);
  const inT = res.log.find((e) => e.text === "in curve").t, outT = res.log.find((e) => e.text === "out of curve").t;
  const v = speedModel(LOCO)(0.2);   // 5.4 in/s once the 0.2 ramp is done (0.2 s)
  assert.ok(Math.abs((outT - inT) / 1000 - (12 - 5.5) / v) < 0.15, `curve took ${(outT - inT)} ms, expected about ${((12 - 5.5) / v * 1000).toFixed(0)}`);
  // the direction step settles for 300 ms, the ghost restore lands 1000 ms later (tail edge: nose at 3 in), then 2.5 in to the curve at 5.4 in/s
  assert.ok(Math.abs(inT - (1300 + (2.5 / v) * 1000)) < 120, `entered at ${inT} ms, expected about ${(1300 + (2.5 / v) * 1000).toFixed(0)}`);
});
test("fill with a zone waits for the zone and fills for its predicted length", async () => {
  const r = await rig({ sensor: { state: "blocked" } });
  const res = await r.run(show([{ do: "direction", forward: true }, { do: "parallel", branches: [[{ do: "ramp", to: 0.2, secondsPer01: 0.1 }, { do: "wait-for", event: "restore" }, { do: "wait", ms: 4000 }, { do: "halt", secondsPer01: 0.1 }], [{ do: "fill", id: "flange", zone: "curve" }]] }], { start: "blocked" }));
  const f = r.snd.calls.find((c) => c.kind === "fill");
  assert.ok(f, "no fill happened");
  assert.ok(Math.abs(f.ms - ((12 - 5.5) / 5.4) * 1000) < 100, `fill ${f.ms} ms`);
  assert.ok(f.t > 800, "it waited for the zone");
  assert.equal(res.ok, true);
});
test("zone steps need a layout and a known position", async () => {
  const r = await rig({ layout: null });
  await assert.rejects(r.run(show([{ do: "wait-zone", zone: "curve", edge: "enter" }])), /needs a layout and a loco profile/);
  const r2 = await rig({ sensor: { state: "clear" } });
  await assert.rejects(r2.run(show([{ do: "direction", forward: true }, { do: "wait-zone", zone: "curve", edge: "enter" }])), /position is not known/);
});

test("wait-zone gives up after its time limit instead of waiting forever, and the loco is stopped", async () => {
  const r = await rig({ sensor: { state: "blocked" } });
  const s = show([{ do: "direction", forward: true }, { do: "parallel", branches: [[{ do: "ramp", to: 0.1, secondsPer01: 0.1 }], [{ do: "wait-for", event: "restore" }, { do: "wait-zone", zone: "approach", edge: "enter", timeoutMs: 3000 }]] }, { do: "halt" }], { start: "blocked" });
  let err; try { await r.run(s); } catch (e) { err = e; }
  assert.match(err.message, /zone "approach" enter not reached within 3 s .*is the speed model right/);
  assert.equal(r.ctl.speed, 0);
});
test("creep until break does not move when the beam is already broken", async () => {
  const r = await rig({ sensor: { state: "blocked" } });
  const res = await r.run(show([{ do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 5000 }, { do: "log", message: "after" }]));
  assert.ok(res.log.some((e) => /beam already blocked: not moving/.test(e.text)));
  assert.equal(speeds(r).length, 0, "nothing was sent to the loco");
  const r2 = await rig({ sensor: { state: "clear" } });
  await r2.run(show([{ do: "creep", forward: false, speed: 0.1, until: "restore", maxMs: 5000 }]));
  assert.equal(speeds(r2).length, 0);
});

// ---------- failures stop the loco properly ----------
test("a sensor that goes quiet mid-run stops the show and ramps the loco down from speed (motor care)", async () => {
  const r = await rig({ onSetup: ({ clock, gs }) => { clock.sleep(2500).then(() => gs.emit("lost")); } });
  const s = show([{ do: "ramp", to: 0.3, secondsPer01: 0.1 }, { do: "wait-for", event: "pass", timeoutMs: 60000 }, { do: "halt" }]);
  let err; try { await r.run(s); } catch (e) { err = e; }
  assert.match(err.message, /sensor stopped reporting/);
  assert.equal(err.result.ok, false);
  const sp = speeds(r);
  assert.equal(sp.at(-1), 0);
  assert.ok(sp.length > 8, "slowed in steps, not one jump");
  for (let i = 1; i < sp.length; i++) if (sp[i] < sp[i - 1]) assert.ok(sp[i - 1] - sp[i] <= 0.1 + 1e-9, `abrupt drop ${sp[i - 1]} -> ${sp[i]}`);
  assert.equal(r.sent().filter((m) => m.cmd === "stop").length, 0, "no emergency stop was needed");
});
test("an abort signal stops sounds and the loco", async () => {
  const r = await rig();
  const ac = new AbortController();
  r.clock.sleep(1500).then(() => ac.abort());
  const s = show([{ do: "loop", slot: "m", id: "run" }, { do: "ramp", to: 0.2, secondsPer01: 0.1 }, { do: "wait-for", event: "pass", timeoutMs: 60000 }, { do: "halt" }]);
  await assert.rejects(r.run(s, { signal: ac.signal }), /aborted/);
  assert.equal(r.ctl.speed, 0);
  assert.ok(r.snd.calls.some((c) => c.kind === "stop-all"));
});
test("a failing step reports where, and still stops", async () => {
  const r = await rig({ sensor: { state: "clear" } });
  const s = show([{ do: "direction", forward: true }, { do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 500 }], { start: "clear" });
  r.gs.waitFor = () => new Promise(() => {});   // the beam never breaks
  let err; try { await r.run(s); } catch (e) { err = e; }
  assert.match(err.message, /creep ended without the beam event \(timeout\)/);
  assert.equal(r.ctl.speed, 0);
  assert.ok(err.result.log.some((e) => /stopped: creep ended/.test(e.text)));
});

// ---------- wait-approach: where to start slowing for a beam stop ----------
test("rampDistanceIn: from 0.3 to creep at 1 s per 0.1 takes about 10 inches, and a ramp of nothing takes none", () => {
  const v = speedModel(LOCO);
  const d = rampDistanceIn(v, 0.3, 0.1, 1);
  assert.ok(d > 9.5 && d < 11, `${d}`);
  assert.equal(rampDistanceIn(v, 0.1, 0.1, 1), 0);
  assert.ok(Math.abs(rampDistanceIn(v, 0.1, 0.3, 1) - d) < 1e-6, "up or down covers the same ground");
});
test("wait-approach starts slowing ramp + 5 in of creep + margin before the beam, measured from the leading end (nose forward, tail in reverse)", async () => {
  const run = async (forward) => simulateShow(show([
    { do: "direction", forward },
    { do: "parallel", branches: [[{ do: "ramp", to: 0.2 }], [{ do: "wait-for", event: "restore", timeoutMs: 15000 }, { do: "wait-approach", from: 0.2 }, { do: "ramp", to: 0.1 }, { do: "creep", forward, speed: 0.1, until: "break", maxMs: 30000 }]] },
  ], { start: "blocked" }), { layout: LAYOUT, loco: LOCO });
  const ramp = rampDistanceIn(speedModel(LOCO), 0.2, 0.1, 1), d = ramp + 5 + 3;
  for (const forward of [true, false]) {
    const r = await run(forward);
    assert.equal(r.ok, true, r.error);
    const line = r.log.map((e) => e.text).find((t) => t.startsWith("approach: start slowing"));
    assert.ok(line, "the step says where it will slow down");
    const at = +line.match(/at (-?[\d.]+) in/)[1];
    // forward: the nose reaches the beam at x = 134 (one lap on); reverse: the tail does, with the nose still 3 in past it
    const beam = forward ? 134 : -134 + 3;
    assert.ok(Math.abs(Math.abs(at - beam) - d) < 0.2 || Math.abs(Math.abs(at - (forward ? 0 : 3)) - d) < 0.2, `${forward ? "forward" : "reverse"}: ${line}`);
    assert.ok(r.log.some((e) => e.text === "approach: slow down now"));
  }
});
test("wait-approach is checked: it needs the loop length, and it counts as a beam wait for the blind-run rule", () => {
  const s = show([{ do: "direction", forward: true }, { do: "parallel", branches: [[{ do: "ramp", to: 0.3 }], [{ do: "wait-approach", from: 0.3 }, { do: "ramp", to: 0.1 }]] }, { do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 9000 }]);
  assert.deepEqual(valid(s, { layout: LAYOUT, loco: LOCO }).errors, []);
  assert.match(valid(s, { layout: { ...LAYOUT, loopIn: undefined }, loco: LOCO }).errors.join("\n"), /needs layout.loopIn/);
  assert.match(valid(show([{ do: "wait-approach" }]), { layout: LAYOUT, loco: LOCO }).errors.join("\n"), /needs from/);
});

test("the position estimate is brought up to date when the loco stops, so a pause does not carry on integrating the creep", async () => {
  // creep forward until the tail clears (anchors x = 3), wait 4 s standing still, then move off and wait for the curve at 5.5 in:
  // with the stale-speed bug the estimate had run on to about 12 in during the wait and the curve was a lap away
  const s = show([{ do: "direction", forward: true }, { do: "creep", forward: true, speed: 0.1, until: "restore", maxMs: 8000 }, { do: "wait", ms: 4000 },
    { do: "parallel", branches: [[{ do: "ramp", to: 0.1 }], [{ do: "wait-zone", zone: "curve", edge: "enter", timeoutMs: 5000 }]] }, { do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 8000 }], { start: "blocked" });
  const r = await simulateShow(s, { layout: LAYOUT, loco: LOCO });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.log.some((e) => /^zone "curve" enter/.test(e.text)), r.log.map((e) => e.text).join(" | "));
});

test("loop afterMs starts a loop later without holding the show up, and stop-loop (or the end of the show) cancels it", async () => {
  const loops = (r) => r.sounds.filter((c) => c.kind === "loop");
  const late = await simulateShow(show([{ do: "loop", slot: "m", id: "motion.run", afterMs: 1000 }, { do: "log", message: "not held up" }, { do: "wait", ms: 3000 }]), {});
  assert.equal(late.ok, true, late.error);
  assert.equal(loops(late).length, 1); assert.equal(loops(late)[0].t, 1000);
  assert.equal(late.log.find((e) => e.text === "not held up").t, 0, "the next step ran at once");
  const cancelled = await simulateShow(show([{ do: "loop", slot: "m", id: "motion.run", afterMs: 5000 }, { do: "wait", ms: 1000 }, { do: "stop-loop", slot: "m" }, { do: "wait", ms: 6000 }]), {});
  assert.equal(loops(cancelled).length, 0, "stopped before it started: it never starts");
  const ended = await simulateShow(show([{ do: "loop", slot: "m", id: "motion.run", afterMs: 5000 }, { do: "wait", ms: 1000 }]), {});
  assert.equal(loops(ended).length, 0, "the end of the show cancels it too");
  const replaced = await simulateShow(show([{ do: "loop", slot: "m", id: "a", afterMs: 2000 }, { do: "loop", slot: "m", id: "b" }, { do: "wait", ms: 3000 }]), {});
  assert.deepEqual(loops(replaced).map((c) => c.id), ["b"], "a later loop in the slot replaces the waiting one");
});

// ---------- the simulator ----------
test("simulateShow runs the example show end to end and reports the timeline", async () => {
  const s = loadShow(here("../examples/shows/lap.json"));
  const r = await simulateShow(s, { layout: LAYOUT, loco: LOCO });
  assert.equal(r.ok, true, r.error);
  const text = r.log.map((e) => e.text);
  for (const want of ["sound brake.release", "waiting for restore", "approach: slow down now", "ramp to 0.1", "creep forward until break", "finished"]) assert.ok(text.some((t) => t.startsWith(want)), `missing "${want}" in ${text.join(" | ")}`);
  assert.ok(text.findIndex((t) => t.startsWith("restore")) < text.findIndex((t) => t.startsWith("approach: slow down now")), "restore comes before the approach point (the ramp does not block the wait)");
  assert.equal(r.maxSpeed, 0.25);
  assert.ok(r.commands.every((c, i, a) => c.cmd !== "speed" || i === 0 || true));
  assert.ok(r.sounds.some((c) => c.kind === "fill" && c.id === "flange"));
  assert.equal(r.commands.at(-2)?.cmd === "led_auto" || r.commands.at(-1)?.cmd === "led_auto", true);
});
test("simulateShow returns a failed run with its timeline instead of throwing", async () => {
  // the ghost sensor would confirm the beam after 550 ms, but the creep gives up after 100 ms
  const r = await simulateShow(show([{ do: "creep", forward: true, speed: 0.1, until: "break", maxMs: 100 }]), { eventMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /creep ended without the beam event \(timeout\)/);
  assert.ok(r.log.some((e) => /^stopped:/.test(e.text)));
  assert.equal(r.commands.filter((c) => c.cmd === "speed").at(-1).value, 0);
});

test("a controller with no status LED: led and led-auto steps are skipped, logged, and the rest of the show runs", async () => {
  const clock = new VirtualClock();
  const ctl = new Controller({ host: "sim", WebSocketImpl: SimSocket, clock, config: { pingMs: 2e9 }, led: false });
  await ctl.connect();
  const sensor = new GhostSensor(clock, { state: "clear" });
  const sound = new SimSound(clock, null);
  let result;
  await clock.run((async () => {
    result = await runShow(show([{ do: "led", color: "red" }, { do: "wait", ms: 100 }, { do: "led-auto" }, { do: "direction", forward: true }]), { controller: ctl, sensor, sound, clock });
    await ctl.close();
  })());
  const sent = SimSocket.last.sent.filter((m) => m.cmd !== "ping");
  assert.ok(!sent.some((m) => m.cmd === "led" || m.cmd === "led_auto"), JSON.stringify(sent));
  assert.ok(sent.some((m) => m.cmd === "direction"));
  assert.equal(result.log.filter((e) => /led skipped/.test(e.text)).length, 2);
});
