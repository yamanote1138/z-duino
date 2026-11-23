// Tiny WAV synthesiser (mono, 16-bit, 22.05 kHz). Everything is generated, nothing is sampled from a real loco:
// these are impressions (a stepped inverter whine, a two-tone horn, a crossing bell), not recordings of a JRF EF210.

import { writeFileSync } from "node:fs";

export const RATE = 22050;
const TAU = Math.PI * 2;

export function writeWav(path, f) {
  let peak = 0;
  for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
  const g = peak > 0.85 ? 0.85 / peak : 1;     // never clip
  const buf = Buffer.alloc(44 + f.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + f.length * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(f.length * 2, 40);
  for (let i = 0; i < f.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f[i] * g)) * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const frames = (dur) => Math.round(dur * RATE);

// Band-limited rumble that loops perfectly: every component is a whole number of cycles in `dur`.
function loopNoise(out, dur, lo, hi, count, amp, seed) {
  const r = rng(seed);
  for (let k = 0; k < count; k++) {
    const f = Math.round((lo + r() * (hi - lo)) * dur) / dur, ph = r() * TAU, a = amp * (0.5 + r());
    for (let i = 0; i < out.length; i++) out[i] += a * Math.sin(TAU * f * (i / RATE) + ph);
  }
}

// Steady inverter whine at one pitch, with a quiet blower underneath. Loops without a click.
export function inverterLoop(freq, dur = 30) {
  const n = frames(dur), out = new Float32Array(n), f = Math.round(freq * dur) / dur;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, trem = 1 + 0.06 * Math.sin(TAU * (8 / dur) * t * 1);
    out[i] = trem * (0.34 * Math.sin(TAU * f * t) + 0.12 * Math.sin(TAU * 2 * f * t + 0.6) + 0.05 * Math.sin(TAU * 3 * f * t + 1.1));
  }
  loopNoise(out, dur, 120, 1400, 40, 0.012, 7);
  return out;
}

export function blowerHum(dur = 30) {
  const n = frames(dur), out = new Float32Array(n), f = Math.round(96 * dur) / dur;
  for (let i = 0; i < n; i++) { const t = i / RATE; out[i] = 0.2 * Math.sin(TAU * f * t) + 0.08 * Math.sin(TAU * 2 * f * t + 0.4); }
  loopNoise(out, dur, 60, 700, 40, 0.01, 11);
  return out;
}

// Pitch climbs (or falls) from f0 to f1 in steps, the way a VVVF drive climbs through its pulse modes.
export function inverterSweep(dur, f0, f1, steps = 6) {
  const n = frames(dur), out = new Float32Array(n), r = rng(3);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n, k = u * steps, stair = (Math.floor(k) + smooth((k - Math.floor(k)) * 4)) / steps;
    const f = f0 + (f1 - f0) * (0.35 * u + 0.65 * Math.min(1, stair));
    ph += (TAU * f) / RATE;
    const rising = f1 >= f0, env = rising ? 0.25 + 0.75 * Math.pow(u, 0.6) : 1 - 0.55 * Math.pow(u, 1.5);
    const atk = Math.min(1, i / (RATE * 0.08)), rel = Math.min(1, (n - i) / (RATE * 0.08));
    out[i] = atk * rel * env * (0.34 * Math.sin(ph) + 0.12 * Math.sin(2 * ph + 0.6) + 0.05 * Math.sin(3 * ph + 1.1) + 0.03 * (r() - 0.5));
  }
  return out;
}

// Two-tone air horn.
export function horn(dur = 1.3) {
  const n = frames(dur), out = new Float32Array(n), r = rng(5), tones = [392, 494];
  for (let i = 0; i < n; i++) {
    const t = i / RATE, atk = smooth(t / 0.04), rel = smooth((dur - t) / 0.25);
    const flutter = 1 + 0.004 * Math.sin(TAU * 5.5 * t);
    let s = 0;
    for (const f of tones) for (let h = 1; h <= 5; h++) s += (1 / h) * 0.17 * Math.sin(TAU * f * h * flutter * t + h);
    out[i] = atk * rel * (s + 0.03 * (r() - 0.5));
  }
  return out;
}

// Level-crossing "kan kan": two alternating metallic strikes.
export function crossingBell(dur = 1.8) {
  const n = frames(dur), out = new Float32Array(n), gap = 0.45, pitches = [1050, 1260];
  for (let s = 0; s * gap < dur; s++) {
    const f = pitches[s % 2], start = Math.round(s * gap * RATE);
    for (let i = 0; start + i < n; i++) {
      const t = i / RATE; if (t > 0.42) break;
      const env = Math.exp(-7 * t) * Math.min(1, t / 0.002);
      out[start + i] += env * (0.35 * Math.sin(TAU * f * t) + 0.15 * Math.sin(TAU * f * 2.76 * t) + 0.07 * Math.sin(TAU * f * 5.4 * t));
    }
  }
  return out;
}

// Brake / air release: a hiss that fades.
export function airRelease(dur = 1.1) {
  const n = frames(dur), out = new Float32Array(n), r = rng(9);
  let lp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, w = r() * 2 - 1;
    lp += 0.45 * (w - lp);                       // gentle low-pass
    const hp = lp - prev; prev = lp;             // then a high-pass difference: "tsss"
    const env = smooth(t / 0.02) * Math.exp(-3.4 * t);
    out[i] = env * (0.9 * hp + 0.12 * lp);
  }
  return out;
}

// Station chime: a falling two-note "ding-dong".
export function chime() {
  const dur = 2.0, n = frames(dur), out = new Float32Array(n), notes = [[659, 0], [523, 0.5]];
  for (const [f, at] of notes) {
    const start = Math.round(at * RATE);
    for (let i = 0; start + i < n; i++) {
      const t = i / RATE, env = Math.exp(-3.2 * t) * Math.min(1, t / 0.003);
      out[start + i] += env * (0.3 * Math.sin(TAU * f * t) + 0.1 * Math.sin(TAU * f * 2 * t) + 0.04 * Math.sin(TAU * f * 3.01 * t));
    }
  }
  return out;
}

// ---- horn candidates (the first horn() sounded harsh) ----
const saw = (ph, harmonics, rolloff) => { let s = 0; for (let h = 1; h <= harmonics; h++) s += Math.sin(h * ph + h * 0.7) / Math.pow(h, rolloff); return s; };

// A: two-tone air horn, each tone a pair of slightly detuned oscillators, with the pitch scooping up at the start.
export function hornAir(dur = 1.1, tones = [370, 466]) {
  const n = frames(dur), out = new Float32Array(n), phs = tones.flatMap(() => [0, 0]);
  for (let i = 0; i < n; i++) {
    const t = i / RATE, scoop = 1 - 0.07 * Math.exp(-t / 0.05), atk = smooth(t / 0.05), rel = smooth((dur - t) / 0.22);
    let s = 0;
    tones.forEach((f, k) => [0, 1].forEach((d) => {
      const idx = k * 2 + d; phs[idx] += (TAU * f * scoop * (1 + (d ? 0.0035 : -0.0035))) / RATE;
      s += saw(phs[idx], 7, 1.35);
    }));
    out[i] = atk * rel * 0.09 * s;
  }
  return out;
}

// B: one clean electric-whistle note that glides up a little: "pwaan".
export function hornElectric(dur = 0.9, f = 620) {
  const n = frames(dur), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, glide = 1 - 0.12 * Math.exp(-t / 0.09), atk = smooth(t / 0.03), rel = smooth((dur - t) / 0.2);
    ph += (TAU * f * glide * (1 + 0.006 * Math.sin(TAU * 6 * t))) / RATE;
    out[i] = atk * rel * (0.3 * Math.sin(ph) + 0.1 * Math.sin(3 * ph) + 0.04 * Math.sin(5 * ph));
  }
  return out;
}

// C: low three-note diesel-style chord, slower to speak.
export function hornLow(dur = 1.5) { return hornAir(dur, [185, 233, 277]); }
