#!/usr/bin/env node
// Find out which way "forward" is on your track, and save it.
//
//   node orient.mjs            (run it in your own terminal: it asks you two questions)
//
// "Forward" is the loco's front (the nose) leading; it is the way your layout and shows are written, and `--direction=reverse`
// turns a show round. Which way the controller's forward really moves the loco depends on the track's polarity and the motor
// leads, so this checks it and, if the nose does not lead, flips the controller's invert flag and checks again.
//
// Start with the loco on a mark (the beam blocked, either end in it). It creeps forward a few inches, as far as the beam lets it
// (until the beam clears, 8 s at most), then back until the beam breaks again: every move is stopped by the beam, never by a
// timer alone, and works whichever end goes first. You say which end led and which way it went as you face the layout.
//
// Writes local/orientation.json (see lib/config): `invert` is sent to the controller whenever a tool connects, below
// local/config.jsonc, the environment and flags; `forwardMoves` ("right" or "left") only labels directions for people.
//
// The controller has one invert flag and the throttle app sends its own when it connects, so whichever connected last wins.
// If the app's invert toggle was on when you calibrated, turn it off again afterwards, or calibrate with the app closed.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createSensor, SerialSource } from "./lib/sensor/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { decideInvert, orientationRecord } from "./lib/track/index.mjs";
import { localFile } from "./lib/paths.mjs";

const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
if (!process.stdin.isTTY) fail("run this in a terminal: it asks you questions");

const config = loadConfigOrExit();
const sensor = createSensor({ source: new SerialSource(config.sensor) });
sensor.on("error", (e) => console.error("sensor error:", e.message));
await sensor.start();
await new Promise((r) => setTimeout(r, 1200));
if (sensor.state !== "blocked") { sensor.stop(); fail(`the beam is ${sensor.state} (reading ${sensor.lastReading ?? "?"}): put the loco on a mark first (node nudge.mjs to-mark)`); }

let invert = config.controller.invert ?? false;
const ctl = await connectController({ config, invert });
const lost = new Promise((res) => sensor.on("lost", res));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, ok) => { for (;;) { const a = (await rl.question(q)).trim().toLowerCase(); if (ok.includes(a)) return a; console.log(`  (answer with one of: ${ok.join(" / ")})`); } };
const quit = async (code, msg) => { if (msg) console.log(msg); try { ctl.setSpeed(0); } catch { /* stopped */ } rl.close(); await ctl.close(); sensor.stop(); process.exit(code); };
process.on("SIGINT", () => { try { ctl.emergencyStop(); } catch { /* gone */ } process.exit(130); });

// forward a few inches as far as the beam lets it, then back until it breaks again; both beam-guarded
async function shuffle() {
  sensor.setDirection("forward");
  const out = await ctl.guardedMove({ forward: true, speed: ctl.config.creepMax, maxMs: 8000, until: () => sensor.waitFor("restore", { timeoutMs: 8500 }), abort: lost });
  if (out.result !== "guard") return `the beam did not clear (${out.result})`;
  await new Promise((r) => setTimeout(r, 800));
  sensor.setDirection("reverse");
  const back = await ctl.guardedMove({ forward: false, speed: ctl.config.creepMax, maxMs: 8000, until: () => sensor.waitFor("break", { timeoutMs: 8500 }), abort: lost });
  return back.result === "guard" ? null : `could not find the beam again (${back.result})`;
}

console.log(`
Which way is forward? The loco will creep FORWARD a few inches, stop, and come back. Watch it:
  1. which END goes first: the front (nose, the cab or headlight end), or the back?
  2. which way does it move as you face the layout: to the RIGHT or to the LEFT?
Controller invert in use: ${invert} (${config.sources["controller.invert"]}). It only moves while the beam is blocked or being found again, at creep speed.
`);
if ((await ask("Press ENTER to start, or q to quit: ", ["", "q"])) === "q") await quit(0, "Not started: nothing moved.");

let forwardMoves = null;
for (let attempt = 1; attempt <= 2; attempt++) {
  const err = await shuffle();
  if (err) await quit(1, `\nStopped: ${err}. The loco is stopped; nothing was saved. Put it on a mark and run this again.`);
  const front = await ask("Which end went first, the (f)ront or the (b)ack? ", ["f", "b"]);
  const dir = await ask("As you face the layout, did it move to the (r)ight or the (l)eft? ", ["r", "l"]);
  const d = decideInvert({ invert, noseLed: front === "f" });
  if (!d.flipped) { forwardMoves = dir === "r" ? "right" : "left"; break; }
  if (attempt === 2) await quit(1, "\nStill back first with the other polarity: something else is going on (is the loco on the track the other way round, or the wrong end the front?). Nothing was saved.");
  invert = d.invert;
  console.log(`\nThe back led, so forward is the wrong way round. Flipping invert to ${invert} and checking again.\n`);
  ctl.send({ cmd: "invert", value: invert }); ctl.invert = invert;
  await new Promise((r) => setTimeout(r, 400));
  if ((await ask("Press ENTER to run it again, or q to quit: ", ["", "q"])) === "q") await quit(0, "Stopped: nothing was saved.");
}

const rec = orientationRecord({ invert, forwardMoves });
writeFileSync(localFile("orientation.json"), JSON.stringify(rec, null, 2) + "\n");
await quit(0, `\nSaved local/orientation.json: invert ${rec.invert}, forward moves ${forwardMoves} as you face the layout (so --direction=reverse leaves the other way, tail first).\nThe tools send this invert whenever they connect. Check it with: node config.mjs`);
