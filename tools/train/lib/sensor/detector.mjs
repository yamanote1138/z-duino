// Turns a stream of beam readings into events. Pure logic: no hardware, no timers, no files, so it can be tested by replay.
//
// A sample is { t, h, v }: t = the source's clock in ms (sensor clock if it has one), h = host clock in ms, v = reading.
// Levels come from calibration: { clear, blocked }. Everything else is a fraction of the span between them, so the same
// config works for any emitter, receiver, resistor or distance.
//
// Events:
//   ready    { state, level }                  first sample seen
//   break    { t, h, level, edge }             the beam was broken (edge is "nose"/"tail" only if the direction is known)
//   restore  { t, h, edge }                    the beam is open again
//   nose / tail                                 the same two events, named, when the direction is known
//   pass     { t0, t1, durationMs, minLevel, meanLevel, direction, firstEdge }   one object crossed the beam
//   drift    { kind: "low"|"high"|"noisy"|"partial", estimate, calibrated, sd }   the open-beam level no longer matches calibration.
//            "partial" = the beam sits steadily between blocked and clear: something is half in it, or the clear level has sagged
//            (the sensor cannot tell which, but a solid object reads near the blocked level, so this is worth a look)

import { EventEmitter } from "node:events";

export const DETECTOR_DEFAULTS = {
  breakFrac: 0.7,        // a reading below blocked + breakFrac x span counts as "low" (beam broken)
  restoreFrac: 0.8,      // at or above blocked + restoreFrac x span counts as "open" (a gap between the two avoids chatter)
  breakSamples: 2,       // consecutive low readings that break the beam (one stray sample is noise, not a train)
  restoreSamples: 3,     // consecutive open readings that restore it
  estimateWindowMs: 2000,   // window of open-beam readings used to estimate the clear level
  driftFrac: 0.2,        // the clear estimate this far from the calibrated level (as a fraction of it) is drift
  driftAfterMs: 4000,    // ...once the beam has been steady-open this long
  partialFrac: 0.3,      // a steady reading above blocked + partialFrac x span, yet below the break level, is "partial"
  noisyFrac: 0.1,        // open-beam standard deviation above this fraction of the span is "noisy"
  maxPassSamples: 4000,  // a pass longer than this many samples is dropped (a stuck loco, not a crossing)
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

export class Detector extends EventEmitter {
  constructor({ levels, config = {} }) {
    super();
    this.cfg = { ...DETECTOR_DEFAULTS, ...config };
    this.setLevels(levels);
    this.state = "init";          // init -> clear <-> blocked
    this.direction = null;        // "forward" | "reverse" | null
    this._low = 0; this._high = 0; this._lowStart = null; this._prev = null;
    this._pass = null;            // samples since just before the current break, or null if it began before we were watching
    this._clearBuf = [];          // recent open-beam readings
    this._steadySince = null;     // when the beam last became steadily open
    this._driftKind = null;
    this._blockBuf = []; this._blockedSince = null; this._partialFlagged = false;
  }

  setLevels(levels) {
    if (!(levels && levels.clear > levels.blocked)) throw new Error(`bad levels ${JSON.stringify(levels)}: clear must be above blocked`);
    this.levels = { clear: levels.clear, blocked: levels.blocked };
  }
  get thresholds() {
    const { clear, blocked } = this.levels, span = clear - blocked;
    return { clear, blocked, span, break: blocked + this.cfg.breakFrac * span, restore: blocked + this.cfg.restoreFrac * span };
  }
  /** The open-beam level as measured lately, or the calibrated one if nothing recent. */
  get clearLevel() { return this._clearBuf.length >= 5 ? median(this._clearBuf.map((x) => x.v)) : this.levels.clear; }
  setDirection(d) {
    if (d !== null && d !== "forward" && d !== "reverse") throw new Error(`direction must be "forward", "reverse" or null, not ${d}`);
    this.direction = d;
  }
  _edge(isBreak) {
    if (!this.direction) return null;
    const first = this.direction === "forward" ? "nose" : "tail";   // the leading end arrives first
    const second = first === "nose" ? "tail" : "nose";
    return isBreak ? first : second;
  }

  push(s) {
    const th = this.thresholds, v = s.v, prev = this._prev;
    this._prev = s;
    if (this.state === "init") {
      this.state = v >= th.break ? "clear" : "blocked";
      if (this.state === "blocked") this._blockedSince = s.t;
      this.emit("ready", { state: this.state, level: v });
      if (this.state === "clear") this._steadySince = s.t;
      return;
    }
    if (this.state === "clear") {
      if (v >= th.break) this._pushClear(s);
      if (v < th.break) {
        if (this._low++ === 0) this._lowStart = { before: prev, first: s };
        this._steadySince = null;
        if (this._low >= this.cfg.breakSamples) this._break(s);
      } else this._low = 0;
      return;
    }
    // blocked
    this._watchPartial(s);
    if (this._pass) { this._pass.push(s); if (this._pass.length > this.cfg.maxPassSamples) this._pass = null; }
    if (v >= th.restore) { if (++this._high >= this.cfg.restoreSamples) this._restore(s); } else this._high = 0;
  }

  _break(s) {
    const { before, first } = this._lowStart;
    this.state = "blocked"; this._high = 0; this._low = 0; this._blockBuf = []; this._blockedSince = first.t; this._partialFlagged = false;
    this._pass = [before, first].filter(Boolean);
    if (s !== first) this._pass.push(s);
    const edge = this._edge(true);
    const ev = { t: first.t, h: first.h, level: first.v, edge };
    this.emit("break", ev);
    if (edge) this.emit(edge, ev);
  }

  _restore(s) {
    this.state = "clear"; this._high = 0; this._low = 0; this._steadySince = s.t;
    const edge = this._edge(false);
    const ev = { t: s.t, h: s.h, edge };
    this.emit("restore", ev);
    if (edge) this.emit(edge, ev);
    if (this._pass) {
      const p = this._pass; this._pass = null;
      this.emit("pass", this._summarise(p, s));
    }
  }

  _summarise(S, last) {
    const clear = this.clearLevel, vs = S.map((x) => x.v), min = Math.min(...vs), mid = (clear + min) / 2;
    let fall = S[1]?.t ?? S[0].t, rise = last.t;
    for (let k = 1; k < S.length; k++) if (S[k].v < mid && S[k - 1].v >= mid) { const a = S[k - 1], b = S[k]; fall = a.t + ((a.v - mid) / (a.v - b.v)) * (b.t - a.t); break; }
    for (let k = S.length - 2; k >= 0; k--) if (S[k].v < mid && S[k + 1].v >= mid) { const a = S[k], b = S[k + 1]; rise = a.t + ((mid - a.v) / (b.v - a.v)) * (b.t - a.t); break; }
    const inside = S.filter((x) => x.t >= fall && x.t <= rise).map((x) => x.v);
    return { t0: fall, t1: rise, durationMs: rise - fall, minLevel: min, meanLevel: inside.length ? mean(inside) : min,
             direction: this.direction, firstEdge: this._edge(true), clearLevel: clear };
  }

  _watchPartial(s) {
    const th = this.thresholds, buf = this._blockBuf;
    buf.push(s);
    while (buf.length && s.t - buf[0].t > this.cfg.estimateWindowMs) buf.shift();
    if (this._partialFlagged || s.t - this._blockedSince < this.cfg.driftAfterMs || buf.length < 20) return;
    const vs = buf.map((x) => x.v), est = median(vs);
    if (est >= th.blocked + this.cfg.partialFrac * th.span && sd(vs) < this.cfg.noisyFrac * th.span) {
      this._partialFlagged = true;
      this.emit("drift", { kind: "partial", estimate: est, calibrated: this.levels.clear, sd: sd(vs) });
    }
  }

  _pushClear(s) {
    this._clearBuf.push(s);
    while (this._clearBuf.length && s.t - this._clearBuf[0].t > this.cfg.estimateWindowMs) this._clearBuf.shift();
    if (this._steadySince == null) this._steadySince = s.t;
    if (s.t - this._steadySince < this.cfg.driftAfterMs || this._clearBuf.length < 20) return;
    const vs = this._clearBuf.map((x) => x.v), est = median(vs), cal = this.levels.clear, th = this.thresholds;
    let kind = null;
    if (est < cal * (1 - this.cfg.driftFrac)) kind = "low";
    else if (est > cal * (1 + this.cfg.driftFrac)) kind = "high";
    else if (sd(vs) > this.cfg.noisyFrac * th.span) kind = "noisy";
    if (kind && kind !== this._driftKind) { this._driftKind = kind; this.emit("drift", { kind, estimate: est, calibrated: cal, sd: sd(vs) }); }
    else if (!kind) this._driftKind = null;
  }
}
