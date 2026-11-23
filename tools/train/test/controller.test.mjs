import test from "node:test";
import assert from "node:assert/strict";
import { Controller, MotorCareError } from "../lib/controller/index.mjs";
import { findHost } from "../lib/controller/host.mjs";

// A WebSocket stand-in: opens on the next tick, records what is sent, lets a test push messages or drop the link.
class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url; this.sent = []; this.ls = {}; FakeWS.last = this;
    setTimeout(() => (FakeWS.failOpen ? this._emit("error", {}) : this._emit("open", {})), 0);
  }
  addEventListener(type, fn, opts) { (this.ls[type] ||= []).push({ fn, once: opts && opts.once }); }
  _emit(type, ev) { for (const l of [...(this.ls[type] || [])]) { if (l.once) this.ls[type] = this.ls[type].filter((x) => x !== l); l.fn(ev); } }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this._emit("close", {}); }
  message(o) { this._emit("message", { data: JSON.stringify(o) }); }
}
const FAST = { pingMs: 20, directionSettleMs: 1, rampSecondsPer01: 0.02, rampStepMs: 5, connectTimeoutMs: 200 };
const make = async (config = {}) => { FakeWS.failOpen = false; const c = new Controller({ host: "h", WebSocketImpl: FakeWS, config: { ...FAST, ...config } }); await c.connect(); return c; };
const cmds = (c, name) => FakeWS.last.sent.filter((m) => m.cmd === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("connects to ws://host:81 and pings to keep the link alive", async () => {
  const c = await make();
  assert.equal(FakeWS.last.url, "ws://h:81");
  await sleep(70);
  assert.ok(cmds(c, "ping").length >= 2);
  await c.close();
});

test("a failed connect rejects with the address in the message", async () => {
  FakeWS.failOpen = true;
  const c = new Controller({ host: "nowhere", WebSocketImpl: FakeWS, config: FAST });
  await assert.rejects(c.connect(), /connect failed \(ws:\/\/nowhere:81\)/);
});

test("setSpeed clamps to 0..1 and sends the value", async () => {
  const c = await make();
  c.setSpeed(0.05); c.setSpeed(-3);
  assert.deepEqual(cmds(c, "speed").map((m) => m.value), [0.05, 0]);
  assert.equal(c.speed, 0);
  await c.close();
});

test("motor care: no abrupt stop from above creep speed, but a straight stop from creep is fine", async () => {
  const c = await make();
  c.setSpeed(0.05); c.setSpeed(0.1);
  c.setSpeed(0);                                     // from creep: allowed
  c.setSpeed(0.1); c.setSpeed(0.3, { force: true }); // force bypasses the rule on purpose
  assert.throws(() => c.setSpeed(0), MotorCareError);
  assert.throws(() => c.setSpeed(0.1), MotorCareError);   // 0.3 -> 0.1 is a drop of 0.2, more than the creep limit
  c.setSpeed(0.25);                                   // a small step down is fine
  assert.equal(c.speed, 0.25);
  await c.close();
});

test("motor care: direction only changes from standstill or creep", async () => {
  const c = await make();
  c.setSpeed(0.2, { force: true });
  await assert.rejects(c.setDirection(false), MotorCareError);
  c.setSpeed(0.1, { force: true }); await c.setDirection(false);
  assert.equal(c.forward, false);
  assert.deepEqual(cmds(c, "direction").map((m) => m.value), [false]);
  await c.close();
});

test("rampTo steps monotonically, ends exactly on target and takes about the right time", async () => {
  const c = await make();
  const t0 = Date.now();
  const r = await c.rampTo(0.4);                      // 0.4 at 0.02 s per 0.1 = 80 ms
  const took = Date.now() - t0;
  const v = cmds(c, "speed").map((m) => m.value);
  assert.equal(r.completed, true);
  assert.equal(v[v.length - 1], 0.4);
  assert.ok(v.every((x, i) => i === 0 || x > v[i - 1]), `not monotonic: ${v}`);
  assert.ok(v.length >= 5, `too few steps: ${v.length}`);
  assert.ok(took >= 60 && took < 400, `took ${took} ms`);
  const down = await c.halt();
  assert.equal(down.completed, true);
  assert.equal(c.speed, 0);                           // the ramp, not a jump
  await c.close();
});

test("a new ramp cancels the one in progress", async () => {
  const c = await make({ rampSecondsPer01: 0.1 });
  const first = c.rampTo(1);
  await sleep(60);
  const second = await c.rampTo(0.1);
  assert.equal((await first).completed, false);
  assert.equal(second.completed, true);
  assert.equal(c.speed, 0.1);
  await c.close();
});

test("emergencyStop sends stop, cancels a ramp, and is never refused", async () => {
  const c = await make({ rampSecondsPer01: 0.1 });
  const ramp = c.rampTo(1);
  await sleep(40);
  c.emergencyStop();
  assert.equal((await ramp).completed, false);
  assert.equal(cmds(c, "stop").length, 1);
  assert.equal(c.speed, 0);
  const last = cmds(c, "speed").length;
  await sleep(50);
  assert.equal(cmds(c, "speed").length, last, "the ramp kept sending after the stop");
  await c.close();
});

test("guardedMove refuses to run without a guard, a time limit, or at more than creep speed", async () => {
  const c = await make();
  await assert.rejects(c.guardedMove({ forward: true, speed: 0.1, maxMs: 100 }), /no blind moves/);
  await assert.rejects(c.guardedMove({ forward: true, speed: 0.1, until: new Promise(() => {}) }), /maxMs/);
  await assert.rejects(c.guardedMove({ forward: true, speed: 0.3, until: new Promise(() => {}), maxMs: 100 }), MotorCareError);
  assert.equal(cmds(c, "speed").length, 0, "nothing should have been sent");
  await c.close();
});

test("guardedMove runs until the guard fires, then stops", async () => {
  const c = await make();
  let fire; const guard = new Promise((r) => { fire = r; });
  setTimeout(fire, 30);
  const r = await c.guardedMove({ forward: true, speed: 0.1, until: guard, maxMs: 1000 });
  assert.equal(r.result, "guard");
  const sp = cmds(c, "speed").map((m) => m.value);
  assert.deepEqual(sp, [0.1, 0]);
  assert.equal(c.speed, 0);
  await c.close();
});

test("guardedMove keeps going afterMs past the guard", async () => {
  const c = await make();
  const t0 = Date.now();
  const r = await c.guardedMove({ forward: true, speed: 0.1, until: Promise.resolve(), maxMs: 1000, afterMs: 60 });
  assert.equal(r.result, "guard");
  assert.ok(Date.now() - t0 >= 55);
  await c.close();
});

test("guardedMove stops on timeout and on an abort signal", async () => {
  const c = await make();
  const a = await c.guardedMove({ forward: false, speed: 0.1, until: new Promise(() => {}), maxMs: 30 });
  assert.equal(a.result, "timeout");
  assert.equal(c.speed, 0);
  const b = await c.guardedMove({ forward: true, speed: 0.1, until: new Promise(() => {}), abort: Promise.resolve(), maxMs: 1000 });
  assert.equal(b.result, "abort");
  assert.deepEqual(cmds(c, "speed").slice(-1)[0], { cmd: "speed", value: 0 });
  await c.close();
});

test("guardedMove takes a function guard and starts the guard before the loco moves", async () => {
  const c = await make();
  const order = [];
  const r = await c.guardedMove({ forward: true, speed: 0.1, maxMs: 1000, until: () => { order.push(`guard armed, ${cmds(c, "speed").length} speed cmds sent`); return Promise.resolve(); } });
  assert.equal(r.result, "guard");
  assert.deepEqual(order, ["guard armed, 0 speed cmds sent"]);
  await c.close();
});

test("losing the connection mid-move resolves the move as a disconnect", async () => {
  const c = await make();
  const events = []; c.on("disconnect", () => events.push("disconnect"));
  const mv = c.guardedMove({ forward: true, speed: 0.1, until: new Promise(() => {}), maxMs: 2000 });
  await sleep(20);
  FakeWS.last.close();
  assert.equal((await mv).result, "disconnect");
  assert.deepEqual(events, ["disconnect"]);
  assert.equal(c.connected, false);
  assert.throws(() => c.send({ cmd: "ping" }), /not connected/);
});

test("status reports are kept and re-emitted", async () => {
  const c = await make();
  const seen = []; c.on("status", (s) => seen.push(s.speed));
  FakeWS.last.message({ type: "status", name: "ztrain", speed: 0.5, direction: true, connected: true });
  FakeWS.last.message({ type: "pong" });
  assert.deepEqual(seen, [0.5]);
  assert.equal(c.status.name, "ztrain");
  await c.close();
});

test("turnAround ramps down, flips direction, and can resume", async () => {
  const c = await make();
  c.setSpeed(0.1, { force: true });
  await c.rampTo(0.3);
  await c.turnAround({ resume: true });
  assert.equal(c.forward, false);
  assert.equal(c.speed, 0.3);
  const seq = FakeWS.last.sent.filter((m) => m.cmd === "speed" || m.cmd === "direction");
  const dirAt = seq.findIndex((m) => m.cmd === "direction");
  assert.equal(seq[dirAt - 1].value, 0, "the loco must be at zero when the direction flips");
  await c.close();
});

test("findHost: TRAIN_HOST wins, then the resolved address, then the plain name", async () => {
  assert.equal(await findHost({ TRAIN_HOST: "10.0.0.5" }, async () => { throw new Error("unused"); }), "10.0.0.5");
  assert.equal(await findHost({}, async () => ({ address: "192.168.1.9" })), "192.168.1.9");
  assert.equal(await findHost({}, async () => { throw new Error("no mdns"); }), "ztrain.local");
});
