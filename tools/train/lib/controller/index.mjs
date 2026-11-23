// The train controller (Wemos D1 Mini, WebSocket on port 81) as a module.
//
//   const ctl = await connectController();            // host found automatically (lib/controller/host.mjs), or { host }
//   await ctl.setDirection(true);
//   await ctl.rampTo(0.32);                           // 1 s per 0.1 of throttle
//   await ctl.rampTo(0);
//   // A move that must stop on something (a beam event): the only way to move without ramping.
//   await ctl.guardedMove({ forward: true, speed: 0.1, until: sensor.waitFor("break"), maxMs: 8000 });
//   ctl.emergencyStop();                              // always allowed, never ramps
//   await ctl.close();
//
// The rules this module enforces, so scripts do not have to remember them:
//   motor care     a loco is never stopped or reversed abruptly above creep speed. setSpeed() to zero, or setDirection(),
//                  throws while the throttle is above `creepMax`; rampTo() and halt() are the normal ways down.
//   no blind moves guardedMove() will not start without a guard (a promise, or a function returning one), and it is limited
//                  to creep speed so the guard can stop it straight away. Cruise speeds belong in shows, with ramps.
//   keepalive      a ping every `pingMs` (the firmware stops the motor after 30 s of silence).
//   quiet stop     speed 0 is used for stopping, not {cmd:"stop"} (which blinks the LED magenta); that is emergencyStop().
//
// Events: "status" (the controller's own report), "disconnect", "error".
// Pass `WebSocketImpl` to test without hardware (any class with addEventListener, send and close).

import { EventEmitter } from "node:events";
import { findHost } from "./host.mjs";

export const CONTROLLER_DEFAULTS = {
  port: 81,
  pingMs: 5000,
  connectTimeoutMs: 5000,
  directionSettleMs: 300,   // the firmware needs a moment after a direction change
  creepMax: 0.10,           // up to here (about 2.4 in/s on the EF210) a straight stop or reversal is fine
  rampSecondsPer01: 1,      // ramps take this long per 0.1 of throttle
  rampStepMs: 100,
};

export class MotorCareError extends Error { constructor(m) { super(m); this.name = "MotorCareError"; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class Controller extends EventEmitter {
  constructor({ host, url, WebSocketImpl = globalThis.WebSocket, config = {} } = {}) {
    super();
    this.config = { ...CONTROLLER_DEFAULTS, ...config };
    this.url = url || `ws://${host}:${this.config.port}`;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null; this.connected = false;
    this.speed = 0; this.forward = true; this.status = null;   // last commanded throttle and direction, last report
    this._ping = null; this._ramp = null; this._rampId = 0;
  }

  async connect() {
    if (!this.WebSocketImpl) throw new Error("no WebSocket available (Node 22+ has one built in)");
    const ws = this.ws = new this.WebSocketImpl(this.url);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`connect timeout (${this.url})`)), this.config.connectTimeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); res(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); rej(new Error(`connect failed (${this.url})`)); }, { once: true });
    });
    this.connected = true;
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (m && m.type === "status") { this.status = m; this.emit("status", m); }
    });
    ws.addEventListener("close", () => this._gone());
    ws.addEventListener("error", (e) => { if (this.connected) this.emit("error", new Error("controller connection error")); });
    this._ping = setInterval(() => { if (this.connected) this.send({ cmd: "ping" }); }, this.config.pingMs);
    return this;
  }
  _gone() {
    if (!this.connected) return;
    this.connected = false; this.cancelRamp(); clearInterval(this._ping);
    this.emit("disconnect");
  }
  send(obj) {
    if (!this.connected) throw new Error("not connected to the controller");
    this.ws.send(JSON.stringify(obj));
  }

  /** Set the throttle directly. Dropping to zero (or by more than the creep limit) from above creep speed throws: use rampTo(). */
  setSpeed(v, { force = false } = {}) {
    v = clamp01(v);
    this.cancelRamp();
    this._speed(v, force);
  }
  _speed(v, force = false) {
    const c = this.config.creepMax;
    if (!force && this.speed > c && v < this.speed && (v === 0 || this.speed - v > c)) {
      throw new MotorCareError(`abrupt slow-down from ${this.speed.toFixed(2)} to ${v.toFixed(2)}: ramp down with rampTo() (creep speed is ${c})`);
    }
    this.send({ cmd: "speed", value: v });
    this.speed = v;
  }

  /** Change direction. Only from standstill or creep speed. Waits for the controller to settle. */
  async setDirection(forward) {
    if (this.speed > this.config.creepMax) throw new MotorCareError(`cannot reverse at throttle ${this.speed.toFixed(2)}: ramp to 0 first`);
    this.send({ cmd: "direction", value: !!forward });
    this.forward = !!forward;
    await sleep(this.config.directionSettleMs);
  }

  /** Ramp the throttle to `target` linearly, `rampSecondsPer01` per 0.1. Resolves { completed } (false if cancelled by a later call). */
  async rampTo(target, { secondsPer01 = this.config.rampSecondsPer01 } = {}) {
    target = clamp01(target);
    this.cancelRamp();
    const id = ++this._rampId;
    const from = this.speed, dist = Math.abs(target - from);
    if (dist < 1e-9) return { completed: true };
    const totalMs = (dist / 0.1) * secondsPer01 * 1000, step = this.config.rampStepMs;
    const steps = Math.max(1, Math.round(totalMs / step));
    this._ramp = true;
    for (let i = 1; i <= steps; i++) {
      await sleep(totalMs / steps);
      if (this._rampId !== id || !this.connected) return { completed: false };
      const v = i === steps ? target : from + ((target - from) * i) / steps;
      this.send({ cmd: "speed", value: +v.toFixed(4) }); this.speed = v;
    }
    if (this._rampId === id) this._ramp = null;
    return { completed: true };
  }
  cancelRamp() { this._rampId++; this._ramp = null; }

  /** Bring the loco to a quiet stop: ramp to zero. */
  halt(opts) { return this.rampTo(0, opts); }

  /** Stop now, whatever it is doing. Never ramps, never refuses. */
  emergencyStop() {
    this.cancelRamp();
    if (this.connected) this.send({ cmd: "stop" });
    this.speed = 0;
  }

  /** Reverse direction safely: ramp to zero, wait, flip, and (optionally) ramp back up. */
  async turnAround({ resume = false } = {}) {
    const was = this.speed;
    await this.halt();
    await this.setDirection(!this.forward);
    if (resume && was > 0) await this.rampTo(was);
  }

  /**
   * A move that stops on something: starts at `speed` (creep only), runs until the guard resolves, then stops quietly.
   *   until    a promise, or a function returning one (a beam event, a timer you trust)
   *   abort    optional promise that also stops the move (a lost sensor)
   *   maxMs    give up after this long (required: a guard that never fires must not leave the loco running)
   *   afterMs  keep going this long after the guard fires (to creep a little past a beam edge), then stop
   * Resolves { result: "guard" | "abort" | "timeout" | "disconnect", elapsedMs }.
   */
  async guardedMove({ forward, speed, until, abort = null, maxMs, afterMs = 0 }) {
    if (!until) throw new Error("guardedMove needs a guard (until): no blind moves");
    if (!(maxMs > 0)) throw new Error("guardedMove needs maxMs");
    if (!(speed > 0) || speed > this.config.creepMax) throw new MotorCareError(`guardedMove is for creep speeds (up to ${this.config.creepMax}), not ${speed}`);
    const guard = typeof until === "function" ? until() : until;
    await this.setDirection(forward);
    const t0 = Date.now();
    const gone = new Promise((res) => { const f = () => res("disconnect"); this.once("disconnect", f); this._offGone = () => this.off("disconnect", f); });
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res("timeout"), maxMs); });
    this.cancelRamp(); this.send({ cmd: "speed", value: speed }); this.speed = speed;
    let result;
    try {
      const racers = [Promise.resolve(guard).then(() => "guard"), timeout, gone];
      if (abort) racers.push(Promise.resolve(abort).then(() => "abort"));
      result = await Promise.race(racers);
      if (result === "guard" && afterMs > 0) await sleep(afterMs);
    } finally {
      clearTimeout(timer); if (this._offGone) this._offGone();
      if (this.connected) { this.send({ cmd: "speed", value: 0 }); this.speed = 0; }
    }
    return { result, elapsedMs: Date.now() - t0 };
  }

  async close() {
    clearInterval(this._ping); this.cancelRamp();
    if (this.connected) { await sleep(100); this.connected = false; this.ws.close(); }
  }
}

/** Connect to the controller. With no options, the host comes from findHost() (TRAIN_HOST, else ztrain.local). */
export async function connectController(opts = {}) {
  let { host } = opts;
  if (!host && !opts.url) host = await findHost();
  return new Controller({ ...opts, host }).connect();
}
