// Dry runs: a show against stand-ins on a virtual clock, so a whole show takes milliseconds and nothing moves or plays.
//
//   const r = await simulateShow(show, { layout, loco, sounds });     // r.log is the timeline, r.commands what the controller was sent
//
// What is real: the show runtime, the controller module (its ramps and motor-care rules), the validator, the position
// estimate and the sound library's id and file checks. What is faked: the WebSocket (records commands), the sound engine
// (durations come from the pack's files) and the sensor: a "ghost" that reports each event `eventMs` after it is waited
// for, so the timeline shows the order and the loco's commands but not the real timing of your layout.

import { EventEmitter } from "node:events";
import { Controller } from "../controller/index.mjs";
import { VirtualClock } from "./clock.mjs";
import { runShow } from "./runtime.mjs";

export class SimSocket {
  constructor(url) { this.url = url; this.sent = []; this.ls = {}; SimSocket.last = this; queueMicrotask(() => this._emit("open", {})); }
  addEventListener(type, fn, opts) { (this.ls[type] ||= []).push({ fn, once: opts && opts.once }); }
  _emit(type, ev) { for (const l of [...(this.ls[type] || [])]) { if (l.once) this.ls[type] = this.ls[type].filter((x) => x !== l); l.fn(ev); } }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this._emit("close", {}); }
}

/** A sensor that confirms every event after a fixed delay. Labels edges from the direction like the real one does. */
export class GhostSensor extends EventEmitter {
  constructor(clock, { state = "clear", eventMs = 1500 } = {}) {
    super();
    Object.assign(this, { clock, state, eventMs, direction: null, lastReading: state === "blocked" ? 35 : 320 });
  }
  setDirection(d) { this.direction = d; }
  async waitFor(event, { timeoutMs = 30000 } = {}) {
    await this.clock.sleep(Math.min(this.eventMs, Math.max(1, timeoutMs / 2)));
    const fwd = this.direction !== "reverse";
    const raw = (name, edge) => { this.state = name === "break" ? "blocked" : "clear"; const p = { edge, ghost: true }; this.emit(name, p); this.emit(edge, p); return p; };
    switch (event) {
      case "break": return raw("break", fwd ? "nose" : "tail");
      case "restore": return raw("restore", fwd ? "tail" : "nose");
      case "nose": return raw(fwd ? "break" : "restore", "nose");
      case "tail": return raw(fwd ? "restore" : "break", "tail");
      case "pass": { raw("break", fwd ? "nose" : "tail"); const p = raw("restore", fwd ? "tail" : "nose"); const e = { ...p, direction: this.direction, ghost: true }; this.emit("pass", e); return e; }
      default: throw new Error(`ghost sensor: unknown event ${event}`);
    }
  }
}

/** Sound stand-in: nothing plays, each sound "lasts" as long as its file, and every call is recorded. */
export class SimSound {
  constructor(clock, library = null, onCall = () => {}) { this.clock = clock; this.library = library; this.calls = []; this.onCall = onCall; }
  _rec(c) { this.calls.push({ t: this.clock.now(), ...c }); this.onCall(c); }
  check(ids) { if (this.library) this.library.check(ids); }
  has(id) { return this.library ? this.library.has(id) : true; }
  _dur(id) { try { return this.library ? this.library.duration(id) : 1000; } catch { return 1000; } }
  play(id, { gain = 1, seconds } = {}) {
    const ms = Math.min(this._dur(id), seconds != null ? seconds * 1000 : Infinity);
    this._rec({ kind: "play", id, ms });
    return { done: this.clock.sleep(ms), stop() {} };
  }
  fill(id, { ms }) { this._rec({ kind: "fill", id, ms }); return { done: this.clock.sleep(ms), stop() {} }; }
  loop(slot, id) { this._rec({ kind: "loop", slot, id }); }
  stop(slot) { this._rec({ kind: "stop-loop", slot }); }
  stopAll() { this._rec({ kind: "stop-all" }); }
}

export async function simulateShow(show, { layout = null, loco = null, sounds = null, settings = {}, eventMs = 1500, config = {} } = {}) {
  const clock = new VirtualClock();
  const ctl = new Controller({ host: "sim", WebSocketImpl: SimSocket, clock, config: { pingMs: 2e9, ...config } });
  await ctl.connect();
  const sensor = new GhostSensor(clock, { state: show.start === "blocked" ? "blocked" : "clear", eventMs });
  const sound = new SimSound(clock, sounds);
  let result, error = null;
  await clock.run((async () => {
    try { result = await runShow(show, { controller: ctl, sensor, sound, layout, loco, clock, settings }); }
    catch (e) { error = e; result = e.result || null; }
    await ctl.close();
  })());
  const commands = SimSocket.last.sent.filter((m) => m.cmd !== "ping");
  if (error && !result) throw error;
  return { ok: !error, error: error ? error.message : null, elapsedMs: result.elapsedMs, log: result.log, commands, sounds: sound.calls, maxSpeed: Math.max(0, ...commands.filter((c) => c.cmd === "speed").map((c) => c.value)) };
}
