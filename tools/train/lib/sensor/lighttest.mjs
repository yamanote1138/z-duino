// Statistics for the room-light test (light-test.mjs): how steady is the sensor, and how repeatable is the edge timing?
//
//   const row = lightStats({ samples, passes, startT, clearMin });
//
//   samples   raw readings [{ t (ms), v }] over the whole run
//   passes    the sensor's `pass` events, in order: { t0, t1 } (ms, interpolated edges of each crossing)
//   startT    where the first clear stretch begins (after backing out of the beam)
//   clearMin  a reading at or above this counts as "clear"
// The loco crosses at a constant creep speed, so the spread of its pass time is the spread of the edge timing.
// Passes alternate forward, reverse, forward, ...

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const round = (v, n) => +v.toFixed(n);
const MARGIN_MS = 300, MID_MS = 250;

export function lightStats({ samples, passes, startT = -Infinity, clearMin }) {
  if (!passes.length) throw new Error("no passes were recorded");
  // clear stretches: 300 ms after one pass ends to 300 ms before the next begins (and the opening stretch before the first)
  const stretches = [{ a: startT, b: passes[0].t0 }];
  for (let k = 0; k + 1 < passes.length; k++) stretches.push({ a: passes[k].t1, b: passes[k + 1].t0 });
  stretches.push({ a: passes.at(-1).t1, b: samples.at(-1).t });
  const clear = [];
  for (const { a, b } of stretches) for (const s of samples) if (s.t - a > MARGIN_MS && b - s.t > MARGIN_MS && s.v >= clearMin) clear.push(s.v);
  // blocked: the middle of each pass
  const blocked = [];
  for (const p of passes) for (const s of samples) if (s.t - p.t0 > MID_MS && p.t1 - s.t > MID_MS) blocked.push(s.v);
  const secs = passes.map((p) => (p.t1 - p.t0) / 1000);
  const fwd = secs.filter((_, i) => i % 2 === 0), rev = secs.filter((_, i) => i % 2 === 1);
  if (!clear.length) throw new Error("no clear readings between the passes");
  const clearMean = mean(clear), blockedMean = blocked.length ? mean(blocked) : NaN;
  return {
    passes: passes.length, clearN: clear.length,
    clearMean: round(clearMean, 1), clearMin: Math.min(...clear), clearMax: Math.max(...clear), clearSd: round(sd(clear), 2),
    blockedMean: round(blockedMean, 1), swing: round(clearMean - blockedMean, 1),
    passMeanS: round(mean(secs), 3), passSdMs: round(sd(secs) * 1000, 1),
    fwdMeanS: fwd.length ? round(mean(fwd), 3) : NaN, revMeanS: rev.length ? round(mean(rev), 3) : NaN,
  };
}
