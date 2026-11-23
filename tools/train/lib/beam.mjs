// Beam edge tracker: turns the raw A0 stream into "fall" / "rise" / "pass" events.
//
// A sample is { t, h, v }: t = sensor clock in ms, h = host clock in ms, v = A0 reading.
//   fall  - the beam drops (the leading edge of something arriving)
//   rise  - the beam recovers (the trailing edge leaving)
//   pass  - emitted ~100 ms after a rise: timing and signature of the whole object
// Moving forward a fall is the nose and a rise is the tail; reversing, the other way round.

import { EventEmitter } from "node:events";
import { LEVELS } from "./levels.mjs";

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export class BeamTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.holdMs = opts.holdMs ?? 600;            // flat time that counts as a clear beam
    this.plateauMin = opts.plateauMin ?? LEVELS.plateauMin;
    this.plateauSpread = opts.plateauSpread ?? LEVELS.plateauSpread;
    this.fallDrop = opts.fallDrop ?? LEVELS.noseDrop;         // a fall starts this far below the clear level
    this.fallConfirm = opts.fallConfirm ?? LEVELS.trip;  // and is confirmed by a reading below this
    this.upThreshold = opts.upThreshold ?? null; // rise level; null = clear level - 5
    this.rearmSamples = opts.rearmSamples ?? 10; // flat samples needed to re-arm after a rise
    this.samples = [];
    this.state = "init";                         // init -> clear -> blocked -> rising -> clear
    this.clearLevel = 0;
    this._pendingFall = -1;
    this._fallIdx = -1;
    this._upCount = 0;
    this._rearm = 0;
    this._relapse = 0;
    this._pass = null;
  }

  // Start with the loco already sitting in the beam: assume the given clear level, wait for the tail to leave.
  // No pass is reported for that first partial crossing.
  primeBlocked(clearLevel) { this.clearLevel = clearLevel; this.state = "blocked"; this._fallIdx = -1; this._upCount = 0; }

  get upLevel() { return this.upThreshold ?? this.clearLevel - 5; }

  _window(i, ms) {
    const S = this.samples, out = [];
    for (let k = i; k >= 0 && S[i].t - S[k].t <= ms; k--) out.push(S[k]);
    return out;
  }

  _plateau(i) {
    const w = this._window(i, this.holdMs);
    if (w.length < 5 || w[0].t - w[w.length - 1].t < this.holdMs * 0.9) return null;
    const vs = w.map((x) => x.v);
    return Math.min(...vs) >= this.plateauMin && Math.max(...vs) - Math.min(...vs) <= this.plateauSpread ? median(vs) : null;
  }

  push(s) {
    const S = this.samples, i = S.length;
    S.push(s);
    const v = s.v;
    if (this._pass && i >= this._pass.riseIdx + 5) this._finishPass();

    if (this.state === "init") {
      const level = this._plateau(i);
      if (level != null) { this.clearLevel = level; this.state = "clear"; this.emit("ready", level); }
      return;
    }
    if (this.state === "clear") {
      const level = this._plateau(i);
      if (level != null) this.clearLevel = level;
      if (this._pendingFall < 0 && v < this.clearLevel - this.fallDrop) this._pendingFall = i;
      if (this._pendingFall >= 0) {
        if (v < this.fallConfirm) {
          this._fallIdx = this._pendingFall; this._pendingFall = -1;
          this.state = "blocked"; this._upCount = 0;
          this.emit("fall", { idx: this._fallIdx, t: S[this._fallIdx].t, h: S[this._fallIdx].h });
        } else if (i - this._pendingFall >= 3) this._pendingFall = -1;
      }
      return;
    }
    if (this.state === "blocked") {
      if (v >= this.upLevel) {
        this._upCount++;
        if (this._upCount === 2 && i - 1 - this._fallIdx >= 3) {
          const riseIdx = i - 1;
          this.state = "rising"; this._rearm = 0; this._relapse = 0;
          this._pass = this._fallIdx >= 0 ? { fallIdx: this._fallIdx, riseIdx } : null;
          this.emit("rise", { idx: riseIdx, t: S[riseIdx].t, h: S[riseIdx].h });
        }
      } else this._upCount = 0;
      return;
    }
    if (this.state === "rising") {
      if (v >= this.clearLevel - 12) { this._rearm++; this._relapse = 0; if (this._rearm >= this.rearmSamples) this.state = "clear"; }
      else {
        this._rearm = 0;
        if (v < this.clearLevel - this.fallDrop && ++this._relapse >= 2) { this.state = "blocked"; this._upCount = 0; this._pass = null; }
      }
    }
  }

  // Time (sensor ms) at which the signal crossed halfway between the clear level and the local low.
  _crossFall(fi) {
    const S = this.samples, clear = this.clearLevel;
    let low = Infinity;
    for (let k = fi; k <= Math.min(fi + 6, S.length - 1); k++) low = Math.min(low, S[k].v);
    const mid = (clear + low) / 2;
    for (let k = Math.max(fi - 2, 1); k <= Math.min(fi + 6, S.length - 1); k++) {
      if (S[k].v < mid && S[k - 1].v >= mid) { const a = S[k - 1], b = S[k]; return a.t + ((a.v - mid) / (a.v - b.v)) * (b.t - a.t); }
    }
    return S[fi].t;
  }
  _crossRise(ri) {
    const S = this.samples, clear = this.clearLevel;
    let low = Infinity;
    for (let k = Math.max(ri - 6, 0); k <= ri; k++) low = Math.min(low, S[k].v);
    const mid = (clear + low) / 2;
    for (let k = Math.min(ri + 3, S.length - 2); k >= Math.max(ri - 6, 0); k--) {
      if (S[k].v < mid && S[k + 1].v >= mid) { const a = S[k], b = S[k + 1]; return a.t + ((mid - a.v) / (b.v - a.v)) * (b.t - a.t); }
    }
    return S[ri].t;
  }

  _finishPass() {
    const { fallIdx, riseIdx } = this._pass; this._pass = null;
    const S = this.samples;
    const fallT = this._crossFall(fallIdx), riseT = this._crossRise(riseIdx);
    const all = S.slice(fallIdx, riseIdx + 1).map((x) => x.v);
    const inside = S.slice(fallIdx + 5, Math.max(fallIdx + 5, riseIdx - 4)).map((x) => x.v);
    this.emit("pass", {
      fallT, riseT, dt: riseT - fallT,                       // ms, sensor clock
      fallH: S[fallIdx].h, riseH: S[riseIdx].h,              // host clock
      minLevel: Math.min(...all),
      maxInside: inside.length ? Math.max(...inside) : Math.min(...all),
      meanInside: inside.length ? inside.reduce((a, b) => a + b, 0) / inside.length : Math.min(...all),
      clearLevel: this.clearLevel,
    });
  }
}
