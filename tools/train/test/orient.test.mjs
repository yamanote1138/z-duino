import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { orientShow, checkDirection, loadShow, loadLayout, loadLoco, validateShow, simulateShow } from "../lib/show/index.mjs";
import { decideInvert, orientationRecord } from "../lib/track/index.mjs";
import { parseOrientation } from "../lib/config/index.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const LOCO = { lengthIn: 3, fit: { inPerSecPerUnitThrottle: 28.65, offsetInS: -0.49 }, points: [{ thr: 0.1, v: 2.35 }, { thr: 0.2, v: 5.4 }, { thr: 0.3, v: 8.1 }] };
const LAYOUT = { format: "z-layout/1", loopIn: 134, zones: { a: { fromIn: 4.5, toIn: 13 }, b: { fromIn: 13, toIn: 22 }, c: { fromIn: 44.5, toIn: 58.5 }, d: { fromIn: 108.5, toIn: 121.5 } } };
const show = (steps, extra = {}) => ({ format: "z-show/1", name: "t", steps, ...extra });
const fill = (zone, extra = {}) => ({ do: "fill", id: "flange", zone, ...extra });

test("forward is the show itself, and a bad direction is an error", () => {
  const s = show([{ do: "direction", forward: true }]);
  assert.equal(orientShow(s, "forward"), s);
  assert.equal(orientShow(s), s);
  assert.throws(() => checkDirection("sideways"), /forward or reverse/);
  assert.throws(() => orientShow(s, "left"), /forward or reverse/);
});

test("reverse flips direction and creep steps, swaps the nose and tail edges, and leaves the input alone", () => {
  const s = show([
    { do: "direction", forward: true },
    { do: "parallel", branches: [[{ do: "wait-for", event: "tail" }, { do: "creep", forward: true, speed: 0.1, until: "restore", maxMs: 9000 }], [{ do: "repeat", times: 2, steps: [{ do: "creep", forward: true, speed: 0.1, until: "nose", maxMs: 9000 }] }]] },
    { do: "led", color: "red" },
  ]);
  const before = JSON.stringify(s);
  const r = orientShow(s, "reverse");
  assert.equal(JSON.stringify(s), before, "the original is not changed");
  assert.equal(r.name, "t (reverse)");
  assert.equal(r.steps[0].forward, false);
  assert.equal(r.steps[1].branches[0][0].event, "nose");
  assert.equal(r.steps[1].branches[0][1].forward, false);
  assert.equal(r.steps[1].branches[0][1].until, "restore", "beam states are physical and stay as they are");
  assert.equal(r.steps[1].branches[1][0].steps[0].forward, false);
  assert.equal(r.steps[1].branches[1][0].steps[0].until, "tail");
  assert.deepEqual(r.steps[2], { do: "led", color: "red" });
});

test("a run of zone fills is played in the order the loco meets the zones; nothing else moves", () => {
  const s = show([fill("a"), fill("b"), { do: "log", message: "between" }, fill("c"), fill("d", { wait: false }), fill("a")]);
  const r = orientShow(s, "reverse", { layout: LAYOUT });
  assert.deepEqual(r.steps.map((x) => x.zone ?? x.message), ["b", "a", "between", "c", "d", "a"]);
  const s2 = show([fill("a"), fill("d"), fill("b"), fill("c")]);
  assert.deepEqual(orientShow(s2, "reverse", { layout: LAYOUT }).steps.map((x) => x.zone), ["d", "c", "b", "a"]);
  assert.deepEqual(orientShow(s2, "reverse").steps.map((x) => x.zone), ["a", "d", "b", "c"], "without a layout the order is left alone");
});

test("a show that starts on the mark first seats the tail on it; one that does not, does not", () => {
  const withMark = orientShow(show([{ do: "led", color: "red" }], { start: "blocked" }), "reverse");
  assert.deepEqual(withMark.steps.slice(0, 5).map((x) => x.do === "creep" ? `creep ${x.forward ? "fwd" : "back"} ${x.until}` : x.do + (x.do === "direction" ? ` ${x.forward}` : "")), ["log", "direction true", "creep fwd restore", "direction false", "creep back break"]);
  assert.equal(withMark.steps.at(-1).do, "led");
  assert.ok(withMark.steps.filter((x) => x.do === "creep").every((x) => x.speed <= 0.1 && x.maxMs > 0), "every seating move is a creep with a time limit and a beam stop");
  assert.equal(orientShow(show([{ do: "led", color: "red" }]), "reverse").steps.length, 1);
});

test("every example show, turned round, is still a valid show and ends where a forward one does (the leading end on the beam)", () => {
  const layout = loadLayout(here("../examples/layout.example.json")), loco = loadLoco(here("../examples/loco.example.json"));
  const dir = here("../examples/shows/");
  const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(names.length >= 4);
  for (const f of names) {
    const s = loadShow(dir + f), r = orientShow(s, "reverse", { layout });
    const c = validateShow(r, { layout, loco });
    assert.deepEqual(c.errors, [], `${f}: ${c.errors.join("; ")}`);
    const lastCreep = (steps) => { let c = null; const walk = (l) => l.forEach((x) => { if (x.do === "creep") c = x; if (x.steps) walk(x.steps); if (x.branches) x.branches.forEach(walk); }); walk(steps); return c; };
    const fc = lastCreep(s.steps), rc = lastCreep(r.steps);
    if (fc && fc.forward) assert.equal(lastCreep(r.steps).forward, false, `${f}: the last creep goes the other way`);
    assert.ok(rc, f);
  }
});

test("in a reverse run a zone is met one loco length later: the nose estimate it waits for moves by the loco length", async () => {
  // standing still after the anchor, so the wait times out and the message says which estimate it was waiting for
  const wait = (dir) => orientShow(show([{ do: "direction", forward: true }, { do: "wait-for", event: "restore" }, { do: "wait-zone", zone: "a", edge: "enter", timeoutMs: 2000 }]), dir, { layout: LAYOUT });
  const msg = async (s) => (await simulateShow(s, { layout: LAYOUT, loco: LOCO })).error;
  // forward: the nose enters zone a at its fromIn (4.5), so the estimate is waited up to 4.5 in beyond the anchor; reverse: at its toIn plus the loco length (13 + 3 = 16), a lap back
  assert.match(await msg(wait("forward")), /waiting for 4\.5 in/);
  assert.match(await msg(wait("reverse")), /waiting for -118\.0 in/);   // 16 - 134
});

test("decideInvert keeps the polarity when the nose led and flips it when the back did", () => {
  assert.deepEqual(decideInvert({ invert: false, noseLed: true }), { invert: false, flipped: false });
  assert.deepEqual(decideInvert({ invert: true, noseLed: true }), { invert: true, flipped: false });
  assert.deepEqual(decideInvert({ invert: false, noseLed: false }), { invert: true, flipped: true });
  assert.deepEqual(decideInvert({ invert: true, noseLed: false }), { invert: false, flipped: true });
});
test("the orientation record is what the config loader reads back", () => {
  const r = orientationRecord({ invert: true, forwardMoves: "left", now: new Date("2026-11-24T12:00:00Z") });
  assert.equal(r.calibrated, "2026-11-24");
  assert.deepEqual({ ...parseOrientation(JSON.stringify(r)) }, r);
  assert.throws(() => orientationRecord({ invert: false, forwardMoves: "up" }), /right" or "left/);
});
