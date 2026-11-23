// A sample source that plays back recorded or synthetic readings. For tests, demos and developing without hardware.
//   new ReplaySource({ samples: [{t, v}, ...], realtime: false })
//   ReplaySource.fromCsv(path)   one "seconds,reading" per line (the format light-test and capture scripts write)
import { readFileSync } from "node:fs";

export class ReplaySource {
  constructor({ samples, realtime = false, speed = 1 }) { this.samples = samples; this.realtime = realtime; this.speed = speed; this._timers = []; }
  static fromCsv(path) {
    const samples = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { const [s, v] = l.split(","); return { t: Number(s) * 1000, v: Number(v) }; });
    return new ReplaySource({ samples });
  }
  start(onSample) {
    const t0 = this.samples[0]?.t ?? 0, h0 = Date.now();
    this.samples.forEach((s, i) => {
      const emit = () => onSample({ t: s.t, h: this.realtime ? Date.now() : h0 + (s.t - t0), v: s.v });
      if (this.realtime) this._timers.push(setTimeout(emit, (s.t - t0) / this.speed)); else this._timers.push(setImmediate(emit));
    });
  }
  stop() { for (const t of this._timers) { clearTimeout(t); clearImmediate(t); } this._timers = []; }
}
