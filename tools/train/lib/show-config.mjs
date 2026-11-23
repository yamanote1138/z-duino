// Settings for signal-show.mjs, in one place. Everything the show does that is a number, a clip name or a distance lives here.
//
// Override, lowest to highest priority:  DEFAULTS  <  --config=<file.json> (deep-merged)  <  --key=value flags
//   --sound.gain.hum=0.4        dotted keys reach into nested settings
//   --creep=6  --cruise=8.8  --creep-out=3  --volume=0.5  --curves=5.5-12,37-57,104-124      (short aliases)
//   --sound  --party  --dry  --loco  --allow-fast                                              (switches)
// Print the resolved settings without touching hardware:  node lib/show-config.mjs [flags]

export const DEFAULTS = {
  // ---- switches (set by flags) ----
  dry: false, loco: false, sound: false, party: false, allowFast: false,

  // ---- track and loco ----
  loopIn: 134,            // loop length, inches (from the lap period and the loco length)
  curves: "5.5-12,37-57,104-124",   // inches from the sensor, in the direction of travel: start-end pairs
  maxInS: 9.0,            // derailment guard on the cruise target (override with allowFast)

  // ---- driving ----
  cruiseInS: 8.8,         // cruise target, in/s (loco mode)
  creepTargetS: 4,        // seconds of creep aimed for before the beam (loco mode)
  creepOutS: 3,           // seconds at creep speed on leaving, before climbing to cruise
  creepMaxMs: 12000,      // give up creeping toward the beam after this long
  lap1TimeoutMs: 34000,   // give up if loop 1 never ends
  fallbackAfterNoseMs: 12700,   // ramp-down delay used only if the measured lap looks wrong

  // ---- light and pauses ----
  hold: { redStartMs: 3000, yellowStartMs: 1000, redEndMs: 4000, blueEndMs: 1500, blueEndSoundMs: 2200 },
  minPassLedMs: 500,      // hold the pass colour at least this long

  // ---- sound (only with --sound) ----
  soundSet: {
    volume: 0.5,
    gain: { hum: 0.6, pass: 1.0, run: 0.6, runCreep: 0.4, brakeSqueal: 0.7, brakeLoosen: 0.8, flange: 0.4 },   // times the volume
    runStartMs: 6800,     // the running loop takes over this long after dispatch (as the start-up clip ends)
    runCreepMs: 4800,     // the quiet running loop returns this long after the slow-down starts
    flangeCutS: 0.1,      // each squeal is cut this long before its curve ends
    flangeVary: 0.2,      // squeal volume varies by this fraction either way
    flangeOverlapS: 0.1,  // next squeal starts this long before the last one ends
    clips: {
      idle: "hum", chime: "chime", brakeStart: "brake_departure", horn: "horn", pass: "horn_pass",
      accel: "accel_e235", run: "run_siv", decel: "decel_e235",
      brakeSqueal: "brake_squeal", brakeLoosen: "brake_yurume", air: "air",
      flanges: [["flange_1", 1130], ["flange_2", 1870], ["flange_9", 870], ["flange_12", 1290]],   // [file, length ms]
    },
  },
};

const ALIASES = { volume: "soundSet.volume", creep: "creepTargetS", cruise: "cruiseInS", "creep-out": "creepOutS", "allow-fast": "allowFast" };
const SWITCHES = new Set(["dry", "loco", "sound", "party", "allow-fast", "allowFast"]);

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function merge(base, over) {
  for (const [k, v] of Object.entries(over)) base[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return base;
}
function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (v.startsWith("[") || v.startsWith("{")) return JSON.parse(v);
  return v;
}
function setPath(o, path, value) {
  const keys = path.split(".");
  let at = o;
  for (const k of keys.slice(0, -1)) { if (!isObj(at[k])) throw new Error(`unknown setting ${path}`); at = at[k]; }
  const last = keys[keys.length - 1];
  if (!(last in at)) throw new Error(`unknown setting ${path}`);
  at[last] = value;
}

export function loadShowConfig(argv, readFile) {
  const cfg = structuredClone(DEFAULTS);
  const flags = argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2));
  const file = flags.find((f) => f.startsWith("config="));
  if (file) merge(cfg, JSON.parse(readFile(file.slice(7))));
  for (const f of flags) {
    if (f.startsWith("config=")) continue;
    const eq = f.indexOf("="), key = eq < 0 ? f : f.slice(0, eq);
    if (eq < 0) { if (!SWITCHES.has(key)) throw new Error(`--${key} needs a value (--${key}=...)`); setPath(cfg, ALIASES[key] || key, true); continue; }
    setPath(cfg, ALIASES[key] || key, coerce(f.slice(eq + 1)));
  }
  return cfg;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  console.log(JSON.stringify(loadShowConfig(process.argv.slice(2), (p) => readFileSync(p, "utf8")), null, 2));
}
