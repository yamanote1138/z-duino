#!/usr/bin/env node
// Plays the effect set in the order a show uses them, so you can judge the sounds before a run.
// Usage: node sound-demo.mjs [--volume=0.5]
import { Sounds } from "./lib/sounds.mjs";

const vol = Number((process.argv.find((a) => a.startsWith("--volume=")) || "").split("=")[1] || 0.5);
const snd = new Sounds({ volume: vol });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (label, fn, ms) => { console.log(label); fn(); await sleep(ms); };
process.on("SIGINT", () => { snd.stopAll(); process.exit(130); });

snd.prepare([800, 420]);
await step("RED: blower idling", () => snd.loop("hum", vol * 0.8), 3000);
await step("YELLOW: brake release", () => snd.once("air"), 1300);
await step("GREEN: horn", () => snd.once("horn"), 1400);
snd.stopLoop();
await step("accelerating: inverter sweep 120 -> 800 Hz (3.2 s)", () => snd.sweep(3.2, 120, 800), 3200);
await step("cruise: steady inverter whine", () => snd.cruise(800), 3000);
await step("passing the beam: crossing bell", () => snd.once("bell", vol * 0.7), 1900);
await step("slowing: sweep 800 -> 420 Hz (2.2 s)", () => snd.sweep(2.2, 800, 420), 2200);
await step("creep: low whine", () => snd.cruise(420, vol * 0.8), 2500);
snd.stopLoop();
await step("parked: air release", () => snd.once("air"), 1800);
await step("ready: station chime", () => snd.once("chime"), 2200);
snd.stopAll();
console.log("done");
