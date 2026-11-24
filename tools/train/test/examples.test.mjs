import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadShow, validateShow, validateLayout, simulateShow, soundsUsed } from "../lib/show/index.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const LAYOUT = JSON.parse(readFileSync(here("../examples/layout.example.json"), "utf8"));
const LOCO = { lengthIn: 3, fit: { inPerSecPerUnitThrottle: 28.65, offsetInS: -0.49 }, points: [{ thr: 0.08, v: 1.8 }, { thr: 0.1, v: 2.35 }, { thr: 0.2, v: 5.4 }, { thr: 0.3, v: 8.1 }, { thr: 0.4, v: 11 }] };
const shows = readdirSync(here("../examples/shows")).filter((f) => f.endsWith(".json")).sort();

// every sound id a show uses must exist in a committed pack manifest (the audio files themselves are not committed)
const manifestIds = ["synth", "jr-east"].flatMap((p) => Object.keys(JSON.parse(readFileSync(here(`../packs/${p}/pack.json`), "utf8")).sounds));
const known = (sel) => manifestIds.includes(sel) || manifestIds.some((id) => id.split(".")[0] === sel);

test("the example layout is valid", () => assert.deepEqual(validateLayout(LAYOUT), []));

test("there are example shows", () => assert.ok(shows.length >= 5, shows.join(", ")));

for (const file of shows) {
  test(`examples/shows/${file}: valid, uses only known sounds and zones, and simulates cleanly`, async () => {
    const show = loadShow(here(`../examples/shows/${file}`));
    const check = validateShow(show, { layout: LAYOUT, loco: LOCO });
    assert.deepEqual(check.errors, [], `${file}: ${check.errors.join("; ")}`);
    for (const id of soundsUsed(show)) assert.ok(known(id), `${file}: sound "${id}" is in no pack manifest`);
    const r = await simulateShow(show, { layout: LAYOUT, loco: LOCO });
    assert.equal(r.ok, true, `${file}: ${r.error}`);
    assert.ok(r.maxSpeed <= 0.5, `${file}: top throttle ${r.maxSpeed} is above the example ceiling`);
    // the last thing every example does with the motor is stop it
    const speeds = r.commands.filter((c) => c.cmd === "speed");
    assert.equal(speeds.at(-1).value, 0, `${file}: does not end with the loco stopped`);
    // examples assume the loco is parked on the mark, and the runner checks that before anything moves
    assert.ok(show.start === "blocked", `${file}: examples start with the nose on the mark`);
  });
}
