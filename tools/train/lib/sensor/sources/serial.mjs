// Reads the sensor sketch's output from a serial port: one "<reading>[,<microseconds>]" line per sample (115200 baud, macOS/Linux).
// If the sketch prints microseconds, t is the sensor's own clock (immune to USB arrival jitter); otherwise t is the host clock.
//
// Reconnects: when the port goes away (unplugged, board reset) the source keeps trying every `reconnectMs` and carries on
// when it comes back, with its clock continuing from where it left off. macOS renames the device on a replug (usbmodem1101
// becomes usbmodem2214201), so each attempt re-resolves the port:
//   port: "/dev/cu.usbmodem1101"   used while it exists; if it has vanished, the only /dev/cu.usbmodem* present is used
//   port: () => "/dev/cu.whatever" your own resolver, called on every attempt
// reconnectMs: 0 turns reconnecting off (a failure then goes to the error callback).
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";

export function detectPorts(dir = "/dev") {
  try { return readdirSync(dir).filter((f) => f.startsWith("cu.usbmodem")).map((f) => `${dir}/${f}`); } catch { return []; }
}

export class SerialSource {
  constructor({ port, baud = 115200, reconnectMs = 1000, detect = detectPorts }) {
    this.port = port; this.baud = baud; this.reconnectMs = reconnectMs; this.detect = detect;
    this._rs = null; this._stopped = true; this._timer = null; this.current = null;
  }
  resolve() {
    if (typeof this.port === "function") return this.port();
    if (existsSync(this.port)) return this.port;
    const found = this.detect();
    return found.length === 1 ? found[0] : null;
  }
  start(onSample, onError = (e) => { throw e; }) {
    this._stopped = false;
    let clock = 0;
    const open = () => {
      if (this._stopped) return;
      const path = this.resolve();
      if (!path || !existsSync(path)) return retry(new Error(`no serial port${path ? ` at ${path}` : ""}`));
      const flags = process.platform === "darwin" ? ["-f"] : ["-F"];
      spawnSync("stty", [...flags, path, String(this.baud), "raw", "-echo", "-hupcl"]);
      this.current = path;
      let partial = "", sawHeader = false, prevUs = null, failed = false;
      const rs = this._rs = createReadStream(path);
      const fail = (e) => { if (failed || this._rs !== rs) return; failed = true; rs.destroy(); retry(e); };
      rs.on("data", (buf) => {
        const now = Date.now();
        partial += buf.toString("latin1");
        const lines = partial.split("\n");
        partial = lines.pop();
        for (const ln of lines) {
          if (!sawHeader) { sawHeader = true; continue; }   // the first line is usually a fragment
          const parts = ln.trim().split(",");
          const v = parseInt(parts[0], 10);
          if (Number.isNaN(v)) continue;
          let t = now;
          if (parts.length > 1) {
            const us = parseInt(parts[1], 10);
            if (!Number.isNaN(us)) { if (prevUs != null) clock += ((us - prevUs) >>> 0) / 1000; prevUs = us; t = clock; }
          }
          onSample({ t, h: now, v });
        }
      });
      rs.on("error", fail);
      rs.on("end", () => fail(new Error("serial port closed")));
    };
    const retry = (err) => {
      if (this._stopped) return;
      if (!this.reconnectMs) return onError(err);
      this._timer = setTimeout(open, this.reconnectMs);
    };
    open();
  }
  stop() {
    this._stopped = true; clearTimeout(this._timer);
    if (this._rs) { this._rs.destroy(); this._rs = null; }
  }
}
