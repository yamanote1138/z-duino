#!/usr/bin/env node
// Audition and check the sound library. Never touches the train.
//
//   node sound-test.mjs list [category]                 what is loaded (id, category, variants, length)
//   node sound-test.mjs play <id|category> [--times=3] [--gain=1] [--seconds=2]
//   node sound-test.mjs fill <id|category> <ms> [--cut=100] [--overlap=0]     clips back to back for ms
//   node sound-test.mjs loop <id|category> [--for=6]    loop a sound for a few seconds
//   node sound-test.mjs check <id|category> ...         exit 1 if anything is unknown or its file is missing
// Options: --packs=packs/synth,packs/jr-east   --volume=0.5   --engine=afplay|null   (or sound.* in local/config.jsonc)
import { defaultSounds } from "./lib/sound/defaults.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";

const argv = process.argv.slice(2), flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "true"] = a.slice(2).split("="); return [k, v]; }));
const pos = argv.filter((a) => !a.startsWith("--")), cmd = pos[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = loadConfigOrExit(argv);   // --packs= --volume= --engine= and sound.* in local/config.jsonc
const lib = defaultSounds({ engine: config.sound.engine, volume: config.sound.volume, packs: config.sound.packs, onSkip: (p, e) => console.error(`skipping ${p}: ${e.message}`) });
process.on("SIGINT", () => { lib.stopAll(); process.exit(130); });

if (!cmd || cmd === "list") {
  const rows = Object.values(lib.entries).filter((e) => !pos[1] || e.category === pos[1]).sort((a, b) => a.id.localeCompare(b.id));
  for (const e of rows) console.log(`${e.id.padEnd(22)} ${e.category.padEnd(13)} ${String(e.variants.length).padStart(2)} variant${e.variants.length === 1 ? " " : "s"}  ${String(lib.duration(e.id) ?? "?").padStart(6)} ms${e.loop ? "  loop" : ""}  [${e.pack}]`);
  console.log(`\ncategories: ${lib.categories().join(", ")}`);
} else if (cmd === "play") {
  if (!pos[1]) { console.error("play what? e.g. node sound-test.mjs play flange --times=3"); process.exit(1); }
  for (let i = 0; i < Number(flags.times || 1); i++) {
    const c = lib.choose(pos[1], { gain: Number(flags.gain || 1) }); console.log(`${c.entry.id} / ${c.variant.file}  ${c.duration ?? "?"} ms  volume ${c.volume.toFixed(2)}`);
    await lib._start(c, { seconds: flags.seconds ? Number(flags.seconds) : undefined }).done; await sleep(400);
  }
} else if (cmd === "fill") {
  const h = lib.fill(pos[1], { ms: Number(pos[2]), cutMs: Number(flags.cut || 0), overlapMs: Number(flags.overlap || 0) });
  for (const s of h.plan) console.log(`  +${String(s.at).padStart(5)} ms  ${s.clip.entry.id} / ${s.clip.variant.file}  ${s.playMs} ms`);
  await h.done;
} else if (cmd === "loop") {
  lib.loop("test", pos[1]); await sleep(Number(flags.for || 6) * 1000); lib.stop("test");
} else if (cmd === "check") {
  try { lib.check(pos.slice(1)); console.log("ok"); } catch (e) { console.error(e.message); process.exit(1); }
} else { console.error(`unknown command ${cmd}`); process.exit(1); }
lib.stopAll(); process.exit(0);
