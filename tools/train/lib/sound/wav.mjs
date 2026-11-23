// Duration of a PCM WAV file from its header, in ms (null if it is not a WAV we can read).
import { openSync, readSync, closeSync } from "node:fs";

export function wavDurationMs(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) < 12 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
    let pos = 12, byteRate = 0;
    const ch = Buffer.alloc(8);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, ch, 0, 8, pos) < 8) return null;
      const id = ch.toString("ascii", 0, 4), size = ch.readUInt32LE(4);
      if (id === "fmt ") { const f = Buffer.alloc(16); readSync(fd, f, 0, 16, pos + 8); byteRate = f.readUInt32LE(8); }
      else if (id === "data") return byteRate ? Math.round((size / byteRate) * 1000) : null;
      pos += 8 + size + (size & 1);
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
