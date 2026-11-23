// Sound effects played on this Mac with afplay. Files live in ./sounds (git-ignored): generated ones are written on
// first use, and `python3 -I import-sounds.py` pulls real recordings from the sibling e235-sounds and eki-pi projects.
// A file that already exists is always used, so dropping your own over a name replaces it.
//
//   const snd = new Sounds({ volume: 0.5 });
//   snd.once("horn");                      // one-shot
//   snd.loop("hum");  snd.stopLoop();      // the main loop slot (hum, cruise whine, creep whine)
//   snd.rail(1.2, 0.2);  snd.stopRail();   // the rail-joint clatter, re-timed to the train's speed
//   snd.stopAll();

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as synth from "./synth.mjs";

const DIR = fileURLToPath(new URL("../sounds/", import.meta.url));

const STATIC = {
  horn: () => synth.horn(),
  bell: () => synth.crossingBell(),
  air: () => synth.airRelease(),
  chime: () => synth.chime(),
  hum: () => synth.blowerHum(30),
  horn_air: () => synth.hornAir(),
  horn_electric: () => synth.hornElectric(),
  horn_low: () => synth.hornLow(),
};

export class Sounds {
  constructor({ volume = 0.5, enabled = true } = {}) {
    this.volume = volume; this.enabled = enabled && process.platform === "darwin";
    this.children = new Set(); this.slots = new Map();
    mkdirSync(DIR, { recursive: true });
  }
  _file(name, make) {
    const mp3 = `${DIR}${name}.mp3`;
    if (existsSync(mp3)) return mp3;
    const p = `${DIR}${name}.wav`;
    if (!existsSync(p)) {
      if (!make) throw new Error(`no sound file ${p}; run: python3 -I import-sounds.py`);
      synth.writeWav(p, make());
    }
    return p;
  }
  _play(path, volume, rate, seconds) {
    if (!this.enabled) return null;
    const args = ["-v", String(volume ?? this.volume)];
    if (rate && Math.abs(rate - 1) > 0.01) args.push("-r", String(rate), "-q", "1");   // -q 1: change the tempo, keep the pitch
    if (seconds) args.push("-t", String(seconds));
    const c = spawn("afplay", [...args, path], { stdio: "ignore" });
    this.children.add(c);
    c.on("exit", () => this.children.delete(c));
    c.on("error", () => { this.enabled = false; });
    return c;
  }

  // ---- loop slots: a looped file; a new start replaces the old one with a short overlap (fine for noise-like sounds) ----
  _start(slot, path, volume, rate) {
    const old = this.slots.get(slot);
    const s = { path, volume, rate, child: null, want: true };
    this.slots.set(slot, s);
    const run = () => {
      s.child = this._play(path, volume, rate);
      if (s.child) s.child.on("exit", () => { if (s.want && this.slots.get(slot) === s) run(); });   // files are ~30 s: restart if a show outlasts one
    };
    run();
    if (old) { old.want = false; const c = old.child; if (c) setTimeout(() => c.kill("SIGTERM"), 90); }
  }
  _stop(slot) { const s = this.slots.get(slot); if (s) { s.want = false; if (s.child) s.child.kill("SIGTERM"); this.slots.delete(slot); } }

  prepare(extra = []) {
    for (const [n, make] of Object.entries(STATIC)) this._file(n, make);
    for (const f of extra) this.cruiseFile(f);
  }
  // Throws if a file is missing, so a show can check its whole set before it starts.
  need(names) { for (const n of names) this._file(n, STATIC[n]); }
  once(name, volume, seconds) { return this._play(this._file(name, STATIC[name]), volume, null, seconds); }
  cruiseFile(freq) { const f = Math.round(freq); return this._file(`whine_${f}`, () => synth.inverterLoop(f, 30)); }
  sweepFile(dur, f0, f1) { const k = `sweep_${Math.round(f0)}_${Math.round(f1)}_${dur.toFixed(2)}`; return this._file(k, () => synth.inverterSweep(dur, f0, f1)); }
  sweep(dur, f0, f1, volume) { return this._play(this.sweepFile(dur, f0, f1), volume); }
  loop(name, volume) { this._start("main", this._file(name, STATIC[name]), volume); }
  cruise(freq, volume) { this._start("main", this.cruiseFile(freq), volume); }
  stopLoop() { this._stop("main"); }

  // The rail-joint clatter: re-timed to the train's speed. Only restarts when the rate moved by more than ~8%.
  rail(rate, volume) {
    const r = Math.min(2.2, Math.max(0.4, rate)), s = this.slots.get("rail");
    if (s && Math.abs(s.rate - r) / s.rate < 0.08 && s.volume === volume) return;
    this._start("rail", this._file("railloop"), volume, r);
  }
  stopRail() { this._stop("rail"); }

  stopAll() { for (const slot of [...this.slots.keys()]) this._stop(slot); for (const c of this.children) c.kill("SIGTERM"); this.children.clear(); }
}
