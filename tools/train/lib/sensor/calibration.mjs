// Calibration: measuring the open-beam and blocked levels, deriving a levels record, and keeping it in a file.
// The module cannot move the train, so the caller supplies the steps ("get the beam clear", "put the loco in it"):
// a person pressing Enter, or a controller doing a guarded shuttle.

import { readFileSync, writeFileSync } from "node:fs";
import { localFile } from "../paths.mjs";

export const DEFAULT_FILE = localFile("sensor_levels.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Levels from the file (or env BEAM_CLEAR / BEAM_BLOCKED), or null if there is no usable calibration. */
export function loadLevels(file = DEFAULT_FILE, env = process.env) {
  let l = null;
  try { l = JSON.parse(readFileSync(file, "utf8")); } catch { /* no file */ }
  if (env.BEAM_CLEAR || env.BEAM_BLOCKED) l = { ...(l || {}), ...(env.BEAM_CLEAR ? { clear: Number(env.BEAM_CLEAR) } : {}), ...(env.BEAM_BLOCKED ? { blocked: Number(env.BEAM_BLOCKED) } : {}) };
  return l && l.clear > l.blocked ? l : null;
}
export function saveLevels(levels, file = DEFAULT_FILE) { writeFileSync(file, JSON.stringify(levels, null, 2) + "\n"); }

export function summarize(values) {
  if (!values.length) throw new Error("no readings to summarise");
  const s = [...values].sort((a, b) => a - b), n = s.length, m = s.reduce((a, b) => a + b, 0) / n;
  return { n, median: s[Math.floor(n / 2)], mean: m, sd: Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n), min: s[0], max: s[n - 1] };
}

/** Collect readings for `ms` from a started sensor and summarise them. Waits `settleMs` first (the loco has just stopped moving). */
export async function measure(sensor, { ms = 2500, settleMs = 400 } = {}) {
  await sleep(settleMs);
  return summarize((await sensor.collect(ms)).map((x) => x.v));
}

/** Build a levels record from the two measurements. Throws if they cannot be told apart; `warnings` lists soft problems. */
export function deriveLevels(clear, blocked, { minSpan = 60, maxNoiseFrac = 0.05 } = {}) {
  const span = clear.median - blocked.median;
  if (span < minSpan) throw new Error(`blocked (${blocked.median}) and clear (${clear.median}) are only ${span} counts apart (need ${minSpan}+): is the emitter on, is the loco really in the beam, is the beam clear in the other step?`);
  const warnings = [];
  if (clear.sd > maxNoiseFrac * span) warnings.push(`the clear reading is noisy (sd ${clear.sd.toFixed(1)}, ${(100 * clear.sd / span).toFixed(0)}% of the span)`);
  if (blocked.sd > maxNoiseFrac * span) warnings.push(`the blocked reading is noisy (sd ${blocked.sd.toFixed(1)})`);
  if (clear.max - clear.min > 0.3 * span) warnings.push(`the clear reading wandered from ${clear.min} to ${clear.max} during the measurement`);
  return { levels: { clear: clear.median, blocked: blocked.median, noise: { clearSd: +clear.sd.toFixed(2), blockedSd: +blocked.sd.toFixed(2) }, measuredAt: new Date().toISOString(), version: 1 }, warnings };
}

/**
 * Run a calibration on a started sensor.
 *   clearStep / blockedStep: async functions that put the world in that state and return when it is steady.
 * Saves to `file` unless save is false, and applies the result to the sensor.
 */
export async function calibrate(sensor, { clearStep, blockedStep, file = DEFAULT_FILE, save = true, ms, settleMs } = {}) {
  if (!clearStep || !blockedStep) throw new Error("calibrate needs clearStep and blockedStep");
  await clearStep();
  const clear = await measure(sensor, { ms, settleMs });
  await blockedStep();
  const blocked = await measure(sensor, { ms, settleMs });
  const { levels, warnings } = deriveLevels(clear, blocked);
  if (save) saveLevels(levels, file);
  sensor.setLevels(levels);
  return { levels, clear, blocked, warnings };
}
