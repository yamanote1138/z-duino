// Checking a show before anything moves. validateShow() returns { errors, warnings } with the path of each problem
// ("steps[3].branches[1][0].speed"), so a hand-edited file points at its own mistake.
//
// Step kinds (field: type; * = required):
//   direction   forward*: bool
//   ramp        to*: 0..1, secondsPer01
//   halt        secondsPer01
//   wait        ms*
//   wait-for    event*, timeoutMs                      (a sensor event; default timeout 30 s)
//   creep       forward*, speed*, until*: event, maxMs*, afterMs     (a move that stops on a beam event; creep speed only;
//               if the beam is already in that state it does not move at all)
//   wait-zone   zone*, edge*: enter|exit, timeoutMs     (needs a layout and a loco profile; default timeout 60 s)
//   wait-approach from*: throttle you are running at, creepIn, marginIn, to, secondsPer01, timeoutMs
//               waits until it is time to start slowing for a beam stop: the distance the ramp from `from` to creep takes (from the
//               loco's speed table), plus `creepIn` inches of running at creep (default 5), plus `marginIn` (default 3) for the position
//               estimate. Knows which end leads (nose forward, tail in reverse). Needs layout.loopIn and a loco profile.
//   sound       id*, gain, seconds, wait               (wait defaults to true: the step ends when the sound does)
//   fill        id*, ms or zone, cutMs, overlapMs, gain, wait
//   loop        slot*, id*, gain, afterMs  (afterMs starts it later without holding the show up; stop-loop on the slot cancels it)
//   stop-loop   slot*          stop-sounds
//   led         color or r, g, b          led-auto
//   repeat      times*, steps*            parallel   branches*: [[steps], [steps]]        log   message*
// Any number may be "$name", a value from the show's "settings" (overridable when the show is run).

import { SHOW_FORMAT } from "./io.mjs";

export const EVENTS = ["break", "restore", "nose", "tail", "pass"];
export const COLORS = { off: [0, 0, 0], red: [1000, 0, 0], yellow: [1000, 600, 0], green: [0, 1000, 0], blue: [0, 0, 1000], purple: [600, 0, 1000], magenta: [1000, 0, 1000], white: [1000, 1000, 1000] };
const CREEP_MAX = 0.10;
const BLIND = () => `ramps above creep speed (${CREEP_MAX}) and slows down again with no beam wait (wait-for, creep, wait-zone, wait-approach) in between: a blind run. Wait for a beam event while it runs`;

const num = (name, opts = {}) => ({ name, kind: "num", ...opts });
const STEPS = {
  direction: { req: { forward: "bool" } },
  ramp: { req: { to: num("to", { min: 0, max: 1 }) }, opt: { secondsPer01: num("secondsPer01", { min: 0.1 }) } },
  halt: { opt: { secondsPer01: num("secondsPer01", { min: 0.1 }) } },
  wait: { req: { ms: num("ms", { min: 0 }) } },
  "wait-for": { req: { event: "event" }, opt: { timeoutMs: num("timeoutMs", { min: 1 }) } },
  creep: { req: { forward: "bool", speed: num("speed", { min: 0.01, max: CREEP_MAX }), until: "event", maxMs: num("maxMs", { min: 1 }) }, opt: { afterMs: num("afterMs", { min: 0 }) } },
  "wait-zone": { req: { zone: "string", edge: "edge" }, opt: { timeoutMs: num("timeoutMs", { min: 1 }) } },
  "wait-approach": { req: { from: num("from", { min: 0.01, max: 1 }) }, opt: { creepIn: num("creepIn", { min: 0 }), marginIn: num("marginIn", { min: 0 }), to: num("to", { min: 0.01, max: CREEP_MAX }), secondsPer01: num("secondsPer01", { min: 0.1 }), timeoutMs: num("timeoutMs", { min: 1 }) } },
  sound: { req: { id: "string" }, opt: { gain: num("gain", { min: 0 }), seconds: num("seconds", { min: 0 }), wait: "bool" } },
  fill: { req: { id: "string" }, opt: { ms: num("ms", { min: 1 }), zone: "string", cutMs: num("cutMs", { min: 0 }), overlapMs: num("overlapMs", { min: 0 }), gain: num("gain", { min: 0 }), wait: "bool" } },
  loop: { req: { slot: "string", id: "string" }, opt: { gain: num("gain", { min: 0 }), afterMs: num("afterMs", { min: 0 }) } },
  "stop-loop": { req: { slot: "string" } },
  "stop-sounds": {},
  led: { opt: { color: "color", r: num("r", { min: 0, max: 1000 }), g: num("g", { min: 0, max: 1000 }), b: num("b", { min: 0, max: 1000 }) } },
  "led-auto": {},
  repeat: { req: { times: num("times", { min: 1, int: true }), steps: "steps" } },
  parallel: { req: { branches: "branches" } },
  log: { req: { message: "string" } },
};
export const STEP_KINDS = Object.keys(STEPS);

/** Every sound id a show plays, so the runner can check the library before it starts. */
export function soundsUsed(show) {
  const ids = new Set(show.needs?.sounds || []);
  walk(show.steps || [], (s) => { if (typeof s.id === "string" && ["sound", "fill", "loop"].includes(s.do)) ids.add(s.id); });
  return [...ids];
}
export const usesZones = (show) => { let u = false; walk(show.steps || [], (s) => { if (s.do === "wait-zone" || s.do === "wait-approach" || (s.do === "fill" && s.zone)) u = true; }); return u; };

function walk(steps, fn) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    fn(s);
    if (Array.isArray(s.steps)) walk(s.steps, fn);
    if (Array.isArray(s.branches)) for (const b of s.branches) walk(b, fn);
  }
}

/**
 * @param show   the parsed show
 * @param opts   { sounds: SoundLibrary (to check ids), layout, loco, settings: overrides, soundFiles: false to check the sound names only (dry runs) }
 */
export function validateShow(show, { sounds = null, layout = null, loco = null, settings = {}, soundFiles = true } = {}) {
  const errors = [], warnings = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const warn = (path, msg) => warnings.push(`${path}: ${msg}`);
  if (!show || typeof show !== "object" || Array.isArray(show)) return { errors: ["show: must be a JSON object"], warnings };
  if (show.format !== SHOW_FORMAT) err("format", `must be "${SHOW_FORMAT}" (got ${JSON.stringify(show.format)})`);
  if (typeof show.name !== "string" || !show.name.trim()) err("name", "a show needs a name");
  for (const k of Object.keys(show)) if (!["format", "name", "description", "needs", "settings", "start", "steps"].includes(k)) err(k, "unknown field (allowed: format, name, description, needs, settings, start, steps)");
  if (show.start != null && !["blocked", "clear", "any"].includes(show.start)) err("start", `must be "blocked" (nose on the mark), "clear" or "any"`);
  const vars = { ...(show.settings || {}), ...settings };
  for (const [k, v] of Object.entries(show.settings || {})) if (typeof v !== "number") err(`settings.${k}`, "settings are numbers");
  if (!Array.isArray(show.steps) || !show.steps.length) { err("steps", "a show needs at least one step"); return { errors, warnings }; }

  const checkValue = (path, spec, v) => {
    if (spec === "bool") { if (typeof v !== "boolean") err(path, `must be true or false (got ${JSON.stringify(v)})`); return; }
    if (spec === "string") { if (typeof v !== "string" || !v) err(path, "must be a non-empty string"); return; }
    if (spec === "event") { if (!EVENTS.includes(v)) err(path, `must be one of ${EVENTS.join(", ")} (got ${JSON.stringify(v)})`); return; }
    if (spec === "edge") { if (!["enter", "exit"].includes(v)) err(path, `must be "enter" or "exit"`); return; }
    if (spec === "color") { if (!(v in COLORS)) err(path, `unknown colour "${v}" (known: ${Object.keys(COLORS).join(", ")})`); return; }
    if (spec === "steps") return;   // checked by the caller
    if (spec === "branches") return;
    if (spec.kind === "num") {
      let n = v;
      if (typeof v === "string" && v.startsWith("$")) { if (!(v.slice(1) in vars)) { err(path, `${v} is not in the show's settings`); return; } n = vars[v.slice(1)]; }
      if (typeof n !== "number" || !Number.isFinite(n)) { err(path, `must be a number (got ${JSON.stringify(v)})`); return; }
      if (spec.min != null && n < spec.min) err(path, `${n} is below the minimum ${spec.min}`);
      if (spec.max != null && n > spec.max) err(path, `${n} is above the maximum ${spec.max}`);
      if (spec.int && !Number.isInteger(n)) err(path, `${n} must be a whole number`);
    }
  };
  const value = (v) => (typeof v === "string" && v.startsWith("$") ? vars[v.slice(1)] : v);

  // Lint state, per sequence: is the loco above creep speed, and has a guard (a beam wait with a time limit) been seen since?
  function seq(steps, path, state) {
    if (!Array.isArray(steps) || !steps.length) { err(path, "needs at least one step"); return state; }
    steps.forEach((s, i) => { state = one(s, `${path}[${i}]`, state); });
    return state;
  }
  function one(s, path, state) {
    if (!s || typeof s !== "object" || Array.isArray(s)) { err(path, "a step is an object with a \"do\""); return state; }
    const def = STEPS[s.do];
    if (!def) { err(`${path}.do`, `unknown step "${s.do}" (known: ${STEP_KINDS.join(", ")})`); return state; }
    const allowed = new Set(["do", ...Object.keys(def.req || {}), ...Object.keys(def.opt || {})]);
    for (const k of Object.keys(s)) if (!allowed.has(k)) err(`${path}.${k}`, `not a field of "${s.do}" (allowed: ${[...allowed].filter((x) => x !== "do").join(", ") || "none"})`);
    for (const [k, spec] of Object.entries(def.req || {})) { if (!(k in s)) err(`${path}.${k}`, `"${s.do}" needs ${k}`); else checkValue(`${path}.${k}`, spec, s[k]); }
    for (const [k, spec] of Object.entries(def.opt || {})) if (k in s) checkValue(`${path}.${k}`, spec, s[k]);

    if (s.do === "led") {
      const rgb = ["r", "g", "b"].filter((k) => k in s).length;
      if (s.color && rgb) err(path, "use color or r/g/b, not both");
      else if (!s.color && rgb !== 3) err(path, "led needs a color, or all of r, g, b");
    }
    if (s.do === "fill" && !(("ms" in s) !== ("zone" in s))) err(path, `fill needs exactly one of ms or zone`);
    if ((s.do === "wait-zone" || (s.do === "fill" && s.zone)) && typeof (s.zone) === "string") {
      if (!layout) warn(path, "uses a zone but no layout was given to check it against");
      else if (!layout.zones?.[s.zone]) err(`${path}.zone`, `no zone "${s.zone}" in the layout (has: ${Object.keys(layout.zones || {}).join(", ") || "none"})`);
      if (!loco) warn(path, "zones need a loco profile for the position estimate");
    }
    if (s.do === "wait-approach") {
      if (layout && !layout.loopIn) err(path, "wait-approach needs layout.loopIn (the loop length) to know where the beam is");
      if (!loco) warn(path, "wait-approach needs a loco profile for the speed table");
    }
    if (["sound", "fill", "loop"].includes(s.do) && typeof s.id === "string" && sounds) {
      try { sounds.check([s.id], { files: soundFiles }); } catch (e) { err(`${path}.id`, e.message); }
    }

    // the blind-run lint
    const guardWait = s.do === "wait-for" || s.do === "creep" || s.do === "wait-zone" || s.do === "wait-approach";
    if (s.do === "ramp" && value(s.to) > CREEP_MAX) { if (!state.fast) state = { ...state, fast: true, guarded: false, at: path }; }
    else if ((s.do === "ramp" && value(s.to) <= CREEP_MAX) || s.do === "halt") {
      if (state.fast && !state.guarded) err(state.at, BLIND(state.at));
      state = { ...state, fast: false, guarded: false, calmed: true };
    }
    if (guardWait) state = { ...state, anyGuard: true, guarded: state.guarded || state.fast };
    if (s.do === "creep") state = { ...state, fast: false, guarded: false, calmed: true };   // it is its own guard, and it ends at a standstill
    if (s.do === "wait" && state.fast && value(s.ms) > 5000) warn(path, `a timed wait of ${value(s.ms)} ms while above creep speed: prefer waiting for a beam event`);
    if (s.do === "repeat" && Array.isArray(s.steps)) state = seq(s.steps, `${path}.steps`, state);
    if (s.do === "parallel") {
      if (!Array.isArray(s.branches) || !s.branches.length) err(`${path}.branches`, "needs at least one branch (a list of step lists)");
      else {
        // Branches run at the same time: a beam wait in any branch guards a ramp in another, and a slow-down in any branch
        // ends a ramp in another. This is a lint, not a proof (the runtime's motor-care rules still apply to whatever happens).
        const rs = s.branches.map((b, j) => seq(b, `${path}.branches[${j}]`, { ...state, anyGuard: false, calmed: false }));
        const anyGuard = rs.some((r) => r.anyGuard), calmed = rs.some((r) => r.calmed), fast = rs.find((r) => r.fast);
        const guarded = state.guarded || anyGuard;
        if (fast && calmed && !guarded) err(fast.at, BLIND(fast.at));
        state = { ...state, anyGuard: state.anyGuard || anyGuard, calmed: state.calmed || calmed, fast: !!fast && !calmed, guarded: guarded && !calmed ? true : false, at: fast ? fast.at : state.at };
      }
    }
    return state;
  }

  const end = seq(show.steps, "steps", { fast: false, guarded: false, anyGuard: false, calmed: false });
  if (end.fast) err(end.at, `ramps above creep speed and the show ends with the loco still running: end with halt or a ramp to creep`);
  return { errors, warnings };
}
