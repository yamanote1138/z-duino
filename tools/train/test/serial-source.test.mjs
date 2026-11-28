import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SerialSource, detectPorts } from "../lib/sensor/sources/serial.mjs";

const lines = (vals, us0 = 0) => "junk\n" + vals.map((v, i) => `${v},${us0 + i * 2000}`).join("\n") + "\n";
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

test("reconnects to a renamed port and keeps its clock running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ser-"));
  const a = join(dir, "cu.usbmodem1101"), b = join(dir, "cu.usbmodem2214201");
  writeFileSync(a, lines([300, 301, 302]));
  const got = [];
  const src = new SerialSource({ port: a, reconnectMs: 20, detect: () => [b] });
  src.start((s) => got.push(s), (e) => { throw e; });
  await until(() => got.length >= 2);          // the first line is dropped as a fragment, so 3 values give 2 samples
  // "unplug": a vanishes, the board comes back under another name
  const { unlinkSync } = await import("node:fs");
  unlinkSync(a); writeFileSync(b, lines([40, 41, 42], 9000000));
  await until(() => got.some((s) => s.v < 100));
  src.stop();
  assert.equal(src.current, b);
  const ts = got.map((s) => s.t);
  assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]), `time went backwards: ${ts}`);
});

test("with reconnect off a missing port is an error", async () => {
  const errs = [];
  const src = new SerialSource({ port: "/nonexistent/port", reconnectMs: 0, detect: () => [] });
  src.start(() => {}, (e) => errs.push(e));
  await until(() => errs.length === 1);
  assert.match(errs[0].message, /no serial port/);
});

test("stop cancels pending retries", async () => {
  const src = new SerialSource({ port: "/nonexistent/port", reconnectMs: 10, detect: () => [] });
  let opened = 0; const orig = src.resolve.bind(src); src.resolve = () => { opened++; return orig(); };
  src.start(() => {});
  await new Promise((r) => setTimeout(r, 35)); src.stop(); const n = opened;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(opened, n);
});

test("a reset mid-stream (micros back near 0) does not jump the clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ser-"));
  const a = join(dir, "cu.usbserial-110");
  writeFileSync(a, lines([300, 301, 302], 600000000) + "\x00garbage boot text\n" + [303, 304].map((v, i) => `${v},${100 + i * 2000}`).join("\n") + "\n");
  const got = [];
  const src = new SerialSource({ port: a, reconnectMs: 0, detect: () => [] });
  src.start((s) => got.push(s), () => {});
  await until(() => got.length >= 4);
  src.stop();
  const ts = got.map((s) => s.t);
  assert.ok(ts.every((t, i) => i === 0 || (t >= ts[i - 1] && t - ts[i - 1] < 1000)), `clock jumped: ${ts}`);
});

test("finds the D1 Mini's CH340 ports as well as usbmodem", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-"));
  for (const f of ["cu.usbmodem1101", "cu.usbserial-110", "cu.wchusbserial110", "cu.Bluetooth-Incoming-Port", "tty.usbserial-110"]) writeFileSync(join(dir, f), "");
  assert.deepEqual(detectPorts(dir).map((p) => p.slice(dir.length + 1)).sort(), ["cu.usbmodem1101", "cu.usbserial-110", "cu.wchusbserial110"]);
});
