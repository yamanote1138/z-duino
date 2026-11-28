// Reads the sensor sketch's output from a serial port: one "<reading>[,<microseconds>]" line per sample (115200 baud, macOS/Linux).
// If the sketch prints microseconds, t is the sensor's own clock (immune to USB arrival jitter); otherwise t is the host clock.
//
// Reconnects: when the port goes away (unplugged, board reset) the source keeps trying every `reconnectMs` and carries on
// when it comes back, with its clock continuing from where it left off. macOS renames the device on a replug (usbmodem1101
// becomes usbmodem2214201), so each attempt re-resolves the port:
//   port: "/dev/cu.usbmodem1101"   used while it exists; if it has vanished, the only sensor-looking port present is used
//   port: () => "/dev/cu.whatever" your own resolver, called on every attempt
// reconnectMs: 0 turns reconnecting off (a failure then goes to the error callback).
import { spawnSync } from "node:child_process";
import { closeSync, constants, createReadStream, existsSync, openSync, readdirSync } from "node:fs";
import { isatty, ReadStream as TtyReadStream } from "node:tty";

const PORT_PREFIXES = ["cu.usbmodem", "cu.usbserial-", "cu.wchusbserial"];   // Uno R4, then the D1 Mini's CH340
const RESET_MS = 5000;   // a bigger jump in sensor micros is a reset (the D1 Mini resets without closing the port)

export function detectPorts(dir = "/dev") {
  try { return readdirSync(dir).filter((f) => PORT_PREFIXES.some((p) => f.startsWith(p))).map((f) => `${dir}/${f}`); } catch { return []; }
}

// A blocking open of a CH340 port waits forever for carrier detect, so ttys are opened non-blocking, then set up while held open.
function openPort(path, baud) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
  if (isatty(fd)) {
    spawnSync("stty", [process.platform === "darwin" ? "-f" : "-F", path, String(baud), "raw", "-echo", "-hupcl"]);
    return new TtyReadStream(fd);
  }
  closeSync(fd);
  return createReadStream(path);
}

export class SerialSource {
  constructor({ port, baud = 115200, reconnectMs = 1000, detect = detectPorts }) {
    this.port = port; this.baud = baud; this.reconnectMs = reconnectMs; this.detect = detect;
    this._rs = null; this._stopped = true; this._timer = null; this.current = null; this.lastError = null;
  }
  resolve() {
    if (typeof this.port === "function") return this.port();
    if (this.port && existsSync(this.port)) return this.port;
    const found = this.detect();
    return found.length === 1 ? found[0] : null;
  }
  /** Why no port could be opened, in words you can act on. */
  why(path) {
    if (path) return `no serial port at ${path}`;
    const found = this.detect();
    const gone = typeof this.port === "string" && this.port ? `${this.port} is not there and ` : "";
    return found.length > 1
      ? `no serial port: several sensor ports (${found.join(", ")}): set sensor.port in local/config.jsonc, or SENSOR_PORT`
      : `no serial port: ${gone}no /dev/cu.usbmodem* or /dev/cu.usbserial-* device is present (is the sensor board plugged in directly, not through a power-only adapter or port?)`;
  }
  start(onSample, onError = (e) => { throw e; }) {
    this._stopped = false;
    let clock = 0;
    const open = () => {
      if (this._stopped) return;
      const path = this.resolve();
      if (!path || !existsSync(path)) return retry(new Error(this.why(path)));
      this.current = path;
      let partial = "", sawHeader = false, prevUs = null, prevH = null, failed = false;
      let rs;
      try { rs = this._rs = openPort(path, this.baud); } catch (e) { return retry(e); }
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
            if (!Number.isNaN(us)) {
              if (prevUs != null) { const d = ((us - prevUs) >>> 0) / 1000; clock += d > RESET_MS ? now - prevH : d; }
              prevUs = us; prevH = now; t = clock;
            }
          }
          onSample({ t, h: now, v });
        }
      });
      rs.on("error", fail);
      rs.on("end", () => fail(new Error("serial port closed")));
    };
    const retry = (err) => {
      if (this._stopped) return;
      this.lastError = err;
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
