import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../lib/controller/index.mjs";
import { GhostSensor, SimSocket, realClock, saveShow } from "../lib/show/index.mjs";
import { RecordingEngine } from "../lib/sound/index.mjs";
import { defaultSounds } from "../lib/sound/defaults.mjs";
import { createWebServer } from "../lib/web/server.mjs";

const show = (steps, extra = {}) => ({ format: "z-show/1", name: "Quick", steps, ...extra });
const QUICK = show([{ do: "led", color: "red" }, { do: "direction", forward: true }, { do: "wait", ms: 100 }, { do: "led-auto" }], { description: "a quick one", settings: { pause: 100 } });
const LONG = show([{ do: "direction", forward: true }, { do: "wait", ms: 30000 }], { name: "Long" });
const NEEDS_BLOCKED = show([{ do: "wait", ms: 10 }], { name: "Blocked", start: "blocked" });

async function setup({ sensorState = "blocked", withSensor = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "web-"));
  const dirs = { local: join(base, "local"), examples: join(base, "examples") };
  mkdirSync(dirs.local); mkdirSync(dirs.examples);
  saveShow(QUICK, join(dirs.examples, "quick.json"));
  saveShow(LONG, join(dirs.local, "long.json"));
  saveShow(NEEDS_BLOCKED, join(dirs.local, "needs-blocked.json"));
  const engine = new RecordingEngine({ playMs: 20 });
  const sounds = { play: defaultSounds({ engine, onSkip: () => {} }), dry: defaultSounds({ engine: "null" }) };
  const sensor = withSensor ? Object.assign(new GhostSensor(realClock, { state: sensorState, eventMs: 5 }), { lastSampleAgeMs: 12 }) : null;
  const controllers = [];
  const connectController = async () => { const c = await new Controller({ host: "sim", WebSocketImpl: SimSocket, config: { pingMs: 2e9, directionSettleMs: 5 } }).connect(); c.sock = SimSocket.last; controllers.push(c); return c; };
  const web = createWebServer({ hardware: { sensor, connectController }, sounds, dirs, statusMs: 50 });
  const { port } = await web.listen(0);
  const base_ = `http://127.0.0.1:${port}`;
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(base_ + path, { method, headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  const idle = async () => { for (let i = 0; i < 200; i++) { if (!(await api("GET", "/api/status")).data.run) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("run did not finish"); };
  return { web, api, port, idle, controllers, engine, dirs, sensor };
}

test("status, shows list and show details", async () => {
  const t = await setup();
  try {
    const st = (await t.api("GET", "/api/status")).data;
    assert.equal(st.sensor.state, "blocked"); assert.equal(st.run, null); assert.equal(st.controller.connected, false);
    const list = (await t.api("GET", "/api/shows")).data.shows;
    assert.deepEqual(list.map((s) => s.id).sort(), ["examples/quick", "local/long", "local/needs-blocked"]);
    assert.equal(list.find((s) => s.id === "examples/quick").description, "a quick one");
    assert.deepEqual(list.find((s) => s.id === "examples/quick").settings, { pause: 100 });
    const one = (await t.api("GET", "/api/show?id=examples/quick")).data;
    assert.equal(one.show.name, "Quick"); assert.deepEqual(one.errors, []);
    assert.equal((await t.api("GET", "/api/show?id=local/nope")).status, 404);
    for (const bad of ["../etc/passwd", "local/../x", "local/a/b", "other/x", "local/UP", ""]) assert.equal((await t.api("GET", `/api/show?id=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await t.api("GET", "/")).status, 200);
    assert.equal((await t.api("GET", "/favicon.svg")).status, 200);
  } finally { await t.web.close(); }
});

test("validate and simulate, saved or inline; nothing moves and nothing plays", async () => {
  const t = await setup();
  try {
    assert.equal((await t.api("POST", "/api/validate", { id: "examples/quick" })).data.ok, true);
    const bad = (await t.api("POST", "/api/validate", { show: show([{ do: "sound", id: "no.such.sound" }, { do: "wait" }]) })).data;
    assert.equal(bad.ok, false); assert.ok(bad.errors.some((e) => /steps\[0\]/.test(e)), bad.errors.join("; "));
    const sim = (await t.api("POST", "/api/sim", { id: "examples/quick" })).data;
    assert.equal(sim.ok, true); assert.ok(sim.log.length >= 3); assert.ok(sim.commands > 0);
    assert.equal((await t.api("POST", "/api/sim", { show: show([{ do: "wait" }]) })).status, 400);
    assert.equal(t.controllers.length, 0, "no controller connection for sim/validate");
    assert.equal(t.engine.calls.length, 0);
    assert.equal((await t.api("POST", "/api/validate", { id: "examples/quick", settings: { nope: 1 } })).status, 400);
    assert.equal((await t.api("POST", "/api/validate", { id: "examples/quick", settings: { pause: "x" } })).status, 400);
  } finally { await t.web.close(); }
});

test("import and export a show as JSON", async () => {
  const t = await setup();
  try {
    const r = await t.api("POST", "/api/show", { name: "My New Show!", show: QUICK });
    assert.equal(r.status, 201); assert.equal(r.data.id, "local/my-new-show");
    assert.ok(existsSync(join(t.dirs.local, "my-new-show.json")));
    const again = await t.api("POST", "/api/show", { name: "My New Show!", show: QUICK });
    assert.equal(again.status, 409); assert.equal(again.data.exists, true);
    assert.equal((await t.api("POST", "/api/show", { name: "My New Show!", show: QUICK, overwrite: true })).status, 201);
    assert.equal((await t.api("POST", "/api/show", { name: "x", show: { format: "other" } })).status, 400);
    const invalid = await t.api("POST", "/api/show", { name: "broken", show: show([{ do: "wait" }]) });
    assert.equal(invalid.status, 400); assert.ok(invalid.data.errors.length);
    assert.ok(!existsSync(join(t.dirs.local, "broken.json")));
    const ex = await t.api("GET", "/api/export?id=local/my-new-show");
    assert.match(ex.headers.get("content-disposition"), /my-new-show\.json/);
    assert.deepEqual(ex.data, QUICK);
  } finally { await t.web.close(); }
});

test("it only answers this machine and JSON posts", async () => {
  const t = await setup();
  try {
    const raw = (opts, body) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: t.port, ...opts }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
      req.on("error", reject); if (body) req.write(body); req.end();
    });
    assert.equal((await raw({ path: "/api/status", headers: { host: "evil.example.com" } })).status, 403);
    assert.equal((await raw({ path: "/api/status", headers: { host: `127.0.0.1:${t.port + 1}` } })).status, 403);
    assert.equal((await raw({ method: "POST", path: "/api/stop", headers: { "content-type": "text/plain" } }, "{}")).status, 415);
    assert.equal((await raw({ method: "POST", path: "/api/estop" })).status, 415);
    assert.equal((await raw({ method: "POST", path: "/api/validate", headers: { "content-type": "application/json" } }, "{not json")).status, 400);
    assert.equal((await raw({ method: "DELETE", path: "/api/show" })).status, 405);
    assert.equal(t.controllers.length, 0);
  } finally { await t.web.close(); }
});

test("run a show: one at a time, commands reach the controller, the result is recorded", async () => {
  const t = await setup();
  try {
    const r = await t.api("POST", "/api/run", { id: "examples/quick" });
    assert.equal(r.status, 202);
    const second = await t.api("POST", "/api/run", { id: "examples/quick" });
    assert.equal(second.status, 409); assert.match(second.data.error, /already running/);
    await t.idle();
    const st = (await t.api("GET", "/api/status")).data;
    assert.equal(st.lastRun.ok, true); assert.equal(st.lastRun.id, "examples/quick");
    const sent = t.controllers[0].sock.sent.filter((m) => m.cmd !== "ping");
    assert.ok(sent.some((m) => m.cmd === "direction"), JSON.stringify(sent));
    assert.ok(sent.some((m) => m.cmd === "led_auto"));
    assert.equal(t.controllers[0].connected, false, "the controller is closed after the run");
  } finally { await t.web.close(); }
});

test("a run is refused when the sensor, the beam or the show is not right", async () => {
  const noSensor = await setup({ withSensor: false });
  try {
    const r = await noSensor.api("POST", "/api/run", { id: "examples/quick" });
    assert.equal(r.status, 409); assert.match(r.data.error, /no sensor/);
    assert.equal(noSensor.controllers.length, 0);
    assert.equal((await noSensor.api("POST", "/api/sim", { id: "examples/quick" })).status, 200);
    assert.equal((await noSensor.api("GET", "/api/status")).data.sensor, null);
  } finally { await noSensor.web.close(); }
  const clear = await setup({ sensorState: "clear" });
  try {
    const r = await clear.api("POST", "/api/run", { id: "local/needs-blocked" });
    assert.equal(r.status, 409); assert.match(r.data.error, /beam blocked.*sensor says clear/);
    clear.sensor.state = "lost";
    assert.match((await clear.api("POST", "/api/run", { id: "examples/quick" })).data.error, /stopped reporting/);
    assert.equal(clear.controllers.length, 0, "nothing connected to the controller");
    assert.equal((await clear.api("POST", "/api/run", { id: "local/nope" })).status, 404);
  } finally { await clear.web.close(); }
});

test("STOP aborts a running show and leaves the loco stopped; with nothing running it says so", async () => {
  const t = await setup();
  try {
    assert.equal((await t.api("POST", "/api/stop", {})).status, 409);
    await t.api("POST", "/api/run", { id: "local/long" });
    for (let i = 0; i < 100 && !(await t.api("GET", "/api/status")).data.controller.connected; i++) await new Promise((r) => setTimeout(r, 20));
    const stop = await t.api("POST", "/api/stop", {});
    assert.equal(stop.status, 202);
    await t.idle();
    const st = (await t.api("GET", "/api/status")).data;
    assert.equal(st.lastRun.ok, false); assert.match(st.lastRun.error, /aborted/);
    assert.equal(t.controllers[0].speed, 0);
  } finally { await t.web.close(); }
});

test("E-STOP sends the controller's stop command, during a run or not", async () => {
  const t = await setup();
  try {
    await t.api("POST", "/api/run", { id: "local/long" });
    for (let i = 0; i < 100 && !(await t.api("GET", "/api/status")).data.controller.connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await t.api("POST", "/api/estop", {})).status, 200);
    await t.idle();
    assert.ok(t.controllers[0].sock.sent.some((m) => m.cmd === "stop"));
    const n = t.controllers.length;
    assert.equal((await t.api("POST", "/api/estop", {})).status, 200);
    assert.equal(t.controllers.length, n + 1);
    assert.ok(t.controllers.at(-1).sock.sent.some((m) => m.cmd === "stop"), "idle e-stop connects and sends stop");
  } finally { await t.web.close(); }
});

test("sounds: list, audition, stop; refused while a show runs", async () => {
  const t = await setup();
  try {
    const list = (await t.api("GET", "/api/sounds")).data;
    assert.ok(list.sounds.length > 0); assert.ok(list.categories.includes("brake"));
    const one = list.sounds.find((s) => s.id === "brake.air");
    assert.ok(one && one.category === "brake" && one.durationMs > 0, JSON.stringify(one));
    const p = await t.api("POST", "/api/sounds/play", { id: "brake.air", gain: 0.5, seconds: 1 });
    assert.equal(p.status, 200); assert.equal(t.engine.calls.length, 1);
    assert.equal((await t.api("POST", "/api/sounds/play", { id: "no.such" })).status, 404);
    assert.equal((await t.api("POST", "/api/sounds/play", { id: "brake.air", gain: 9 })).status, 400);
    assert.equal((await t.api("POST", "/api/sounds/play", { id: "brake.air", seconds: -1 })).status, 400);
    assert.equal((await t.api("POST", "/api/sounds/stop", {})).status, 200);
    await t.api("POST", "/api/run", { id: "local/long" });
    assert.equal((await t.api("POST", "/api/sounds/play", { id: "brake.air" })).status, 409);
    await t.api("POST", "/api/stop", {});
    await t.idle();
  } finally { await t.web.close(); }
});

test("the event stream carries status, log lines and the end of a run", async () => {
  const t = await setup();
  try {
    const events = [];
    const req = http.get({ host: "127.0.0.1", port: t.port, path: "/api/events" }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(block), d = /data: (.*)/.exec(block); if (ev && d) events.push([ev[1], JSON.parse(d[1])]); } });
    });
    for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(events[0][0], "status");
    await t.api("POST", "/api/run", { id: "examples/quick" });
    for (let i = 0; i < 100 && !events.some((e) => e[0] === "run-end"); i++) await new Promise((r) => setTimeout(r, 50));
    const kinds = new Set(events.map((e) => e[0]));
    for (const k of ["status", "run", "log", "run-end"]) assert.ok(kinds.has(k), `${k} missing: ${[...kinds]}`);
    assert.equal(events.find((e) => e[0] === "run-end")[1].ok, true);
    req.destroy();
  } finally { await t.web.close(); }
});

test("closing the service while a show runs stops the show first", async () => {
  const t = await setup();
  await t.api("POST", "/api/run", { id: "local/long" });
  for (let i = 0; i < 100 && !(await t.api("GET", "/api/status")).data.controller.connected; i++) await new Promise((r) => setTimeout(r, 20));
  await t.web.close();
  assert.equal(t.controllers[0].speed, 0);
  assert.equal(t.controllers[0].connected, false);
});
