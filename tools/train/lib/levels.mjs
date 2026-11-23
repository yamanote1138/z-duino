// Beam thresholds, scaled from two measured readings.
//
// The A0 numbers depend on the emitter/receiver distance, aim and the receiver resistor, so no script
// hard-codes a count. Everything is placed as a fraction of the span between "blocked" and "clear":
//   clear   - beam open (nothing between the domes)
//   blocked - a solid loco sitting in the beam
// Both come from sensor_levels.json next to this lib's parent folder (re-measure after moving the
// sensor), or from BEAM_CLEAR / BEAM_BLOCKED in the environment.
//
// Fractions are the old photoresistor thresholds (clear 983, blocked ~160, trip 800, wall 760, ...) re-expressed
// on the same scale, so behaviour matches what the scripts were tuned for.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../sensor_levels.json", import.meta.url));

function load() {
  let base = { clear: 344, blocked: 30 };
  try { base = { ...base, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { /* use defaults */ }
  if (process.env.BEAM_CLEAR) base.clear = Number(process.env.BEAM_CLEAR);
  if (process.env.BEAM_BLOCKED) base.blocked = Number(process.env.BEAM_BLOCKED);
  if (!(base.clear > base.blocked + 50)) throw new Error(`sensor levels look wrong: clear ${base.clear}, blocked ${base.blocked}`);
  return base;
}

const { clear, blocked } = load();
const span = clear - blocked;
const at = (f) => Math.round(blocked + f * span);

export const LEVELS = {
  clear, blocked,
  plateauMin: at(0.5),                                  // flat above this = beam open (a loco parked in the beam is flat far below)
  plateauSpread: Math.max(6, Math.round(clear * 0.006)),
  noseDrop: Math.max(10, Math.round(clear * 0.045), Math.round(span * 0.12)),    // a fall starts this far below the clear level
  leaveDelta: Math.max(10, Math.round(clear * 0.04)),   // moved off the parked reading by this much
  trip: at(0.78),                                       // below this = something is in the beam (old 800)
  wall: at(0.72),                                       // below this = wall, windows stay above it (old 760)
  clearMin: at(0.9),                                    // required before a start (old 900)
  solidMax: at(0.65),                                   // a pass that never rises above this is solid (old 700)
  parkedMax: at(0.4),                                   // loco counts as sitting in the beam below this (old 500)
};
