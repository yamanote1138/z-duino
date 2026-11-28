// Running a show: the steps in a show file, executed against the controller, sensor and sound modules.
//
//   const result = await runShow(show, { controller, sensor, sound, layout, loco });
//
// Everything is injected, so the same runtime drives real hardware or the simulator (lib/show/sim.mjs).
//   controller  lib/controller   sensor  lib/sensor (or anything with on/off/waitFor/setDirection/state)
//   sound       lib/sound SoundLibrary (or the simulator's stand-in)
//   layout      z-layout/1 (zones, loop length)     loco  the loco profile (length, speed model); both only for zone steps
//   clock       { now, sleep }   settings: overrides for the show's settings   signal: an AbortSignal
//
// Safety, whatever the show says:
//   - the sensor reports lost while the show runs: the show stops
//   - any failure, abort or sensor loss ends the show with sounds stopped and the loco brought to a quiet stop
//     (ramped down if it is above creep speed: motor care applies to emergencies too, unless that ramp itself fails)
//   - `start` ("blocked" = nose on the mark) is checked against the sensor before the first move

import { realClock } from "./clock.mjs";
import { Position, speedModel, inZone, rampDistanceIn, APPROACH_CREEP_IN, APPROACH_MARGIN_IN } from "./position.mjs";
import { COLORS, soundsUsed, usesZones, validateShow } from "./schema.mjs";

export async function runShow(show, { controller: ctl, sensor, sound, layout = null, loco = null, clock = realClock, settings = {}, onLog = () => {}, signal = null, pollMs = 50 }) {
  const check = validateShow(show, { sounds: sound, layout, loco, settings });
  if (check.errors.length) throw new Error(`the show is not valid:\n  ${check.errors.join("\n  ")}`);
  const vars = { ...(show.settings || {}), ...settings };
  const n = (v) => (typeof v === "string" && v.startsWith("$") ? vars[v.slice(1)] : v);

  const t0 = clock.now();
  const log = [];
  const say = (text, path = "") => { const e = { t: clock.now() - t0, path, text }; log.push(e); onLog(e); };

  // ---- before anything moves ----
  const needsZones = usesZones(show);
  if (needsZones && !(layout && loco)) throw new Error("this show uses zones: it needs a layout and a loco profile");
  const start = show.start || "any";
  if (start !== "any" && sensor.state !== start) throw new Error(`the show starts with the beam ${start}, but the sensor says ${sensor.state} (reading ${sensor.lastReading ?? "?"}): put the loco in place first`);
  const ids = soundsUsed(show);
  if (ids.length && sound) sound.check(ids);

  let pos = null, restoreSend = () => {};
  if (needsZones) {
    pos = new Position({ speed: speedModel(loco), lengthIn: loco.lengthIn, loopIn: layout.loopIn || null, getMotion: () => ({ thr: ctl.speed, forward: ctl.forward }), now: () => clock.now() });
    if (start === "blocked") pos.anchor(0);
    // Bring the estimate up to date whenever a command goes out (every state change in the controller follows its send), so a
    // stop or a direction change is integrated at the speed it actually happened at, not carried on through the next wait.
    const had = Object.prototype.hasOwnProperty.call(ctl, "send"), prev = ctl.send;
    const send = ctl.send.bind(ctl);
    // (before the send: integrate up to now at the old speed; in a microtask after it: pick up the new speed the caller sets next)
    const refresh = () => { try { pos.update(); } catch { /* no speed model: the show would have been refused */ } };
    ctl.send = (m) => { refresh(); const r = send(m); queueMicrotask(refresh); return r; };
    restoreSend = () => { if (had) ctl.send = prev; else delete ctl.send; };
  }
  const onEdge = (e) => { if (pos && e) pos.anchorEdge(e.edge); };
  const label = () => sensor.setDirection(ctl.forward ? "forward" : "reverse");

  // ---- failure plumbing: anything that goes wrong rejects `dead`, and every wait races it ----
  let kill; const dead = new Promise((_, rej) => { kill = rej; }); dead.catch(() => {});
  const onLost = () => kill(new Error("the sensor stopped reporting"));
  const onAbort = () => kill(new Error("aborted"));
  sensor.on("lost", onLost); sensor.on("break", onEdge); sensor.on("restore", onEdge);
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  const lostSignal = new Promise((res) => sensor.on("lost", res));
  const race = (p) => Promise.race([p, dead]);
  const handles = new Set();
  const pendingLoops = new Map(), cancelLoop = (slot) => pendingLoops.delete(slot);   // loops waiting for their afterMs, by slot

  /** Wait until the estimated nose position passes `target` in the direction of travel (`fwd`). */
  async function waitPosition(target, fwd, timeoutMs, what) {
    const giveUp = clock.now() + timeoutMs;
    for (;;) {
      await race(clock.sleep(pollMs));
      if (clock.now() > giveUp) throw new Error(`${what} not reached within ${Math.round(timeoutMs / 1000)} s (estimated position ${pos.x.toFixed(1)} in, waiting for ${target.toFixed(1)} in): is the speed model right?`);
      if (ctl.forward !== fwd) throw new Error(`the direction changed while waiting for ${what}`);
      const x = pos.x;
      if (fwd ? x >= target : x <= target) break;
    }
  }
  // A zone as the nose meets it. Going the other way the tail leads into each bend, so the nose reaches it one loco length later.
  const zoneOf = (name) => { const z = layout.zones[name]; return ctl.forward ? z : { ...z, fromIn: z.fromIn + loco.lengthIn, toIn: z.toIn + loco.lengthIn }; };
  async function waitZone(name, edge, timeoutMs) {
    const z = zoneOf(name);
    if (!pos.known) throw new Error(`wait-zone "${name}": the position is not known yet (no beam edge seen: start with the nose on the mark, or wait for a beam event first)`);
    const fwd = ctl.forward;
    const want = edge === "enter" ? (fwd ? z.fromIn : z.toIn) : (fwd ? z.toIn : z.fromIn);
    if (edge === "enter" && inZone(pos.x, z, layout.loopIn)) { say(`already inside zone "${name}"`); return; }
    await waitPosition(pos.target(want, fwd), fwd, timeoutMs, `zone "${name}" ${edge}`);
    say(`zone "${name}" ${edge}`);
  }
  // Slow-down point for a beam stop: ramp distance + creep run + margin before the beam, measured from the leading end
  // (the nose going forward, the tail in reverse: that end is the one that breaks the beam).
  async function waitApproach(s) {
    if (!pos.known) throw new Error(`wait-approach: the position is not known yet (no beam edge seen: start with the nose on the mark, or wait for a beam event first)`);
    const fwd = ctl.forward;
    const from = n(s.from), to = n(s.to ?? ctl.config.creepMax ?? 0.1), secs = n(s.secondsPer01 ?? ctl.config.rampSecondsPer01 ?? 1);
    const rampIn = rampDistanceIn(speedModel(loco), from, to, secs), creepIn = n(s.creepIn ?? APPROACH_CREEP_IN), marginIn = n(s.marginIn ?? APPROACH_MARGIN_IN);
    const d = rampIn + creepIn + marginIn;
    const target = pos.target(fwd ? -d : loco.lengthIn + d, fwd);
    say(`approach: start slowing ${d.toFixed(1)} in before the beam (ramp ${rampIn.toFixed(1)} + creep ${creepIn} + margin ${marginIn}), at ${target.toFixed(1)} in`);
    await waitPosition(target, fwd, n(s.timeoutMs ?? 60000), "the approach");
    say("approach: slow down now");
  }
  const zoneMs = (name) => { const z = layout.zones[name]; const v = speedModel(loco)(ctl.speed); if (!(v > 0)) throw new Error(`fill zone "${name}": the loco is not moving`); return ((z.toIn - z.fromIn) / v) * 1000; };

  async function exec(s, path) {
    switch (s.do) {
      case "direction": await race(ctl.setDirection(s.forward)); label(); say(`direction ${s.forward ? "forward" : "reverse"}`, path); break;
      case "ramp": say(`ramp to ${n(s.to)}`, path); await race(ctl.rampTo(n(s.to), s.secondsPer01 ? { secondsPer01: n(s.secondsPer01) } : {})); break;
      case "halt": say("halt", path); await race(ctl.halt(s.secondsPer01 ? { secondsPer01: n(s.secondsPer01) } : {})); break;
      case "wait": await race(clock.sleep(n(s.ms))); break;
      case "wait-for": {
        label(); say(`waiting for ${s.event}`, path);
        const e = await race(sensor.waitFor(s.event, { timeoutMs: n(s.timeoutMs ?? 30000) }));
        say(`${s.event}${e && e.edge ? ` (${e.edge})` : ""}`, path); break;
      }
      case "creep": {
        label();
        const already = (s.until === "break" && sensor.state === "blocked") || (s.until === "restore" && sensor.state === "clear");
        if (already && ctl.speed > 0) { ctl.setSpeed(0); say(`beam already ${sensor.state}: stopped (it got there while slowing)`, path); break; }   // at creep speed a straight stop is fine
        if (already) { say(`beam already ${sensor.state}: not moving (creep until ${s.until})`, path); break; }
        say(`creep ${s.forward ? "forward" : "reverse"} until ${s.until}`, path);
        const r = await race(ctl.guardedMove({ event: s.until, forward: s.forward, speed: n(s.speed), maxMs: n(s.maxMs), afterMs: n(s.afterMs ?? 0), until: () => sensor.waitFor(s.until, { timeoutMs: n(s.maxMs) + 1000 }), abort: lostSignal }));
        if (r.result !== "guard") throw new Error(`creep ended without the beam event (${r.result})`);
        say(`creep done after ${r.elapsedMs} ms`, path); break;
      }
      case "wait-approach": await waitApproach(s); break;
      case "wait-zone": say(`waiting for zone "${s.zone}" ${s.edge}`, path); await waitZone(s.zone, s.edge, n(s.timeoutMs ?? 60000)); break;
      case "sound": {
        const h = sound.play(s.id, { gain: s.gain != null ? n(s.gain) : 1, seconds: s.seconds != null ? n(s.seconds) : undefined });
        handles.add(h); say(`sound ${s.id}`, path);
        if (s.wait !== false) await race(h.done);
        break;
      }
      case "fill": {
        if (s.zone) await waitZone(s.zone, "enter", 60000);
        const ms = s.zone ? zoneMs(s.zone) : n(s.ms);
        const h = sound.fill(s.id, { ms, cutMs: n(s.cutMs ?? 0), overlapMs: n(s.overlapMs ?? 0), gain: s.gain != null ? n(s.gain) : 1 });
        handles.add(h); say(`fill ${s.id} for ${Math.round(ms)} ms`, path);
        if (s.wait !== false) await race(h.done);
        break;
      }
      case "loop": {
        cancelLoop(s.slot);
        const gain = s.gain != null ? n(s.gain) : 1, after = n(s.afterMs ?? 0), fadeMs = s.fadeMs != null ? n(s.fadeMs) : undefined;
        if (!(after > 0)) { sound.loop(s.slot, s.id, { gain, fadeMs }); say(`loop ${s.slot}: ${s.id}`, path); break; }
        // later, without holding anything up: a stop-loop for the slot (or the end of the show) cancels it, so the show never has to
        // sit in a branch waiting for it
        const token = {}; pendingLoops.set(s.slot, token);
        clock.sleep(after).then(() => { if (pendingLoops.get(s.slot) !== token) return; pendingLoops.delete(s.slot); sound.loop(s.slot, s.id, { gain, fadeMs }); say(`loop ${s.slot}: ${s.id}`, path); }).catch(() => {});
        say(`loop ${s.slot}: ${s.id} in ${after} ms`, path); break;
      }
      case "stop-loop": cancelLoop(s.slot); sound.stop(s.slot); say(`stop loop ${s.slot}`, path); break;
      case "stop-sounds": pendingLoops.clear(); sound.stopAll(); say("stop all sounds", path); break;
      case "led": { const c = s.color ? COLORS[s.color] : [n(s.r), n(s.g), n(s.b)]; say(ctl.led(...c) === false ? "led skipped (no status LED)" : `led ${s.color || c.join(",")}`, path); break; }
      case "led-auto": say(ctl.ledAuto() === false ? "led skipped (no status LED)" : "led auto", path); break;
      case "log": say(s.message, path); break;
      case "repeat": for (let i = 1; i <= n(s.times); i++) { say(`repeat ${i}/${n(s.times)}`, path); await seq(s.steps, `${path}.steps`); } break;
      case "parallel": await race(Promise.all(s.branches.map((b, j) => seq(b, `${path}.branches[${j}]`)))); break;
      default: throw new Error(`unknown step ${s.do}`);
    }
  }
  async function seq(steps, base) { for (let i = 0; i < steps.length; i++) await race(exec(steps[i], `${base}[${i}]`)); }

  let failure = null;
  try {
    label();
    say(`start: ${show.name}`);
    await seq(show.steps, "steps");
    say("finished");
  } catch (e) {
    failure = e; say(`stopped: ${e.message}`);
  } finally {
    restoreSend();
    sensor.off?.("lost", onLost); sensor.off?.("break", onEdge); sensor.off?.("restore", onEdge);
    if (signal) signal.removeEventListener("abort", onAbort);
    pendingLoops.clear();
    try { sound?.stopAll(); } catch { /* the sound engine is not worth failing a stop for */ }
    try { await safeStop(ctl, clock); } catch (e) { say(`could not stop quietly (${e.message}): emergency stop`); try { ctl.emergencyStop(); } catch { /* the link is gone; the firmware stops the motor itself after 30 s */ } }
  }
  const result = { ok: !failure, error: failure ? failure.message : null, elapsedMs: clock.now() - t0, log };
  if (failure) { const err = new Error(failure.message); err.result = result; throw err; }
  return result;
}

async function safeStop(ctl, clock) {
  if (!ctl.connected) return;
  if (ctl.speed > ctl.config.creepMax) await ctl.halt();
  else if (ctl.speed > 0) ctl.setSpeed(0);
  ctl.ledAuto();
}
