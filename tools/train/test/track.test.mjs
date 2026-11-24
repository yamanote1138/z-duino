import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../lib/controller/index.mjs";
import { SimSocket, VirtualClock } from "../lib/show/index.mjs";
import { PhysicsTrack, returnToMark } from "../lib/track/index.mjs";

const LOCO = { lengthIn: 3, fit: { inPerSecPerUnitThrottle: 28.65, offsetInS: -0.49 }, points: [{ thr: 0.08, v: 1.8 }, { thr: 0.1, v: 2.35 }, { thr: 0.2, v: 5.4 }, { thr: 0.3, v: 8.1 }] };
const LOOP = 134;

async function world({ nose = 0, ...faults } = {}) {
  const clock = new VirtualClock();
  const ctl = new Controller({ host: "sim", WebSocketImpl: SimSocket, clock, config: { pingMs: 2e9 } });
  await ctl.connect();
  const track = new PhysicsTrack({ clock, controller: ctl, loco: LOCO, loopIn: LOOP, nose, ...faults });
  return { clock, ctl, track };
}
const finish = async (w, work) => { let out; await w.clock.run((async () => { out = await work(); })()); w.track.stop(); return out; };

// ---------------- the physics model ----------------

test("physics: going forward the nose breaks the beam and the tail restores it, one pass of length/speed seconds", async () => {
  const w = await world({ nose: -6 });
  const ev = [];
  for (const e of ["break", "restore", "nose", "tail", "pass"]) w.track.on(e, (x) => ev.push([e, x]));
  await finish(w, async () => { w.track.setDirection("forward"); await w.ctl.setDirection(true); w.ctl.setSpeed(0.1); await w.clock.sleep(6000); w.ctl.setSpeed(0); });
  assert.deepEqual(ev.map((e) => e[0]), ["break", "nose", "restore", "tail", "pass"]);
  const pass = ev.find((e) => e[0] === "pass")[1];
  assert.ok(Math.abs(pass.durationMs - (3 / 2.35) * 1000) < 60, `pass ${pass.durationMs} ms`);
  assert.ok(w.track.noseIn > 6 && w.track.noseIn < 8.5, `nose ${w.track.noseIn}`);
  assert.equal(w.track.state, "clear");
});

test("physics: in reverse the tail breaks the beam and the nose restores it; positions wrap round the loop", async () => {
  const w = await world({ nose: 8 });
  const names = [];
  for (const e of ["break", "restore"]) w.track.on(e, (x) => names.push(`${e}:${x.edge}`));
  await finish(w, async () => { w.track.setDirection("reverse"); await w.ctl.setDirection(false); w.ctl.setSpeed(0.1); await w.clock.sleep(5000); w.ctl.setSpeed(0); });
  assert.deepEqual(names, ["break:tail", "restore:nose"]);
  assert.ok(w.track.noseIn > LOOP - 5 && w.track.noseIn < LOOP, `wrapped to ${w.track.noseIn}`);
});

test("physics: waitFor times out on the clock, and the faults behave", async () => {
  const w = await world({ nose: 50 });
  await finish(w, async () => { await assert.rejects(w.track.waitFor("break", { timeoutMs: 1000 }), /timed out after 1000 ms waiting for break/); });
  const stuck = await world({ nose: 50, stuck: true }); assert.equal(stuck.track.state, "blocked"); stuck.track.stop();
  const deaf = await world({ nose: -1, deaf: true }); const seen = [];
  deaf.track.on("break", () => seen.push(1));
  await finish(deaf, async () => { await deaf.ctl.setDirection(true); deaf.ctl.setSpeed(0.1); await deaf.clock.sleep(3000); deaf.ctl.setSpeed(0); });
  assert.deepEqual(seen, [], "a deaf sensor reports nothing even though the loco crossed the beam");
});

// ---------------- returning to the mark ----------------

const onMark = (w, r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.track.state, "blocked", "the beam is blocked");
  assert.ok(w.track.noseIn >= 0 && w.track.noseIn < 0.4, `the nose is on the beam edge (${w.track.noseIn.toFixed(2)} in past it)`);
  assert.equal(w.ctl.speed, 0, "the loco is stopped");
};

test("reset: the nose is in the beam (the loco is already on the mark): it is re-seated on the edge", async () => {
  const w = await world({ nose: 1.2 });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  onMark(w, r); assert.equal(r.how, "re-seated");
  assert.deepEqual(r.legs.map((l) => l.result), ["guard", "guard"]);
  assert.ok(w.track.distanceIn < 12, `moved ${w.track.distanceIn.toFixed(1)} in`);
});

test("reset: the TAIL is in the beam (the loco is just past the mark): it is re-seated onto the nose edge", async () => {
  const w = await world({ nose: 2.7 });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  onMark(w, r); assert.equal(r.how, "re-seated");
});

test("reset: just short of the mark: one creep forward does it", async () => {
  const w = await world({ nose: -4 });
  const logs = [];
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock, onLog: (e) => logs.push(e.text) }));
  onMark(w, r); assert.equal(r.how, "just short");
  assert.equal(r.legs.length, 1); assert.ok(logs.some((l) => /just short/.test(l)));
  assert.ok(w.track.distanceIn < 5.5);
});

test("reset: just past the mark: forward finds nothing, so it backs over the beam and comes forward onto it", async () => {
  const w = await world({ nose: 6 });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  onMark(w, r); assert.equal(r.how, "just past");
  assert.deepEqual(r.legs.map((l) => l.result), ["timeout", "guard", "guard"]);
  assert.ok(w.track.distanceIn < 60, `moved ${w.track.distanceIn.toFixed(1)} in`);
});

test("reset: somewhere else on the loop: it gives up on nearby and runs the loop at creep until the beam breaks", async () => {
  const w = await world({ nose: 67 });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  onMark(w, r); assert.equal(r.how, "round the loop");
  assert.deepEqual(r.legs.map((l) => l.result), ["timeout", "timeout", "guard"]);
  assert.ok(r.elapsedMs < 100000, `${r.elapsedMs} ms`);
});

test("reset: it never moves above creep speed", async () => {
  const w = await world({ nose: 67 });
  await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  const speeds = SimSocket.last.sent.filter((m) => m.cmd === "speed").map((m) => m.value);
  assert.ok(speeds.length > 0 && Math.max(...speeds) <= 0.1, `max ${Math.max(...speeds)}`);
});

test("reset: something else blocks the beam: it says so and stops", async () => {
  const w = await world({ nose: 1, stuck: true });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  assert.equal(r.ok, false); assert.match(r.error, /beam stays blocked/); assert.equal(w.ctl.speed, 0);
});

test("reset: a sensor that never reports: it tries every step, then stops with a clear message", async () => {
  const w = await world({ nose: 67, deaf: true });
  const r = await finish(w, () => returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }));
  assert.equal(r.ok, false); assert.match(r.error, /did not break in a lap's time/); assert.equal(w.ctl.speed, 0);
  assert.deepEqual(r.legs.map((l) => l.result), ["timeout", "timeout", "timeout"]);
});

test("reset: an abort stops the loco at once", async () => {
  const w = await world({ nose: 67 });
  const ac = new AbortController();
  const r = await finish(w, async () => { w.clock.sleep(3000).then(() => ac.abort()); return returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock, signal: ac.signal }); });
  assert.equal(r.ok, false); assert.equal(r.error, "aborted"); assert.equal(w.ctl.speed, 0);
  assert.ok(r.elapsedMs < 3500, `${r.elapsedMs} ms`);
});

test("reset: losing the sensor stops it", async () => {
  const w = await world({ nose: 67 });
  const r = await finish(w, async () => { w.clock.sleep(2000).then(() => w.track.emit("lost", {})); return returnToMark({ controller: w.ctl, sensor: w.track, clock: w.clock }); });
  assert.equal(r.ok, false); assert.match(r.error, /sensor stopped reporting/); assert.equal(w.ctl.speed, 0);
});
