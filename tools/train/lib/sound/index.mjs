// The sound library: packs of sounds, picked by id or category, with variation built in.
//
//   const lib = new SoundLibrary({ packs: ["packs/synth", "packs/jr-east"], engine: "afplay", volume: 0.5 });
//   lib.play("horn.depart");                       // an id, or a category name (a random member is chosen)
//   lib.play("flange", { gain: 0.8, seconds: 1 }); // seconds trims the clip
//   lib.fill("flange", { ms: 2400, cutMs: 100 });  // clips back to back for exactly this long (a remainder under minClipMs, 150, is skipped)
//   lib.loop("run", "motion.run");  lib.stop("run");   // a named loop slot (a new loop in a slot replaces the old one)
//   lib.duration("motion.accelerate"), lib.categories(), lib.list("brake"), lib.check(ids), lib.stopAll()
//
// play/fill return { done: Promise, stop() } so a show can wait for a sound to finish. Later packs override earlier ones with the same id.

import { createEngine } from "./engine.mjs";
import { loadPack, variantDurationMs } from "./pack.mjs";
import { existsSync } from "node:fs";

export { AfplayEngine, NullEngine, RecordingEngine, registerEngine, createEngine } from "./engine.mjs";
export { loadPack, PACK_FORMAT } from "./pack.mjs";
export { wavDurationMs } from "./wav.mjs";

/** Pure planner for fill(): which clips to play, when, and how long each, to cover `ms`. `pick()` returns { duration (ms), ...whatever }. */
export function planFill(pick, ms, { cutMs = 0, overlapMs = 0, minClipMs = 150 } = {}) {
  if (minClipMs == null) minClipMs = 150;
  const end = ms - cutMs, steps = [];
  if (end < minClipMs) return steps;
  for (let t = 0; t < end - minClipMs;) {
    const c = pick(), len = c.duration;
    if (!(len > overlapMs)) throw new Error("fill needs clips with a known duration longer than the overlap");
    steps.push({ at: t, clip: c, playMs: Math.min(len, end - t) });
    t += len - overlapMs;
  }
  return steps;
}

export class SoundLibrary {
  constructor({ packs = [], engine = "afplay", volume = 0.5, random = Math.random } = {}) {
    this.engine = createEngine(engine); this.volume = volume; this.random = random;
    this.entries = {}; this.packs = [];
    for (const p of packs) this.addPack(p);
    this._slots = new Map(); this._active = new Set(); this._last = new Map(); this._timers = new Set();
  }

  addPack(path) {
    const pack = loadPack(path);
    this.packs.push(pack);
    Object.assign(this.entries, pack.entries);   // later packs win
    return pack;
  }

  // ---- queries ----
  categories() { return [...new Set(Object.values(this.entries).map((e) => e.category))].sort(); }
  list(category) { return Object.values(this.entries).filter((e) => !category || e.category === category).map((e) => e.id).sort(); }
  has(selector) { return this._candidates(selector).length > 0; }
  /** Longest/shortest/typical length for a selector, in ms (null if any clip's length is unknown). */
  duration(selector) {
    const ds = this._candidates(selector, true).flatMap((e) => e.variants.map(variantDurationMs));
    return ds.length && ds.every((d) => d != null) ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
  }
  /** The audio files these selectors need that are not on this machine (messages), without failing. */
  missingFiles(selectors) {
    const out = [];
    for (const s of selectors) for (const e of this._candidates(s)) for (const v of e.variants) if (!existsSync(v.path)) out.push(`"${e.id}" (${e.pack}): missing file ${v.path}`);
    return out;
  }
  /**
   * Throws a list of everything missing (unknown ids, and missing files unless `files: false`), so a show can fail before
   * anything moves. `files: false` is for dry runs (validate, simulate), which need the names but not the audio.
   */
  check(selectors, { files = true } = {}) {
    const bad = [];
    for (const s of selectors) if (!this._candidates(s).length) bad.push(`unknown sound "${s}"`);
    if (files) bad.push(...this.missingFiles(selectors.filter((s) => this._candidates(s).length)));
    if (bad.length) throw new Error(`sound check failed:\n  ${bad.join("\n  ")}`);
  }

  // ---- choosing ----
  _candidates(selector, strict = false) {
    const exact = this.entries[selector];
    if (exact) return [exact];
    const cat = Object.values(this.entries).filter((e) => e.category === selector);
    if (cat.length || strict) return cat;
    return [];
  }
  _pickEntry(selector) {
    const c = this._candidates(selector);
    if (!c.length) throw new Error(`unknown sound "${selector}" (categories: ${this.categories().join(", ") || "none loaded"})`);
    return c[Math.floor(this.random() * c.length)];
  }
  _pickVariant(entry) {
    let vs = entry.variants;
    const last = this._last.get(entry.id);
    if (entry.noRepeat && vs.length > 1 && last != null) vs = vs.filter((v) => v.file !== last);
    let r = this.random() * vs.reduce((a, v) => a + v.weight, 0);
    let chosen = vs[vs.length - 1];
    for (const v of vs) { r -= v.weight; if (r < 0) { chosen = v; break; } }
    this._last.set(entry.id, chosen.file);
    return chosen;
  }
  _jitter(frac) { return frac ? 1 - frac + 2 * frac * this.random() : 1; }
  /** Decide what to play for a selector without playing it. */
  choose(selector, { gain = 1 } = {}) {
    const entry = this._pickEntry(selector), v = this._pickVariant(entry);
    return { entry, variant: v, path: v.path, duration: variantDurationMs(v), volume: this.volume * entry.gain * gain * this._jitter(entry.gainJitter), rate: entry.rateJitter ? this._jitter(entry.rateJitter) : undefined, loop: entry.loop };
  }

  // ---- playing ----
  _start(c, { seconds } = {}) {
    const h = this.engine.play(c.path, { volume: c.volume, seconds, rate: c.rate });
    this._active.add(h); h.done.then(() => this._active.delete(h));
    return h;
  }
  play(selector, opts = {}) { return this._start(this.choose(selector, opts), opts); }

  fill(selector, { ms, cutMs = 0, overlapMs = 0, gain = 1, minClipMs }) {
    const plan = planFill(() => this.choose(selector, { gain }), ms, { cutMs, overlapMs, minClipMs });
    const handles = []; let stopped = false;
    const finished = new Promise((resolve) => {
      let left = plan.length; if (!left) return resolve();
      for (const step of plan) {
        const timer = setTimeout(() => {
          this._timers.delete(timer);
          if (stopped) { if (--left === 0) resolve(); return; }
          const h = this._start(step.clip, { seconds: step.playMs / 1000 }); handles.push(h);
          h.done.then(() => { if (--left === 0) resolve(); });
        }, step.at);
        this._timers.add(timer);
      }
    });
    return { done: finished, plan, stop: () => { stopped = true; handles.forEach((h) => h.stop()); } };
  }

  loop(slot, selector, opts = {}) {
    const old = this._slots.get(slot);
    const s = { want: true, handle: null };
    this._slots.set(slot, s);
    const run = () => {
      if (!s.want) return;
      const c = this.choose(selector, opts), startedAt = Date.now();
      s.handle = this._start(c);
      s.handle.done.then(() => {
        if (!(s.want && this._slots.get(slot) === s)) return;
        // An engine whose clips end at once (the silent one) would restart in a microtask loop that starves every timer:
        // if it ended early, wait out the clip's length before the next round.
        if (Date.now() - startedAt >= 10) return run();
        const t = setTimeout(() => { this._timers.delete(t); run(); }, Math.max(50, c.duration || 1000));
        t.unref?.(); this._timers.add(t);
      });
    };
    run();
    if (old) { old.want = false; const h = old.handle; if (h) { const t = setTimeout(() => { this._timers.delete(t); h.stop(); }, 90); this._timers.add(t); } }   // short overlap hides the join
  }
  stop(slot) { const s = this._slots.get(slot); if (s) { s.want = false; s.handle?.stop(); this._slots.delete(slot); } }
  stopAll() {
    for (const slot of [...this._slots.keys()]) this.stop(slot);
    for (const t of this._timers) clearTimeout(t); this._timers.clear();
    for (const h of this._active) h.stop(); this._active.clear();
  }
}
