// Put the loco back on the mark: the nose just breaking the beam. "The mark" is where every show starts. `end: "tail"` is the
// mark for a reverse run: the same, then the loco is seated the other way round (the tail just breaking the beam).
//
//   const r = await returnToMark({ controller, sensor, signal, onLog });   // r = { ok, how, legs, elapsedMs, error }
//
// The simplest thing first, then a wider search; every move is at creep speed and stops on a beam event, with a time limit:
//   beam blocked  back off until it clears, then creep forward until it breaks (this seats the nose on the edge whether it
//                 was the nose or the tail sitting in the beam)
//   beam clear    1. just short of the mark?  creep forward a few seconds: a break means it is on the mark
//                 2. just past it?            back up over the beam (break, then clear), then creep forward until it breaks
//                 3. somewhere else?          creep forward round the loop until the beam breaks (one lap plus margin)
//   if even that fails, the loco is stopped and the result says so.
// A sensor loss or an abort stops it at once.

import { realClock } from "../show/clock.mjs";

export const MARK_DEFAULTS = { nearS: 5, afterMs: 450, approachMs: 8000, creepInS: 2.35, loopIn: 134, end: "nose" };

export async function returnToMark({ controller: ctl, sensor, signal = null, onLog = () => {}, clock = realClock, ...opts }) {
  const o = { ...MARK_DEFAULTS, ...opts };
  const t0 = clock.now(), legs = [];
  const say = (text) => onLog({ t: clock.now() - t0, text });
  const done = (ok, how, error = null) => ({ ok, how, error, legs, elapsedMs: clock.now() - t0 });

  if (sensor.state === "lost") return done(false, null, "the sensor is not reporting");
  let reason = null;
  const stop = new Promise((res) => {
    sensor.on("lost", () => { reason ||= "the sensor stopped reporting"; res(); });
    if (signal) { const f = () => { reason ||= "aborted"; res(); }; if (signal.aborted) f(); else signal.addEventListener("abort", f, { once: true }); }
  });
  stop.catch(() => {});

  // one guarded creep: ends on the beam event(s), the time limit, or a stop; the loco is always stopped afterwards
  async function leg(what, forward, { chain, maxMs, afterMs = 0 }) {
    say(what);
    sensor.setDirection(forward ? "forward" : "reverse");
    const until = async () => { for (const ev of chain) await sensor.waitFor(ev, { timeoutMs: maxMs + 500 }); };
    const r = await ctl.guardedMove({ forward, speed: ctl.config.creepMax, maxMs, afterMs, until, abort: stop });
    legs.push({ what, result: r.result, elapsedMs: r.elapsedMs });
    return r.result;
  }
  const approach = (what) => leg(what, true, { chain: ["break"], maxMs: o.approachMs });
  const onMark = async (how) => {
    if (sensor.state !== "blocked") return done(false, how, `finished ${how} but the beam is ${sensor.state}`);
    say(`on the mark (${how})`);
    if (o.end !== "tail") return done(true, how);
    // the tail mark: forward until the tail clears the beam, then back until the tail breaks it
    const f = await leg("seating the tail: forward until the tail clears the beam", true, { chain: ["restore"], maxMs: o.approachMs });
    if (reason) return aborted();
    if (f !== "guard") return done(false, how, "could not clear the beam with the tail");
    const b = await leg("back until the tail breaks the beam", false, { chain: ["break"], maxMs: o.approachMs });
    if (reason) return aborted();
    if (b !== "guard") return done(false, how, "cleared the beam but could not find it again with the tail");
    say("tail on the mark");
    return done(true, how);
  };
  const aborted = () => done(false, null, reason);

  try {
    if (sensor.state === "blocked") {
      // blocked: the nose or the tail is in the beam (or something else is). Back off until it clears, then come forward onto the edge.
      const r = await leg("backing off the beam", false, { chain: ["restore"], maxMs: o.approachMs, afterMs: o.afterMs });
      if (reason) return aborted();
      if (r !== "guard") return done(false, "reseat", "the beam stays blocked when backing off: is something else in it?");
      const f = await approach("creeping forward onto the beam");
      if (reason) return aborted();
      if (f !== "guard") return done(false, "reseat", "backed off the beam but could not find it again");
      return await onMark("re-seated");
    }

    const nearMs = o.nearS * 1000;
    // 1. just short of the mark
    let r = await leg("creeping forward (just short of the mark?)", true, { chain: ["break"], maxMs: nearMs });
    if (reason) return aborted();
    if (r === "guard") return await onMark("just short");
    // 2. just past it
    r = await leg("backing up over the beam (just past the mark?)", false, { chain: ["break", "restore"], maxMs: Math.round(nearMs * 2.5), afterMs: o.afterMs });
    if (reason) return aborted();
    if (r === "guard") {
      const f = await approach("creeping forward onto the beam");
      if (reason) return aborted();
      if (f === "guard") return await onMark("just past");
    }
    // 3. somewhere else: round the loop until the beam breaks
    const lapMs = Math.round((o.loopIn / o.creepInS) * 1.25 * 1000) + 10000;
    r = await leg("not close: creeping forward round the loop until the beam breaks", true, { chain: ["break"], maxMs: lapMs });
    if (reason) return aborted();
    if (r === "guard") return await onMark("round the loop");
    return done(false, "loop", `the beam did not break in a lap's time (${Math.round(lapMs / 1000)} s): the loco is stopped; is it on the track, and is the sensor working?`);
  } catch (e) {
    return done(false, null, e.message);
  }
}
