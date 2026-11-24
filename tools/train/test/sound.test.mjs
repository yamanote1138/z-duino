import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundLibrary, RecordingEngine, planFill, wavDurationMs } from "../lib/sound/index.mjs";
import { writeWav } from "../lib/synth.mjs";

// seeded random so choices are repeatable
function seeded(seed = 1) { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

function makePack(sounds, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zpack-"));
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: "z-sounds/1", name: "t", sounds, ...extra }));
  return dir;
}
const lib = (sounds, o = {}) => new SoundLibrary({ packs: [makePack(sounds)], engine: o.engine || new RecordingEngine({ playMs: 5 }), random: o.random || seeded(), volume: o.volume ?? 1 });

test("an id plays its file at the pack's gain times the volume", () => {
  const eng = new RecordingEngine(), l = lib({ "horn.a": { file: "a.wav", gain: 0.5 } }, { engine: eng, volume: 0.8 });
  l.play("horn.a", { gain: 0.5 });
  assert.equal(eng.calls.length, 1);
  assert.ok(eng.calls[0].path.endsWith("a.wav"));
  assert.ok(Math.abs(eng.calls[0].volume - 0.8 * 0.5 * 0.5) < 1e-9);
});

test("a category name picks a member; an unknown name is an error that lists the categories", () => {
  const l = lib({ "horn.a": { file: "a.wav" }, "horn.b": { file: "b.wav" }, "brake.x": { file: "x.wav" } });
  assert.deepEqual(l.categories(), ["brake", "horn"]);
  assert.deepEqual(l.list("horn"), ["horn.a", "horn.b"]);
  assert.equal(l.has("horn"), true);
  assert.throws(() => l.play("nope"), /unknown sound "nope".*brake, horn/);
});

test("variants never repeat back to back when noRepeat is on, and weights are respected otherwise", () => {
  const l = lib({ f: { variants: [{ file: "1.wav" }, { file: "2.wav" }, { file: "3.wav" }], noRepeat: true } });
  let prev = null;
  for (let i = 0; i < 200; i++) { const c = l.choose("f"); assert.notEqual(c.variant.file, prev); prev = c.variant.file; }
  const w = lib({ f: { variants: [{ file: "heavy.wav", weight: 9 }, { file: "light.wav", weight: 1 }], noRepeat: false } });
  let heavy = 0; for (let i = 0; i < 1000; i++) if (w.choose("f").variant.file === "heavy.wav") heavy++;
  assert.ok(heavy > 800 && heavy < 970, `heavy ${heavy}`);
});

test("gain jitter stays inside its band", () => {
  const l = lib({ f: { file: "a.wav", gainJitter: 0.2 } });
  for (let i = 0; i < 200; i++) { const v = l.choose("f").volume; assert.ok(v >= 0.8 - 1e-9 && v <= 1.2 + 1e-9, String(v)); }
});

test("later packs override earlier ones with the same id", () => {
  const eng = new RecordingEngine(), l = new SoundLibrary({ engine: eng, packs: [makePack({ "x.a": { file: "old.wav" } }), makePack({ "x.a": { file: "new.wav" } })] });
  l.play("x.a");
  assert.ok(eng.calls[0].path.endsWith("new.wav"));
});

test("planFill covers the time, trims the last clip, honours the cut and overlap", () => {
  const plan = planFill(() => ({ duration: 1000 }), 3500, { cutMs: 500, overlapMs: 100 });
  assert.deepEqual(plan.map((p) => p.at), [0, 900, 1800, 2700]);
  assert.equal(plan.at(-1).at + plan.at(-1).playMs, 3000);   // the last clip is trimmed to 300 ms   // ends at ms - cutMs
  assert.deepEqual(planFill(() => ({ duration: 1000 }), 400, { cutMs: 300 }), []);   // too short to bother
  assert.throws(() => planFill(() => ({ duration: 50 }), 2000, { overlapMs: 100 }), /known duration/);
});

test("fill plays clips back to back and finishes", async () => {
  const eng = new RecordingEngine({ playMs: 1000 }), l = lib({ f: { variants: [{ file: "1.wav", durationMs: 60 }, { file: "2.wav", durationMs: 80 }] } }, { engine: eng });
  const t0 = Date.now(), h = l.fill("f", { ms: 220, cutMs: 20, minClipMs: 10 });
  await h.done;
  assert.ok(eng.calls.length >= 3, `calls ${eng.calls.length}`);
  assert.ok(Date.now() - t0 < 600);
  const last = eng.calls.at(-1); assert.ok(last.seconds > 0 && last.seconds <= 0.1);
});

test("stopping a fill stops what is playing and what is still scheduled", async () => {
  const eng = new RecordingEngine({ playMs: 500 }), l = lib({ f: { file: "1.wav", durationMs: 100 } }, { engine: eng });
  const h = l.fill("f", { ms: 1000, minClipMs: 10 });
  await new Promise((r) => setTimeout(r, 150));
  h.stop();
  await h.done;
  const n = eng.calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(eng.calls.length, n);
  assert.ok(n <= 3);
});

test("a loop keeps restarting until stopped; a new loop in the slot replaces the old", async () => {
  const eng = new RecordingEngine({ playMs: 30 }), l = lib({ "a.loop": { file: "a.wav", loop: true }, "b.loop": { file: "b.wav", loop: true } }, { engine: eng });
  l.loop("main", "a.loop");
  await new Promise((r) => setTimeout(r, 140));
  const aCalls = eng.calls.length; assert.ok(aCalls >= 3, `restarts ${aCalls}`);
  l.loop("main", "b.loop");
  await new Promise((r) => setTimeout(r, 200));
  l.stop("main");
  const total = eng.calls.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(eng.calls.length, total, "nothing plays after stop");
  assert.ok(eng.calls.slice(aCalls + 1).every((c) => c.path.endsWith("b.wav")), "only b after the swap");
});

test("stopAll silences loops, fills and one-shots", async () => {
  const eng = new RecordingEngine({ playMs: 1000 }), l = lib({ x: { file: "x.wav", loop: true, durationMs: 100 } }, { engine: eng });
  l.loop("m", "x"); l.play("x"); l.fill("x", { ms: 2000, minClipMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  l.stopAll();
  assert.equal(eng.active, 0);
});

test("duration comes from the manifest or the WAV header; check reports missing files and unknown ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "zwav-"));
  writeWav(join(dir, "real.wav"), new Float32Array(22050));   // exactly 1 s at 22.05 kHz
  assert.equal(wavDurationMs(join(dir, "real.wav")), 1000);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: "z-sounds/1", name: "w", sounds: { "a.real": { file: "real.wav" }, "a.gone": { file: "gone.wav", durationMs: 700 } } }));
  const l = new SoundLibrary({ packs: [dir], engine: new RecordingEngine() });
  assert.equal(l.duration("a.real"), 1000);
  assert.equal(l.duration("a.gone"), 700);
  assert.throws(() => l.check(["a.real", "a.gone", "zzz"]), (e) => /missing file .*gone\.wav/.test(e.message) && /unknown sound "zzz"/.test(e.message));
  l.check(["a.real"]);
});

test("a bad pack is refused with a useful message", () => {
  const bad = (m, re) => { const dir = mkdtempSync(join(tmpdir(), "zbad-")); writeFileSync(join(dir, "pack.json"), JSON.stringify(m)); assert.throws(() => new SoundLibrary({ packs: [dir], engine: "null" }), re); };
  bad({ format: "nope", sounds: {} }, /format must be/);
  bad({ format: "z-sounds/1" }, /no "sounds"/);
  bad({ format: "z-sounds/1", sounds: { x: {} } }, /needs "file" or "variants"/);
  bad({ format: "z-sounds/1", sounds: { x: { variants: [{ file: "a.wav", weight: 0 }] } } }, /bad weight/);
});

test("engines are swappable: a custom object works, an unknown name is refused", () => {
  const calls = [];
  const custom = { play(path, o) { calls.push([path, o]); return { done: Promise.resolve(), stop() {} }; } };
  new SoundLibrary({ packs: [makePack({ "x.a": { file: "a.wav" } })], engine: custom }).play("x.a");
  assert.equal(calls.length, 1);
  assert.throws(() => new SoundLibrary({ engine: "wat" }), /unknown sound engine "wat"/);
});

test("a loop on an engine whose clips end instantly does not starve the event loop (the silent engine)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-"));
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: "z-sounds/1", name: "t", sounds: { "motion.run": { file: "a.wav", loop: true, durationMs: 300 } } }));
  writeFileSync(join(dir, "a.wav"), Buffer.alloc(64));
  const lib = new SoundLibrary({ packs: [dir], engine: "null" });
  lib.loop("m", "motion.run");
  let ticks = 0; const iv = setInterval(() => ticks++, 10);
  await new Promise((r) => setTimeout(r, 120));
  clearInterval(iv); lib.stopAll();
  assert.ok(ticks >= 5, `timers only fired ${ticks} times: the loop starved the event loop`);
});

test("a pack root can point into local/ with the local: prefix", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, sep } = await import("node:path");
  const { loadPack } = await import("../lib/sound/index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pk-"));
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: "z-sounds/1", name: "t", root: "local:sounds", sounds: { "a.b": { file: "x.wav" } } }));
  const e = loadPack(dir).entries["a.b"].variants[0].path;
  assert.ok(e.endsWith(`${sep}local${sep}sounds${sep}x.wav`), e);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ format: "z-sounds/1", name: "t", root: "../elsewhere", sounds: { "a.b": { file: "x.wav" } } }));
  assert.equal(loadPack(dir).entries["a.b"].variants[0].path, join(dir, "..", "elsewhere", "x.wav"), "relative roots still resolve against the manifest");
});
