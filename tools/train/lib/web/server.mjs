// The web service: a page on this Mac to pick a show, check it, simulate it, run it on the real train, and audition sounds.
//
//   const web = createWebServer({ hardware, sounds, dirs, layoutFile, locoFile });
//   const { port } = await web.listen(4040);
//
// Everything outside this file is injected, so the same server runs against the real sensor and controller (serve.mjs)
// or against the simulator's stand-ins (test/web.test.mjs).
//   hardware  { sensor, connectController }   sensor: a started lib/sensor Sensor (or null: no sensor, so no real runs);
//             connectController() resolves a connected lib/controller Controller (called when a show starts, closed when it ends)
//   sounds    { play, dry }   two sound libraries: `play` makes noise (afplay), `dry` is the same packs on the null engine,
//             used for validating and simulating so those never make a sound
//   dirs      { local, examples }   folders of show files; saved/imported shows go to `local`
//
// Rules the service enforces:
//   - it only talks to this machine (the Host header must be 127.0.0.1/localhost on our port) and POSTs must be JSON, which a
//     web page on another site cannot send without a CORS check this server never passes: a page open in your browser cannot
//     start your train
//   - one show at a time; a real run needs a working sensor and, for `start: blocked`, the nose on the mark
//   - STOP aborts the show (it ramps the loco down like Ctrl-C); E-STOP sends the controller's stop command immediately
//   - sound auditioning is refused while a show runs

import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOW_FORMAT, loadLayout, loadLoco, loadShow, simulateShow, stringifyShow, validateLayout, validateShow, runShow } from "../show/index.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY = 1024 * 1024;

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export function createWebServer({ hardware = {}, sounds, dirs, layoutFile = null, locoFile = null, log = () => {}, statusMs = 1000 }) {
  const sensor = hardware.sensor || null;
  let run = null, lastRun = null, port = null;
  const clients = new Set();
  const handles = new Set();

  // ---- files ----
  const showFile = (id) => {
    const [where, name, extra] = String(id || "").split("/");
    if (extra !== undefined || !dirs[where] || !NAME.test(name || "")) throw new HttpError(400, `bad show id "${id}" (expected local/<name> or examples/<name>)`);
    return { file: join(dirs[where], `${name}.json`), where, name };
  };
  const listShows = () => Object.keys(dirs).flatMap((where) => {
    let files = []; try { files = readdirSync(dirs[where]).filter((f) => f.endsWith(".json")); } catch { /* none yet */ }
    return files.sort().map((f) => {
      const name = f.replace(/\.json$/, "");
      try { const s = loadShow(join(dirs[where], f)); return { id: `${where}/${name}`, where, name, title: s.name || name, description: s.description || "", settings: s.settings || {}, start: s.start || "any", steps: (s.steps || []).length }; }
      catch (e) { return { id: `${where}/${name}`, where, name, title: name, description: "", unreadable: e.message }; }
    });
  });
  const context = () => {
    let layout = null, loco = null;
    if (layoutFile && existsSync(layoutFile)) { layout = loadLayout(layoutFile); if (validateLayout(layout).length) layout = null; }
    if (locoFile && existsSync(locoFile)) loco = loadLoco(locoFile);
    return { layout, loco };
  };
  const loadById = (id) => {
    const { file } = showFile(id);
    if (!existsSync(file)) throw new HttpError(404, `no show "${id}"`);
    try { return loadShow(file); } catch (e) { throw new HttpError(400, e.message); }
  };
  const settingsFrom = (body, show) => {
    const out = {};
    for (const [k, v] of Object.entries((body && body.settings) || {})) {
      if (!(k in (show.settings || {}))) throw new HttpError(400, `the show has no setting "${k}"`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `setting "${k}" must be a number`);
      out[k] = v;
    }
    return out;
  };
  const check = (show, settings = {}) => {
    const { layout, loco } = context();
    return validateShow(show, { sounds: sounds.dry, layout, loco, settings });
  };
  // a show in the request: by id, or inline (validate/sim of something not saved yet)
  const showFrom = (body) => {
    if (body && body.show) return body.show;
    return loadById(body && body.id);
  };

  // ---- status and events ----
  const publicRun = () => run && { id: run.id, name: run.name, state: run.state, startedAt: run.startedAt, log: run.log };
  const status = () => ({
    sensor: sensor ? { state: sensor.state, reading: sensor.lastReading, ageMs: Number.isFinite(sensor.lastSampleAgeMs) ? Math.round(sensor.lastSampleAgeMs) : null } : null,
    controller: run && run.ctl ? { connected: run.ctl.connected, speed: +run.ctl.speed.toFixed(3), forward: run.ctl.forward } : { connected: false },
    run: publicRun(), lastRun,
  });
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const c of clients) { try { send(c, event, data); } catch { clients.delete(c); } } };
  const ticker = setInterval(() => { if (clients.size) broadcast("status", status()); }, statusMs);
  ticker.unref();

  // ---- running a show ----
  function startRun(id, show, settings) {
    if (run) throw new HttpError(409, `"${run.name}" is already running`);
    if (!sensor) throw new HttpError(409, "no sensor connected: shows can be validated and simulated, not run");
    if (sensor.state === "lost") throw new HttpError(409, "the sensor stopped reporting (check the USB cable)");
    const start = show.start || "any";
    if (start !== "any" && sensor.state !== start) throw new HttpError(409, `this show starts with the beam ${start}, but the sensor says ${sensor.state} (reading ${sensor.lastReading ?? "?"}): put the loco in place first`);
    const c = check(show, settings);
    if (c.errors.length) throw new HttpError(400, "the show is not valid", { errors: c.errors, warnings: c.warnings });
    const { layout, loco } = context();
    const r = run = { id, name: show.name || id, state: "starting", startedAt: Date.now(), log: [], ac: new AbortController(), ctl: null, estop: false };
    handles.clear();
    broadcast("run", publicRun());
    (async () => {
      let result;
      try {
        r.ctl = await hardware.connectController();
        if (r.estop) r.ctl.emergencyStop();
        r.state = "running"; broadcast("run", publicRun());
        const out = await runShow(show, { controller: r.ctl, sensor, sound: sounds.play, layout, loco, settings, signal: r.ac.signal, onLog: (e) => { r.log.push(e); broadcast("log", e); } });
        result = { ok: true, elapsedMs: out.elapsedMs };
      } catch (e) {
        result = { ok: false, error: e.message, elapsedMs: e.result ? e.result.elapsedMs : null };
        if (!r.log.length || !String(r.log.at(-1).text).startsWith("stopped")) { const ev = { t: Date.now() - r.startedAt, text: `stopped: ${e.message}` }; r.log.push(ev); broadcast("log", ev); }
      } finally {
        try { if (r.estop && r.ctl && r.ctl.connected) r.ctl.emergencyStop(); await (r.ctl && r.ctl.close()); } catch (e) { log(`closing the controller: ${e.message}`); }
        lastRun = { id: r.id, name: r.name, startedAt: r.startedAt, ...result };
        run = null;
        broadcast("run-end", lastRun);
      }
    })();
    return publicRun();
  }
  async function emergencyStop() {
    if (run) { run.estop = true; run.ac.abort(); if (run.ctl && run.ctl.connected) run.ctl.emergencyStop(); return "stopped the running show and sent the stop command"; }
    if (!hardware.connectController) throw new HttpError(409, "no controller available");
    const ctl = await hardware.connectController();
    try { ctl.emergencyStop(); } finally { await ctl.close(); }
    return "sent the stop command";
  }

  // ---- sounds ----
  const soundList = () => ({
    categories: sounds.dry.categories(),
    sounds: sounds.dry.list().map((id) => {
      const e = sounds.dry.entries[id]; let ms = null; try { ms = sounds.dry.duration(id); } catch { /* unknown length */ }
      return { id, category: e.category, pack: e.pack, description: e.description, durationMs: ms, variants: e.variants.length };
    }),
  });

  // ---- routes ----
  async function route(req, res, url, body) {
    const m = req.method, p = url.pathname;
    const ok = (data, code = 200) => json(res, code, data);
    if (m === "GET" && (p === "/" || p === "/index.html")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(PUBLIC, "index.html"))); }
    if (m === "GET" && p === "/favicon.svg") { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" }); return res.end(readFileSync(join(PUBLIC, "favicon.svg"))); }
    if (m === "GET" && p === "/api/status") return ok(status());
    if (m === "GET" && p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      send(res, "status", status()); clients.add(res);
      const beat = setInterval(() => { try { res.write(": hb\n\n"); } catch { /* closed */ } }, 15000); beat.unref();
      req.on("close", () => { clearInterval(beat); clients.delete(res); });
      return;
    }
    if (m === "GET" && p === "/api/shows") return ok({ shows: listShows() });
    if (m === "GET" && p === "/api/layout") { const { layout, loco } = context(); return ok({ layout, loco: loco && { lengthIn: loco.lengthIn } }); }
    if (m === "GET" && p === "/api/show") {
      const id = url.searchParams.get("id"), show = loadById(id), c = check(show);
      return ok({ id, show, errors: c.errors, warnings: c.warnings });
    }
    if (m === "GET" && p === "/api/export") {
      const id = url.searchParams.get("id"), show = loadById(id);
      res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${showFile(id).name}.json"` });
      return res.end(stringifyShow(show));
    }
    if (m === "POST" && p === "/api/show") {   // import / save
      const show = body && body.show;
      if (!show || show.format !== SHOW_FORMAT) throw new HttpError(400, `not a show: "format" must be "${SHOW_FORMAT}"`);
      const name = slug(body.name || show.name);
      if (!NAME.test(name)) throw new HttpError(400, "give the show a name (letters and digits)");
      const c = check(show);
      if (c.errors.length) throw new HttpError(400, "the show is not valid, so it was not saved", { errors: c.errors, warnings: c.warnings });
      const file = join(dirs.local, `${name}.json`);
      if (existsSync(file) && !body.overwrite) throw new HttpError(409, `local/${name} already exists`, { exists: true, id: `local/${name}` });
      mkdirSync(dirs.local, { recursive: true });
      writeFileSync(file, stringifyShow(show));
      return ok({ id: `local/${name}`, warnings: c.warnings }, 201);
    }
    if (m === "POST" && p === "/api/validate") { const show = showFrom(body), c = check(show, settingsFrom(body, show)); return ok({ ok: !c.errors.length, errors: c.errors, warnings: c.warnings }); }
    if (m === "POST" && p === "/api/sim") {
      const show = showFrom(body), settings = settingsFrom(body, show), c = check(show, settings);
      if (c.errors.length) throw new HttpError(400, "the show is not valid", { errors: c.errors, warnings: c.warnings });
      const { layout, loco } = context();
      const r = await simulateShow(show, { layout, loco, sounds: sounds.dry, settings });
      return ok({ ...r, warnings: c.warnings, commands: r.commands.length, sounds: r.sounds.length });
    }
    if (m === "POST" && p === "/api/run") { const show = loadById(body && body.id); return ok({ run: startRun(body.id, show, settingsFrom(body, show)) }, 202); }
    if (m === "POST" && p === "/api/stop") {
      if (!run) throw new HttpError(409, "nothing is running");
      run.ac.abort(); return ok({ message: "stopping: the loco ramps down" }, 202);
    }
    if (m === "POST" && p === "/api/estop") return ok({ message: await emergencyStop() });
    if (m === "GET" && p === "/api/sounds") return ok(soundList());
    if (m === "POST" && p === "/api/sounds/play") {
      if (run) throw new HttpError(409, "a show is running: sounds are off limits until it ends");
      const id = body && body.id;
      if (!id || !sounds.play.has(id)) throw new HttpError(404, `unknown sound "${id}"`);
      const gain = body.gain == null ? 1 : Number(body.gain), seconds = body.seconds == null ? undefined : Number(body.seconds);
      if (!(gain >= 0 && gain <= 1.5)) throw new HttpError(400, "gain must be between 0 and 1.5");
      if (seconds !== undefined && !(seconds > 0 && seconds <= 60)) throw new HttpError(400, "seconds must be between 0 and 60");
      const h = sounds.play.play(id, { gain, seconds }); handles.add(h);
      let ms = null; try { ms = sounds.play.duration(id); } catch { /* unknown */ }
      return ok({ played: id, durationMs: seconds ? Math.min(ms ?? Infinity, seconds * 1000) : ms });
    }
    if (m === "POST" && p === "/api/sounds/stop") { sounds.play.stopAll(); handles.clear(); return ok({ message: "stopped" }); }
    throw new HttpError(404, `no such route: ${m} ${p}`);
  }

  const json = (res, code, data) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || "");
      if (!(host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`)) throw new HttpError(403, "this service only answers on localhost");
      const url = new URL(req.url, `http://${host}`);
      let body = null;
      if (req.method === "POST") {
        if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "POST bodies must be application/json");
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new HttpError(413, "body too large"); chunks.push(c); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { throw new HttpError(400, "the body is not valid JSON"); }
      } else if (req.method !== "GET") throw new HttpError(405, "GET and POST only");
      await route(req, res, url, body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, status, { error: e.message, ...(e.extra || {}) }); else res.end();
    }
  });

  return {
    server,
    listen: (wanted = 0, host = "127.0.0.1") => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, host, () => { port = server.address().port; resolve({ port, host, url: `http://127.0.0.1:${port}/` }); });
    }),
    /** Stop any running show (ramps down), drop clients, close the listener. */
    async close() {
      clearInterval(ticker);
      if (run) { run.ac.abort(); for (let i = 0; i < 300 && run; i++) await new Promise((r) => setTimeout(r, 100)); }
      for (const c of clients) { try { c.end(); } catch { /* gone */ } }
      clients.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
    emergencyStop,
    get running() { return !!run; },
  };
}
