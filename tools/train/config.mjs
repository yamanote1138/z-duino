#!/usr/bin/env node
// What settings are in effect, and where each value came from.
//
//   node config.mjs             print every setting (default / file / env / flag)
//   node config.mjs --example   print the documented template for local/config.jsonc
//   node config.mjs --write-example   (re)write config.example.jsonc from the settings table
// Any flag that sets a value (--volume=0.3 ...) is applied, so you can see its effect.
import { writeFileSync } from "node:fs";
import { ConfigError, SCHEMA, exampleConfigText, loadConfig } from "./lib/config/index.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--example")) process.stdout.write(exampleConfigText());
else if (argv.includes("--write-example")) { writeFileSync(new URL("./config.example.jsonc", import.meta.url), exampleConfigText()); console.log("wrote config.example.jsonc"); }
else {
  try {
    const c = loadConfig({ argv });
    console.log(`file: ${c.file}`);
    for (const [g, keys] of Object.entries(SCHEMA)) for (const k of Object.keys(keys)) {
      const v = c[g][k], src = c.sources[`${g}.${k}`];
      console.log(`  ${`${g}.${k}`.padEnd(18)} ${(v === null ? "(auto)" : JSON.stringify(v)).padEnd(34)} ${src}`);
    }
  } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
}
