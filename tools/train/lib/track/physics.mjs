// A model of the track for dry runs and tests: a loop, a loco on it, and a beam sensor that behaves like the real one.
//
//   const track = new PhysicsTrack({ clock, controller, loco, loopIn: 134, nose: 0 });   // controller: or a function returning the current one
//   track.state / track.waitFor("break") / track.on("pass", ...)         the same interface as lib/sensor's Sensor
//   track.noseIn                                                          where the nose is, in inches past the beam
//
// The loco's speed comes from the controller's commanded throttle through the loco's speed model (no inertia: creep speeds
// stop and start at once), and the position is integrated on the clock, so the beam breaks where the geometry says and
// when the speed says. Unlike lib/show's GhostSensor (which answers after a fixed delay), a loco that is still slowing when
// it reaches the beam really overshoots it here.
//
// Geometry: the beam is at 0. The nose is `noseIn` inches past it along the direction of travel; the body covers
// [noseIn - lengthIn, noseIn], so the beam is blocked while 0 <= noseIn <= lengthIn (mod the loop). Going forward, the nose
// breaks the beam and the tail restores it; in reverse, the tail breaks it and the nose restores it.
//
// Faults for tests: `stuck` (something else always blocks the beam) and `deaf` (the sensor never reports a change).

import { EventEmitter } from "node:events";
import { speedModel } from "../show/position.mjs";

const CLEAR = 324, BLOCKED = 32;

export class PhysicsTrack extends EventEmitter {
  constructor({ clock, controller, loco, loopIn = 134, nose = 0, tickMs = 20, stuck = false, deaf = false }) {
    super();
    Object.assign(this, { clock, loopIn, tickMs, stuck, deaf });
    this._ctl = typeof controller === "function" ? controller : () => controller;   // a function: the controller of the moment (or null: not moving)
    this.lengthIn = loco.lengthIn;
    this.speed = speedModel(loco);
    this.pos = nose;                       // nose position, inches past the beam (unwrapped; see noseIn)
    this.direction = null;
    this.distanceIn = 0;                   // total distance travelled, whichever way
    this._blocked = this._isBlocked();
    this._t0 = null; this._h0 = null;
    this._stopped = false;
    this._loop();
  }

  get noseIn() { return ((this.pos % this.loopIn) + this.loopIn) % this.loopIn; }
  _isBlocked() { return this.stuck || this.noseIn <= this.lengthIn; }
  get state() { return this._blocked ? "blocked" : "clear"; }
  get lastReading() { return this._blocked ? BLOCKED : CLEAR; }
  get lastSampleAgeMs() { return 0; }
  setDirection(d) { this.direction = d; }
  stop() { this._stopped = true; }

  async _loop() {
    let last = this.clock.now();
    while (!this._stopped) {
      await this.clock.sleep(this.tickMs);
      const now = this.clock.now(), dt = (now - last) / 1000; last = now;
      const c = this._ctl();
      const v = c ? this.speed(c.speed) * dt : 0;                       // inches this tick
      const d = c && !c.forward ? -v : v;
      this.pos += d; this.distanceIn += Math.abs(d);
      const blocked = this._isBlocked();
      if (blocked !== this._blocked) { this._blocked = blocked; if (!this.deaf) this._edge(blocked, now); }
    }
  }

  _edge(blocked, now) {
    const c = this._ctl(), fwd = c ? c.forward : true;
    const edge = blocked ? (fwd ? "nose" : "tail") : (fwd ? "tail" : "nose");
    const name = blocked ? "break" : "restore";
    const ev = { t: now, h: now, edge, ...(blocked ? { level: BLOCKED } : {}) };
    if (blocked) { this._t0 = now; this._h0 = now; }
    this.emit(name, ev); this.emit(edge, ev);
    if (!blocked && this._t0 !== null) {
      const t0 = this._t0; this._t0 = null;
      this.emit("pass", { t0, t1: now, durationMs: now - t0, minLevel: BLOCKED, meanLevel: BLOCKED, maxLevel: BLOCKED, h0: this._h0, h1: now, direction: this.direction, firstEdge: fwd ? "tail" : "nose", clearLevel: CLEAR });
    }
  }

  /** Resolves with the event, or rejects after timeoutMs of clock time (like lib/sensor's waitFor). */
  waitFor(event, { timeoutMs = 30000, filter = () => true } = {}) {
    return new Promise((resolve, reject) => {
      let done = false;
      const on = (e) => { if (done || !filter(e)) return; done = true; this.off(event, on); resolve(e); };
      this.on(event, on);
      this.clock.sleep(timeoutMs).then(() => { if (done) return; done = true; this.off(event, on); reject(new Error(`timed out after ${timeoutMs} ms waiting for ${event}`)); });
    });
  }
}
