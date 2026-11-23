// Where the nose is, in inches past the beam along the direction of travel, estimated from the throttle and anchored
// by the sensor: a nose edge (the beam breaking as the nose arrives, or restoring as it leaves) means x = 0, a tail
// edge means x = loco length. Between edges the position is the integral of the speed model, so it is an estimate
// (good to about an inch at creep; it drifts at speed), which is why shows use zones for effects, never for stopping.

/** in/s as a function of throttle, from a loco profile ({ fit: { inPerSecPerUnitThrottle, offsetInS } } or { points }). */
export function speedModel(profile) {
  const pts = (profile && profile.points ? [...profile.points].sort((a, b) => a.thr - b.thr) : []);
  const fit = profile && profile.fit;
  return (thr) => {
    if (thr <= 0) return 0;
    if (pts.length >= 2 && thr >= pts[0].thr && thr <= pts[pts.length - 1].thr) {
      for (let i = 1; i < pts.length; i++) if (thr <= pts[i].thr) { const a = pts[i - 1], b = pts[i]; return a.v + ((b.v - a.v) * (thr - a.thr)) / (b.thr - a.thr); }
    }
    if (fit) return Math.max(0, fit.inPerSecPerUnitThrottle * thr + fit.offsetInS);
    throw new Error("no speed model: the loco profile has neither points nor a fit (run learn-loco.mjs)");
  };
}

export class Position {
  /** @param getMotion () => ({ thr, forward })  @param now () => ms */
  constructor({ speed, lengthIn, loopIn = null, getMotion, now }) {
    Object.assign(this, { speed, lengthIn, loopIn, getMotion, nowFn: now });
    this._x = null; this._t = null; this._m = null;
  }
  get known() { return this._x !== null; }
  update() {
    const t = this.nowFn(), m = this.getMotion();
    if (this._x !== null && this._m) this._x += (this._m.forward ? 1 : -1) * this.speed(this._m.thr) * ((t - this._t) / 1000);
    this._t = t; this._m = m;
    return this._x;
  }
  get x() { return this.update(); }
  anchor(x) { this.update(); this._x = x; }
  /** Anchor from a sensor event ({ edge: "nose" | "tail" }); events without an edge label are ignored. */
  anchorEdge(edge) { if (edge === "nose") this.anchor(0); else if (edge === "tail") this.anchor(this.lengthIn); }

  /** The nose position to wait for, given the zone edge, moving in the current direction; wraps by the loop length if there is one. */
  target(point, forward) {
    const x = this.x;
    if (!this.loopIn) return point;
    return forward ? point + Math.ceil((x - point) / this.loopIn - 1e-9) * this.loopIn : point - Math.ceil((point - x) / this.loopIn - 1e-9) * this.loopIn;
  }
}

/** Is the nose inside the zone now (a zone is { fromIn, toIn }, nose positions)? */
export function inZone(x, zone, loopIn = null) {
  const m = (v) => (loopIn ? ((v % loopIn) + loopIn) % loopIn : v);
  return loopIn ? m(x) >= zone.fromIn && m(x) <= zone.toIn : x >= zone.fromIn && x <= zone.toIn;
}
