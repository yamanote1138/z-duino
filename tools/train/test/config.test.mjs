import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError, DEFAULTS, SCHEMA, stripJsonc, parseConfigText, exampleConfigText, CONFIG_FILE } from "../lib/config/index.mjs";
import { connectController, Controller } from "../lib/controller/index.mjs";
import { SimSocket } from "../lib/show/index.mjs";
import { packPath } from "../lib/sound/defaults.mjs";
import { SerialSource } from "../lib/sensor/index.mjs";

const dirWith = (text) => { const d = mkdtempSync(join(tmpdir(), "cfg-")); if (text !== undefined) writeFileSync(join(d, CONFIG_FILE), text); return d; };
const load = (o = {}) => loadConfig({ env: {}, ...o });

test("defaults, and nothing is read when there is no file", () => {
  const c = load({ localDir: dirWith() });
  assert.deepEqual({ ...c.controller }, DEFAULTS.controller);
  assert.equal(c.web.port, 4040); assert.equal(c.sound.volume, 0.5); assert.equal(c.sensor.baud, 115200);
  assert.equal(c.sources["web.port"], "default");
  assert.throws(() => { c.web.port = 1; }, TypeError, "the result is frozen");
});

test("the file, with comments and trailing commas", () => {
  const c = load({ localDir: dirWith(`// my setup
{
  "controller": { "host": "10.0.0.7", /* the Wemos */ "port": 8081, },
  "sound": { "volume": 0.3, "packs": ["packs/synth", "local:packs/mine"], },
}`) });
  assert.equal(c.controller.host, "10.0.0.7"); assert.equal(c.controller.port, 8081);
  assert.deepEqual([...c.sound.packs], ["packs/synth", "local:packs/mine"]);
  assert.equal(c.sources["controller.host"], "file"); assert.equal(c.sources["web.port"], "default");
});

test("precedence: defaults < file < environment < flags", () => {
  const dir = dirWith(`{ "controller": { "host": "file-host" }, "sound": { "volume": 0.2 } }`);
  let c = load({ localDir: dir });
  assert.equal(c.controller.host, "file-host");
  c = load({ localDir: dir, env: { TRAIN_HOST: "env-host" } });
  assert.equal(c.controller.host, "env-host"); assert.equal(c.sources["controller.host"], "env");
  c = load({ localDir: dir, env: { TRAIN_HOST: "env-host" }, argv: ["--host=flag-host", "--volume=0.9"] });
  assert.equal(c.controller.host, "flag-host"); assert.equal(c.sources["controller.host"], "flag");
  assert.equal(c.sound.volume, 0.9); assert.equal(c.sources["sound.volume"], "flag");
  assert.equal(load({ localDir: dir, env: { SENSOR_PORT: "/dev/cu.x" } }).sensor.port, "/dev/cu.x");
});

test("flags are converted to the setting's type; other flags are left to the script", () => {
  const c = load({ localDir: dirWith(), argv: ["--port=5000", "--invert=true", "--packs=a,b", "--engine=null", "--sensor-port=null", "--speed=0.08", "--no-sound", "show-name"] });
  assert.equal(c.web.port, 5000); assert.equal(c.controller.invert, true); assert.deepEqual([...c.sound.packs], ["a", "b"]);
  assert.equal(c.sound.engine, "null"); assert.equal(c.sensor.port, null);
  assert.equal(load({ localDir: dirWith(), argv: ["--invert=false"] }).controller.invert, false);
});

test("TRAIN_LOCAL decides which folder holds the file", () => {
  const dir = dirWith(`{ "web": { "port": 7777 } }`);
  assert.equal(load({ env: { TRAIN_LOCAL: dir } }).web.port, 7777);
});

test("mistakes are errors that name the key, with a suggestion for typos", () => {
  const bad = (text, re) => assert.throws(() => load({ localDir: dirWith(text) }), (e) => e instanceof ConfigError && re.test(e.message), text);
  bad(`{ "controler": {} }`, /unknown section "controler" \(did you mean "controller"\?\)/);
  bad(`{ "controller": { "hots": "x" } }`, /unknown setting controller\.hots \(did you mean "controller\.host"\?\)/);
  bad(`{ "web": { "port": "4040" } }`, /web\.port must be a number/);
  bad(`{ "web": { "port": 99999 } }`, /web\.port must be between 0 and 65535/);
  bad(`{ "controller": { "port": 81.5 } }`, /whole number/);
  bad(`{ "sound": { "packs": [] } }`, /sound\.packs must be a list/);
  bad(`{ "controller": { "invert": "yes" } }`, /controller\.invert must be true or false/);
  bad(`{ "sound": { "engine": null } }`, /sound\.engine must not be empty/);
  bad(`{ "web": { "port": 1 `, /config\.jsonc/);
  bad(`[1]`, /top level must be an object/);
  assert.throws(() => load({ localDir: dirWith(), argv: ["--volume=loud"] }), /flag --volume: sound\.volume must be a number \(got "loud"\)/);
  assert.throws(() => load({ localDir: dirWith(), env: { SENSOR_PORT: "" , TRAIN_HOST: "x" }, argv: ["--invert=maybe"] }), /controller\.invert/);
  // several problems are reported together
  try { load({ localDir: dirWith(`{ "web": { "port": "x", "bogus": 1 } }`) }); assert.fail("should throw"); } catch (e) { assert.equal(e.problems.length, 2); }
});

test("controller.led is auto, true or false, and reaches the controller", async () => {
  assert.equal(load({ localDir: dirWith() }).controller.led, "auto");
  assert.equal(load({ localDir: dirWith(`{ "controller": { "led": false } }`) }).controller.led, false);
  assert.equal(load({ localDir: dirWith(), argv: ["--led=true"] }).controller.led, true);
  assert.equal(load({ localDir: dirWith(`{ "controller": { "led": false } }`), argv: ["--led=auto"] }).controller.led, "auto");
  assert.throws(() => load({ localDir: dirWith(`{ "controller": { "led": "sometimes" } }`) }), /controller\.led must be "auto", true or false/);
  assert.throws(() => load({ localDir: dirWith(), argv: ["--led=maybe"] }), /flag --led/);
  const ctl = await connectController({ config: load({ localDir: dirWith(`{ "controller": { "host": "h", "led": false } }`) }), WebSocketImpl: SimSocket });
  assert.equal(ctl.hasLed, false); assert.equal(ctl.led(1, 2, 3), false); await ctl.close();
  const dflt = await connectController({ config: load({ localDir: dirWith(`{ "controller": { "host": "h" } }`) }), WebSocketImpl: SimSocket });
  assert.equal(dflt.hasLed, true); await dflt.close();
});

test("stripJsonc keeps strings intact", () => {
  assert.deepEqual(parseConfigText(`{ "a": "// not a comment", "b": "/* nor this */", "c": "a,}", // real
 "d": [1, 2,], }`), { a: "// not a comment", b: "/* nor this */", c: "a,}", d: [1, 2] });
  assert.equal(stripJsonc("﻿{}"), "{}");
  assert.throws(() => stripJsonc("{ /* open "), /never closed/);
  assert.deepEqual(parseConfigText("// only a comment\n"), {});
});

test("config.example.jsonc is the generated template, parses as an empty override, and documents every setting", () => {
  const committed = readFileSync(fileURLToPath(new URL("../config.example.jsonc", import.meta.url)), "utf8");
  assert.equal(committed, exampleConfigText(), "regenerate with: node config.mjs --write-example");
  assert.deepEqual(load({ localDir: dirWith(committed) }).web, DEFAULTS.web, "an untouched copy changes nothing");
  for (const [g, keys] of Object.entries(SCHEMA)) for (const k of Object.keys(keys)) assert.ok(committed.includes(`"${k}":`) && committed.includes(`"${g}": {`), `${g}.${k} missing from the example`);
  // uncommenting every line gives the defaults back
  const uncommented = committed.replace(/^(\s*)\/\/ ("[a-zA-Z]+": .*)$/gm, "$1$2");
  assert.deepEqual({ ...load({ localDir: dirWith(uncommented) }).sound }, DEFAULTS.sound);
});

test("pack paths: absolute as is, local: under local/, otherwise under tools/train", () => {
  assert.equal(packPath("/x/y"), "/x/y");
  assert.match(packPath("local:packs/mine"), /\/local\/packs\/mine$/);
  assert.match(packPath("packs/synth"), /tools\/train\/packs\/synth$/);
});

test("connectController takes host, port, keepalive and invert from the settings, and sends invert on connect", async () => {
  const config = load({ localDir: dirWith(`{ "controller": { "host": "10.9.9.9", "port": 8081, "pingMs": 777, "invert": true } }`) });
  const ctl = await connectController({ config, WebSocketImpl: SimSocket });
  assert.equal(ctl.url, "ws://10.9.9.9:8081"); assert.equal(ctl.config.pingMs, 777);
  assert.deepEqual(SimSocket.last.sent, [{ cmd: "invert", value: true }]);
  await ctl.close();
  const plain = await connectController({ host: "h", WebSocketImpl: SimSocket });
  assert.deepEqual(SimSocket.last.sent, [], "no invert setting: nothing is sent"); await plain.close();
  const off = await connectController({ config: load({ localDir: dirWith(), argv: ["--invert=false", "--host=h"] }), WebSocketImpl: SimSocket });
  assert.deepEqual(SimSocket.last.sent, [{ cmd: "invert", value: false }]); await off.close();
  assert.equal(new Controller({ host: "x" }).invert, null);
});

test("the serial source explains why it has no port", () => {
  const none = new SerialSource({ port: null, detect: () => [] });
  assert.equal(none.resolve(), null); assert.match(none.why(null), /no serial port: no \/dev\/cu\.usbmodem\* device is present/);
  const gone = new SerialSource({ port: "/dev/cu.usbmodem9", detect: () => [] });
  assert.match(gone.why(null), /\/dev\/cu\.usbmodem9 is not there and/);
  const two = new SerialSource({ port: null, detect: () => ["/dev/cu.usbmodem1", "/dev/cu.usbmodem2"] });
  assert.equal(two.resolve(), null); assert.match(two.why(null), /several sensor ports.*sensor\.port in local\/config\.jsonc, or SENSOR_PORT/);
  assert.equal(new SerialSource({ port: null, detect: () => ["/dev/cu.usbmodem1"] }).resolve(), "/dev/cu.usbmodem1", "a single device is found without being named");
});

test("local/orientation.json supplies controller.invert below the file, the environment and the flags, and says which way forward moves", async () => {
  const { parseOrientation, travelLabel, ORIENTATION_FORMAT } = await import("../lib/config/index.mjs");
  const files = { "/l/orientation.json": JSON.stringify({ format: ORIENTATION_FORMAT, invert: true, forwardMoves: "right" }), "/l/config.jsonc": '{ "controller": { "invert": false } }' };
  const load = (extra = {}, present = Object.keys(files)) => loadConfig({ localDir: "/l", env: {}, exists: (p) => present.includes(p), readFile: (p) => files[p], ...extra });
  const c = load({}, ["/l/orientation.json"]);
  assert.equal(c.controller.invert, true); assert.equal(c.sources["controller.invert"], "orientation");
  assert.deepEqual(c.orientation, { format: ORIENTATION_FORMAT, invert: true, forwardMoves: "right" });
  assert.equal(load().controller.invert, false, "config.jsonc wins over the calibration"); assert.equal(load().sources["controller.invert"], "file");
  assert.equal(load({ argv: ["--invert=true"] }).sources["controller.invert"], "flag");
  assert.equal(loadConfig({ localDir: "/nowhere", env: {}, exists: () => false }).orientation, null);
  assert.equal(loadConfig({ localDir: "/nowhere", env: {}, exists: () => false }).controller.invert, null);
  assert.equal(travelLabel(c.orientation, "forward"), "right"); assert.equal(travelLabel(c.orientation, "reverse"), "left"); assert.equal(travelLabel(null, "forward"), null);
  assert.throws(() => parseOrientation('{"format":"z-orientation/1"}'), /invert must be/);
  assert.throws(() => parseOrientation('{"format":"z-orientation/1","invert":false,"forwardMoves":"up"}'), /forwardMoves/);
  assert.throws(() => load({ readFile: () => '{"format":"nope"}' }, ["/l/orientation.json"]), /orientation.json: format must be/);
});
