// Settings for the Mac-side tools: one place that says what can be configured, what it defaults to, and where a value came from.
//
//   const config = loadConfig({ argv: process.argv.slice(2) });
//   config.controller.port, config.sound.volume, ...
//
// Precedence, lowest to highest:   built-in defaults  <  local/config.jsonc  <  environment variables  <  command-line flags
//
//   local/config.jsonc   your own settings: JSON with // and /* */ comments and trailing commas allowed (data only, nothing
//                        in it is executed). config.example.jsonc documents every key; it is generated from the table below
//                        (`node config.mjs --example`), and a test keeps the committed copy in step.
//   environment          TRAIN_HOST, SENSOR_PORT (and TRAIN_LOCAL, which picks the local/ folder that holds the file)
//   flags                --host= --sensor-port= --port= --volume= --engine= --packs= --invert=   (other flags belong to the script)
//
// A wrong key or value is an error that names it, so a typo fails loudly instead of being ignored. Modules never read this
// themselves: entry scripts load it once and hand the pieces on.
//
// Not here: the beam levels (local/sensor_levels.json; BEAM_CLEAR / BEAM_BLOCKED override them, handled by lib/sensor), the
// loco, the layout and the shows. Those are data about your track, not settings.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCAL_DIR } from "../paths.mjs";

export const CONFIG_FILE = "config.jsonc";

const str = (doc, extra = {}) => ({ type: "string", nullable: true, default: null, doc, ...extra });
const int = (def, min, max, doc, extra = {}) => ({ type: "integer", default: def, min, max, doc, ...extra });
const num = (def, min, max, doc, extra = {}) => ({ type: "number", default: def, min, max, doc, ...extra });

/** Every setting: its type, default and documentation. `env` and `flag` say how else it can be set. */
export const SCHEMA = {
  controller: {
    host: str("The Wemos controller's address. Left empty, ztrain.local is looked up and its IP used (mDNS names are unreliable for the WebSocket).", { env: "TRAIN_HOST", flag: "host" }),
    port: int(81, 1, 65535, "The controller's WebSocket port."),
    pingMs: int(5000, 100, 25000, "Keepalive ping interval. The firmware stops the motor after 30 s of silence, so keep this well under that."),
    invert: { type: "boolean", nullable: true, default: null, flag: "invert", doc: "Motor direction invert, sent to the controller when a tool connects. Left empty, nothing is sent and the controller keeps whatever it has (it forgets on every reboot, and the web app sets it per browser; the controller has one flag, so whoever connected last wins)." },
    led: { type: "autobool", default: "auto", flag: "led", doc: "Whether the controller has the optional RGB status LED. \"auto\" asks the controller (it reports features.led; older firmware reports nothing and is assumed to have one). true or false forces it. Without an LED, led and led-auto show steps are skipped." },
  },
  sensor: {
    port: str("The sensor Arduino's serial port, e.g. /dev/cu.usbmodem1101. Left empty, the only /dev/cu.usbmodem* present is used (and found again if macOS renames it after a replug).", { env: "SENSOR_PORT", flag: "sensor-port" }),
    baud: int(115200, 300, 4000000, "Serial speed. Must match the sensor sketch."),
  },
  web: {
    port: int(4040, 0, 65535, "The web page's port (serve.mjs). 0 picks a free one. It only listens on 127.0.0.1.", { flag: "port" }),
  },
  sound: {
    volume: num(0.5, 0, 1.5, "Master volume for every sound.", { flag: "volume" }),
    engine: { type: "string", default: "afplay", flag: "engine", doc: "What plays the sounds: afplay (macOS) or null (silent)." },
    packs: { type: "list", default: ["packs/synth", "packs/jr-east"], flag: "packs", doc: "Sound packs to load, later ones winning. A relative path is under tools/train/, an absolute path is used as is, and local:name means local/name (so your own packs can live in local/packs/)." },
  },
};

export const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([g, keys]) => [g, Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, structuredClone(s.default)]))]));

export class ConfigError extends Error {
  constructor(problems) { super(`configuration problem${problems.length > 1 ? "s" : ""}:\n  ${problems.join("\n  ")}`); this.name = "ConfigError"; this.problems = problems; }
}

// ---- the file: JSON with comments ----

// Strip line comments, block comments and trailing commas (string-aware), leaving plain JSON.
export function stripJsonc(text) {
  text = text.replace(/^﻿/, "");
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); if (e < 0) throw new Error("a /* comment is never closed"); i = e + 2; out += " "; continue; }
    if (c === "}" || c === "]") { let j = out.length - 1; while (j >= 0 && /\s/.test(out[j])) j--; if (out[j] === ",") out = out.slice(0, j) + out.slice(j + 1); }
    out += c; i++;
  }
  return out;
}

export function parseConfigText(text) {
  const stripped = stripJsonc(text);
  if (!stripped.trim()) return {};
  const v = JSON.parse(stripped);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the top level must be an object");
  return v;
}

// ---- checking and converting values ----

const dist = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const nearest = (word, options) => { const best = options.map((o) => [o, dist(word.toLowerCase(), o.toLowerCase())]).sort((x, y) => x[1] - y[1])[0]; return best && best[1] <= 2 ? best[0] : null; };

/** Check a value against a setting's spec: the problem as text, or null. */
function check(spec, v) {
  if (v === null) return spec.nullable ? null : "must not be empty";
  switch (spec.type) {
    case "string": return typeof v === "string" && v ? null : "must be a non-empty string";
    case "boolean": return typeof v === "boolean" ? null : "must be true or false";
    case "autobool": return v === "auto" || typeof v === "boolean" ? null : "must be \"auto\", true or false";
    case "list": return Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x) ? null : "must be a list of one or more strings";
    case "number": case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) return "must be a number";
      if (spec.type === "integer" && !Number.isInteger(v)) return "must be a whole number";
      if (v < spec.min || v > spec.max) return `must be between ${spec.min} and ${spec.max}`;
      return null;
    }
  }
  return null;
}

/** Turn an environment or flag string into the setting's type (the result is checked afterwards like any other value). */
function coerce(spec, s) {
  if (s === "null" || s === "") return spec.nullable ? null : s;
  switch (spec.type) {
    case "boolean": return s === "true" ? true : s === "false" ? false : s;
    case "autobool": return s === "true" ? true : s === "false" ? false : s;
    case "number": case "integer": return s.trim() !== "" && !Number.isNaN(Number(s)) ? Number(s) : s;
    case "list": return s.split(",").map((x) => x.trim()).filter(Boolean);
    default: return s;
  }
}

const leaves = () => Object.entries(SCHEMA).flatMap(([g, keys]) => Object.entries(keys).map(([k, spec]) => ({ g, k, spec, path: `${g}.${k}` })));

/**
 * Resolve the settings. Everything is injectable for tests. Returns a frozen object (config.sound.volume, ...) with a
 * non-enumerable `sources` map from "group.key" to "default" | "file" | "env" | "flag".
 */
export function loadConfig({ env = process.env, argv = [], localDir = null, readFile = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  const dir = localDir || (env.TRAIN_LOCAL ? resolve(env.TRAIN_LOCAL) : LOCAL_DIR);
  const file = join(dir, CONFIG_FILE);
  const problems = [];
  const values = Object.fromEntries(leaves().map(({ path, spec }) => [path, structuredClone(spec.default)]));
  const sources = Object.fromEntries(leaves().map(({ path }) => [path, "default"]));
  const set = (path, spec, v, source, label) => { const bad = check(spec, v); if (bad) problems.push(`${label}: ${path} ${bad}${typeof v === "string" ? ` (got "${v}")` : ""}`); else { values[path] = v; sources[path] = source; } };

  // the file
  if (exists(file)) {
    let parsed = null;
    try { parsed = parseConfigText(readFile(file)); } catch (e) { problems.push(`${file}: ${e.message}`); }
    for (const [g, group] of Object.entries(parsed || {})) {
      if (!SCHEMA[g]) { const m = nearest(g, Object.keys(SCHEMA)); problems.push(`${file}: unknown section "${g}"${m ? ` (did you mean "${m}"?)` : ` (sections: ${Object.keys(SCHEMA).join(", ")})`}`); continue; }
      if (!group || typeof group !== "object" || Array.isArray(group)) { problems.push(`${file}: "${g}" must be an object`); continue; }
      for (const [k, v] of Object.entries(group)) {
        if (!SCHEMA[g][k]) { const m = nearest(k, Object.keys(SCHEMA[g])); problems.push(`${file}: unknown setting ${g}.${k}${m ? ` (did you mean "${g}.${m}"?)` : ""}`); continue; }
        set(`${g}.${k}`, SCHEMA[g][k], v, "file", file);
      }
    }
  }
  // the environment
  for (const { path, spec } of leaves()) if (spec.env && env[spec.env] !== undefined && env[spec.env] !== "") set(path, spec, coerce(spec, env[spec.env]), "env", `environment ${spec.env}`);
  // flags
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(a); if (!m) continue;
    const hit = leaves().find(({ spec }) => spec.flag === m[1]);
    if (hit) set(hit.path, hit.spec, coerce(hit.spec, m[2]), "flag", `flag --${m[1]}`);
  }
  if (problems.length) throw new ConfigError(problems);

  const config = {};
  for (const { g, k, path } of leaves()) (config[g] ||= {})[k] = values[path];
  for (const g of Object.keys(config)) Object.freeze(config[g]);
  Object.defineProperty(config, "sources", { value: Object.freeze(sources), enumerable: false });
  Object.defineProperty(config, "file", { value: file, enumerable: false });
  return Object.freeze(config);
}

/** The documented template for local/config.jsonc: every setting commented out at its default. Written from SCHEMA so it cannot drift. */
export function exampleConfigText() {
  const wrap = (s, width = 100) => { const words = s.split(" "), lines = []; let cur = ""; for (const w of words) { if ((cur + " " + w).trim().length > width) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); } if (cur) lines.push(cur); return lines; };
  const out = [
    "// Z-Duino tools: your settings.",
    "//",
    "// Copy this file to local/config.jsonc and uncomment (remove the leading //) what you want to change; anything left",
    "// commented out keeps its default. Comments and trailing commas are fine in this file.",
    "//",
    "// Precedence: built-in defaults < this file < environment variables < command-line flags.",
    "// `node config.mjs` prints what is in effect and where each value came from.",
    "{",
  ];
  const groups = Object.entries(SCHEMA);
  groups.forEach(([g, keys], gi) => {
    out.push(`  "${g}": {`);
    const entries = Object.entries(keys);
    entries.forEach(([k, spec], ki) => {
      for (const l of wrap(spec.doc, 96)) out.push(`    // ${l}`);
      const how = [spec.env ? `env ${spec.env}` : null, spec.flag ? `flag --${spec.flag}=` : null].filter(Boolean).join(", ");
      if (how) out.push(`    // Also settable by: ${how}.`);
      const range = spec.min !== undefined ? ` Range ${spec.min} to ${spec.max}.` : "";
      if (range) out.push(`    //${range}`);
      out.push(`    // "${k}": ${JSON.stringify(spec.default)}${ki < entries.length - 1 ? "," : ""}`);
      if (ki < entries.length - 1) out.push("");
    });
    out.push(`  }${gi < groups.length - 1 ? "," : ""}`);
    if (gi < groups.length - 1) out.push("");
  });
  out.push("}", "");
  return out.join("\n");
}

/** For entry scripts: load the settings, or print what is wrong with them (naming the key) and exit. */
export function loadConfigOrExit(argv = process.argv.slice(2), opts = {}) {
  try { return loadConfig({ argv, ...opts }); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
}
