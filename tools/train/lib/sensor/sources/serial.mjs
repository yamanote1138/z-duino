// Reads the sensor sketch's output from a serial port: one "<reading>[,<microseconds>]" line per sample (115200 baud, macOS/Linux).
// If the sketch prints microseconds, t is the sensor's own clock (immune to USB arrival jitter); otherwise t is the host clock.
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";

export class SerialSource {
  constructor({ port, baud = 115200 }) { this.port = port; this.baud = baud; this._rs = null; }
  start(onSample, onError = (e) => { throw e; }) {
    const flags = process.platform === "darwin" ? ["-f"] : ["-F"];
    spawnSync("stty", [...flags, this.port, String(this.baud), "raw", "-echo", "-hupcl"]);
    let partial = "", sawHeader = false, clock = 0, prevUs = null;
    this._rs = createReadStream(this.port);
    this._rs.on("data", (buf) => {
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
    this._rs.on("error", onError);
  }
  stop() { if (this._rs) { this._rs.destroy(); this._rs = null; } }
}
