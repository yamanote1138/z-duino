#!/usr/bin/env node
// The web page for the train: pick a show, validate it, simulate it, run it on the real train, audition sounds.
//
//   node serve.mjs                 start on http://127.0.0.1:4040/ (this Mac only)
//   node serve.mjs --open          ... and open the page in your browser
//   node serve.mjs --port=5000 --volume=0.5
//   node serve.mjs --no-sensor     no sensor: validate, simulate, import/export and sounds work; real runs are refused
//
// The service holds the sensor's serial port while it runs (so the beam status is live): stop it before running the
// measuring or calibration scripts. Ctrl-C stops a running show (the loco ramps down) and shuts the service down.

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer } from "./lib/web/server.mjs";
import { defaultSounds } from "./lib/sound/defaults.mjs";
import { loadConfigOrExit } from "./lib/config/index.mjs";
import { connectController } from "./lib/controller/index.mjs";
import { localPath } from "./lib/paths.mjs";

const root = dirname(fileURLToPath(import.meta.url)) + "/";
const argv = process.argv.slice(2);
const config = loadConfigOrExit(argv);
const skip = (p, e) => console.error(`skipping sound pack ${p}: ${e.message}`);
const { volume, packs } = config.sound;
const sounds = { play: defaultSounds({ engine: config.sound.engine, volume, packs, onSkip: skip }), dry: defaultSounds({ engine: "null", volume, packs }) };

let sensor = null;
if (!argv.includes("--no-sensor")) {
  const { createSensor, SerialSource } = await import("./lib/sensor/index.mjs");
  const source = new SerialSource(config.sensor);
  sensor = createSensor({ source });
  sensor.on("error", (e) => console.error("sensor error:", e.message));
  await sensor.start();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(sensor.lastReading != null ? `sensor on ${source.current}` : `sensor: no readings yet (${source.lastError ? source.lastError.message : "waiting"}); the page will show it as lost until it appears`);
}

const web = createWebServer({
  hardware: { sensor, connectController: () => connectController({ config }) },
  sounds,
  dirs: { local: localPath("shows"), examples: root + "examples/shows" },
  layoutFile: localPath("layout.json"), locoFile: localPath("loco_profile.json"),
  log: (m) => console.error(m),
});
const { url } = await web.listen(config.web.port);
console.log(`train page: ${url}   (Ctrl-C to stop)`);
if (argv.includes("--open")) spawn("open", [url], { stdio: "ignore", detached: true }).unref();

let closing = false;
const shutdown = async () => {
  if (closing) { try { await web.emergencyStop(); } catch { /* the link is gone: the firmware stops the motor itself after 30 s */ } process.exit(130); }   // a second Ctrl-C: stop now, do not wait for the ramp-down
  closing = true; console.log("\nstopping (a running show ramps the loco down first)...");
  await web.close(); sensor?.stop(); process.exit(0);
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
