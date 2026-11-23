// Playback engines. The library only ever calls engine.play(), so how sound reaches the speakers is swappable.
//
// An engine is any object with:
//   play(path, { volume, seconds, rate }) -> { done: Promise<void>, stop(): void }
//     volume  0..1+ (1 = file level); seconds = stop after this long (optional); rate = playback speed (optional)
//   available(): boolean   (optional) whether this engine can run on this machine
//
// Built in: "afplay" (macOS), "null" (silent), and RecordingEngine for tests. Add your own with registerEngine("aplay", factory),
// then use { engine: "aplay" } in the library options.

import { spawn } from "node:child_process";

export class AfplayEngine {
  available() { return process.platform === "darwin"; }
  play(path, { volume = 1, seconds, rate } = {}) {
    const args = ["-v", String(volume)];
    if (rate && Math.abs(rate - 1) > 0.01) args.push("-r", String(rate), "-q", "1");
    if (seconds) args.push("-t", String(seconds));
    const child = spawn("afplay", [...args, path], { stdio: "ignore" });
    const done = new Promise((resolve) => { child.on("exit", resolve); child.on("error", resolve); });
    return { done, stop: () => child.kill("SIGTERM") };
  }
}

export class NullEngine {
  available() { return true; }
  play() { return { done: Promise.resolve(), stop() {} }; }
}

/** Remembers every call and "plays" each for a fixed (fake) time. Used by the tests; handy for dry runs of a show. */
export class RecordingEngine {
  constructor({ playMs = 0 } = {}) { this.calls = []; this.playMs = playMs; this.active = 0; }
  available() { return true; }
  play(path, opts = {}) {
    const call = { path, ...opts, at: Date.now(), stopped: false };
    this.calls.push(call);
    let timer; this.active++;
    const done = new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); if (call.finished) return; call.finished = true; this.active--; resolve(); };
      call.finish = finish;
      const len = opts.seconds ? Math.min(opts.seconds * 1000, this.playMs || Infinity) : this.playMs;
      timer = setTimeout(finish, len);
    });
    return { done, stop: () => { call.stopped = true; call.finish(); } };
  }
}

const registry = new Map([["afplay", () => new AfplayEngine()], ["null", () => new NullEngine()]]);
export function registerEngine(name, factory) { registry.set(name, factory); }
export function createEngine(spec = "afplay") {
  if (typeof spec === "object" && typeof spec.play === "function") return spec;
  const make = registry.get(spec);
  if (!make) throw new Error(`unknown sound engine "${spec}" (known: ${[...registry.keys()].join(", ")})`);
  const e = make();
  if (e.available && !e.available()) throw new Error(`sound engine "${spec}" is not available on this machine`);
  return e;
}
