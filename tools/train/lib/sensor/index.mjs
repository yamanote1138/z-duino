// The sensor: a source of readings, a detector that turns them into events, and calibration.
//
//   import { createSensor } from "./lib/sensor/index.mjs";
//   const sensor = createSensor({ source: new SerialSource({ port }) });      // levels come from the calibration file
//   sensor.on("pass", (p) => console.log(p.durationMs));
//   await sensor.start();
//   sensor.setDirection("forward");                  // optional: adds nose/tail labels to events
//   const p = await sensor.waitFor("pass", { timeoutMs: 20000 });
//
// Events: everything the Detector emits (ready, break, restore, nose, tail, pass, drift), plus
//   lost { sinceMs }   no readings for staleMs: the cable, the board or the port is gone
//   recovered          readings are flowing again
//   sample             every raw reading (only if `emitSamples` is set; there are about 50 a second)
//   error              the source failed
// Config (all optional): see DETECTOR_DEFAULTS in detector.mjs, plus staleMs (default 400) and keepMs (default 6000, how much
// recent history `recent()` and `collect()` can see).

import { EventEmitter } from "node:events";
import { Detector } from "./detector.mjs";
import { loadLevels, DEFAULT_FILE, calibrate as runCalibration } from "./calibration.mjs";

export { Detector, DETECTOR_DEFAULTS } from "./detector.mjs";
export { loadLevels, saveLevels, measure, deriveLevels, summarize, DEFAULT_FILE } from "./calibration.mjs";
export { SerialSource } from "./sources/serial.mjs";
export { ReplaySource } from "./sources/replay.mjs";

class Sensor extends EventEmitter {
  constructor({ source, levels, calibrationFile = DEFAULT_FILE, config = {}, emitSamples = false }) {
    super();
    const lv = levels || loadLevels(calibrationFile);
    if (!lv) throw new Error(`no calibration: run \`node calibrate.mjs\` (looked for ${calibrationFile}), or pass levels: { clear, blocked }`);
    this.source = source; this.calibrationFile = calibrationFile; this.emitSamples = emitSamples;
    this.cfg = { staleMs: 400, keepMs: 6000, ...config };
    this.detector = new Detector({ levels: lv, config });
    for (const ev of ["ready", "break", "restore", "nose", "tail", "pass", "drift"]) this.detector.on(ev, (e) => this.emit(ev, e));
    this._recent = []; this._lastH = 0; this._lost = false; this._watch = null; this._started = false;
  }

  get state() { return this._lost ? "lost" : this.detector.state; }
  get levels() { return this.detector.levels; }
  get thresholds() { return this.detector.thresholds; }
  get clearLevel() { return this.detector.clearLevel; }
  get lastReading() { return this._recent.at(-1)?.v ?? null; }
  get lastSampleAgeMs() { return this._lastH ? Date.now() - this._lastH : Infinity; }

  setDirection(d) { this.detector.setDirection(d); }
  setLevels(l) { this.detector.setLevels(l); }

  async start() {
    if (this._started) return;
    this._started = true;
    this.source.start((s) => this._onSample(s), (e) => this.emit("error", e));
    this._watch = setInterval(() => {
      if (!this._lastH) return;
      const age = Date.now() - this._lastH;
      if (!this._lost && age > this.cfg.staleMs) { this._lost = true; this.emit("lost", { sinceMs: age }); }
    }, Math.max(50, Math.floor(this.cfg.staleMs / 4)));
    this._watch.unref?.();
  }
  stop() { this._started = false; clearInterval(this._watch); this.source.stop(); }

  _onSample(s) {
    this._lastH = Date.now();
    if (this._lost) { this._lost = false; this.emit("recovered"); }
    this._recent.push(s);
    while (this._recent.length && s.t - this._recent[0].t > this.cfg.keepMs) this._recent.shift();
    if (this.emitSamples) this.emit("sample", s);
    this.detector.push(s);
  }

  /** The last `n` readings (or all of the recent history). */
  recent(n = Infinity) { return n >= this._recent.length ? [...this._recent] : this._recent.slice(-n); }

  /** Readings gathered over the next `ms` (resolves with the samples). */
  collect(ms) {
    return new Promise((resolve) => {
      const got = [], on = (s) => got.push(s), prev = this.emitSamples;
      this.emitSamples = true; this.on("sample", on);
      setTimeout(() => { this.off("sample", on); this.emitSamples = prev; resolve(got); }, ms);
    });
  }

  /** Resolves with the event's payload; rejects on timeout, or if the sensor is lost first. */
  waitFor(event, { timeoutMs = 30000, filter = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); this.off(event, on); this.off("lost", onLost); fn(v); };
      const on = (e) => { if (filter(e)) done(resolve, e); };
      const onLost = () => done(reject, new Error(`sensor lost while waiting for ${event}`));
      const timer = setTimeout(() => done(reject, new Error(`timed out after ${timeoutMs} ms waiting for ${event}`)), timeoutMs);
      this.on(event, on); this.on("lost", onLost);
    });
  }

  /** Measure the clear and blocked levels and save them. See calibration.mjs. */
  calibrate(opts) { return runCalibration(this, { file: this.calibrationFile, ...opts }); }
}

export function createSensor(opts) { return new Sensor(opts); }
