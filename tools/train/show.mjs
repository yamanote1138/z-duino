#!/usr/bin/env node
// Check, simulate and run a show (a z-show/1 JSON file).
//
//   node show.mjs list                         shows in local/shows and examples/shows
//   node show.mjs validate <show>              check it (fields, sounds, zones, blind runs); moves and plays nothing
//   node show.mjs sim <show>                   run it on a virtual clock with a ghost sensor: prints the timeline, moves and plays nothing
//   node show.mjs run <show>                   run it for real: the controller, the sensor on the serial port, sounds on this Mac
//
// <show> is a path, or a name found in local/shows/ or examples/shows/ (with or without .json).
// Options: --layout=<file> (default local/layout.json)   --loco=<file> (default local/loco_profile.json)
//          --packs=packs/synth,packs/jr-east   --engine=afplay|null (run)   --volume=0.5   --set=name=value (repeatable)
//          --no-sound (run: same as --engine=null)
//          --reset (run: put the loco on the mark first: back off and come forward, search nearby, or run the loop; see lib/track)
// Ctrl-C during a run stops the show and ramps the loco down; a second Ctrl-C is an emergency stop.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadShow, loadLayout, loadLoco, validateLayout, validateShow, simulateShow, runShow, usesZones, soundsUsed } from "./lib/show/index.mjs";
import { defaultSounds } from "./lib/sound/defaults.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { localPath } from "./lib/paths.mjs";

const root = dirname(fileURLToPath(import.meta.url)) + "/";
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const sets = argv.filter((a) => a.startsWith("--set=")).map((a) => a.slice(6));
const [cmd, which] = pos;

const config = loadConfigOrExit(argv);
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
const showDirs = [localPath("shows"), root + "examples/shows"];

function findShow(name) {
  if (!name) fail("which show? (node show.mjs list)");
  for (const c of [name, `${name}.json`, ...showDirs.flatMap((d) => [join(d, name), join(d, `${name}.json`)])]) if (existsSync(c) && statSync(c).isFile()) return resolve(c);
  fail(`no show "${name}" (looked in ${showDirs.join(", ")}); node show.mjs list`);
}
function parseSettings() {
  const out = {};
  for (const s of sets) { const [k, v] = s.split("="); if (!k || v === undefined || Number.isNaN(Number(v))) fail(`--set wants name=number (got "${s}")`); out[k] = Number(v); }
  return out;
}
function context(needZones) {
  let layout = null, loco = null;
  const lf = flags.layout || localPath("layout.json"), cf = flags.loco || localPath("loco_profile.json");
  const dry = cmd !== "run";   // validate and sim may use the example layout and loco until yours exist; a real run never does
  if (existsSync(lf)) { layout = loadLayout(lf); const e = validateLayout(layout); if (e.length) fail(`layout ${lf}:\n  ${e.join("\n  ")}`); }
  else if (flags.layout) fail(`no layout at ${lf}`);
  else if (dry) { layout = loadLayout(root + "examples/layout.example.json"); console.log("(no local/layout.json yet: using the example layout)"); }
  if (existsSync(cf)) loco = loadLoco(cf);
  else if (flags.loco) fail(`no loco profile at ${cf}`);
  else if (dry) { loco = loadLoco(root + "examples/loco.example.json"); console.log("(no local/loco_profile.json yet: using the example loco profile)"); }
  return { layout, loco };
}
function soundLibrary(engine) {
  return defaultSounds({ engine, volume: config.sound.volume, packs: config.sound.packs, onSkip: (p, e) => console.error(`skipping pack ${p}: ${e.message}`) });
}
function report(check) {
  for (const w of check.warnings) console.log(`warning: ${w}`);
  if (check.errors.length) { console.error(`${check.errors.length} problem${check.errors.length > 1 ? "s" : ""}:\n  ${check.errors.join("\n  ")}`); process.exit(1); }
}

if (cmd === "list") {
  for (const d of showDirs) {
    let files = []; try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { /* none yet */ }
    console.log(`${d.replace(root, "")}${files.length ? "" : "  (none)"}`);
    for (const f of files) { try { const s = loadShow(join(d, f)); console.log(`  ${f.replace(/\.json$/, "").padEnd(18)} ${s.name}${s.description ? ` — ${s.description.slice(0, 80)}` : ""}`); } catch (e) { console.log(`  ${f.padEnd(18)} (unreadable: ${e.message})`); } }
  }
} else if (cmd === "validate" || cmd === "sim" || cmd === "run") {
  const file = findShow(which), show = loadShow(file), settings = parseSettings();
  const { layout, loco } = context();
  const engine = cmd !== "run" || argv.includes("--no-sound") ? "null" : config.sound.engine;
  const sounds = soundLibrary(engine);
  const check = validateShow(show, { sounds, layout, loco, settings, soundFiles: cmd === "run" });
  if (cmd !== "run") { const miss = sounds.missingFiles(soundsUsed(show)); if (miss.length) check.warnings.push(`${miss.length} sound file${miss.length > 1 ? "s are" : " is"} not on this machine (a real run needs ${miss.length > 1 ? "them" : "it"}; see import-sounds.py): ${[...new Set(miss.map((m) => m.split(" ")[0]))].join(", ")}`); }
  console.log(`${show.name}  (${file.replace(root, "")})`);
  report(check);
  if (cmd === "validate") console.log(`ok: ${check.warnings.length ? `${check.warnings.length} warning(s)` : "no problems"}`);
  else if (cmd === "sim") {
    const r = await simulateShow(show, { layout, loco, sounds, settings });
    for (const e of r.log) console.log(`${(e.t / 1000).toFixed(2).padStart(7)} s  ${e.text}`);
    console.log(`\n${r.ok ? "finished" : `FAILED: ${r.error}`} after ${(r.elapsedMs / 1000).toFixed(1)} simulated seconds; top throttle ${r.maxSpeed}; ${r.commands.length} controller commands, ${r.sounds.length} sound calls`);
    console.log("(the sensor here is a ghost: events arrive on a fixed delay, so check the order and the commands, not the timing)");
    process.exit(r.ok ? 0 : 1);
  } else {
    const { createSensor, SerialSource } = await import("./lib/sensor/index.mjs");
    const { connectController } = await import("./lib/controller/index.mjs");
    const source = new SerialSource(config.sensor);
    const sensor = createSensor({ source });
    sensor.on("error", (e) => { console.error("sensor error:", e.message); });
    await sensor.start();
    await new Promise((r) => setTimeout(r, 1200));
    if (sensor.lastReading == null) fail(`no readings: ${source.lastError ? source.lastError.message : "the port is silent"}`);
    console.log(`sensor: ${sensor.state}, reading ${sensor.lastReading}`);
    const ctl = await connectController({ config });
    const ac = new AbortController();
    if (argv.includes("--reset")) {
      const { returnToMark } = await import("./lib/track/index.mjs");
      console.log("--reset: putting the loco on the mark first");
      const m = await returnToMark({ controller: ctl, sensor, loopIn: layout ? layout.loopIn : undefined, onLog: (e) => console.log(`${(e.t / 1000).toFixed(2).padStart(7)} s  ${e.text}`) });
      if (!m.ok) { await ctl.close(); sensor.stop(); fail(`could not put the loco on the mark: ${m.error}`); }
    }
    let interrupts = 0;
    process.on("SIGINT", () => { if (++interrupts === 1) { console.log("\nstopping the show (ramping down); Ctrl-C again for an emergency stop"); ac.abort(); } else { ctl.emergencyStop(); process.exit(130); } });
    let code = 0;
    try {
      const r = await runShow(show, { controller: ctl, sensor, sound: sounds, layout, loco, settings, signal: ac.signal, onLog: (e) => console.log(`${(e.t / 1000).toFixed(2).padStart(7)} s  ${e.text}`) });
      console.log(`\nfinished in ${(r.elapsedMs / 1000).toFixed(1)} s`);
    } catch (e) { console.error(`\nFAILED: ${e.message}`); code = 1; }
    await ctl.close(); sensor.stop();
    process.exit(code);
  }
} else {
  console.log("usage: node show.mjs list | validate <show> | sim <show> | run <show>   (see the header of show.mjs for options)");
}
