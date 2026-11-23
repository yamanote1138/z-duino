// Time for the show runtime: the real clock, or a virtual one that runs a whole show in milliseconds (dry runs, tests).
export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** A clock you drive: sleep() queues a timer, run(promise) fires timers in time order until the promise settles. */
export class VirtualClock {
  constructor() { this.t = 0; this._q = []; this._seq = 0; }
  now() { return this.t; }
  sleep(ms) { return new Promise((res) => { this._q.push({ at: this.t + Math.max(0, ms), seq: this._seq++, res }); }); }
  async run(promise, { maxMs = 6 * 3600 * 1000 } = {}) {
    let state = null;
    promise.then((v) => { state = { v }; }, (e) => { state = { e }; });
    for (;;) {
      await new Promise((r) => setImmediate(r));          // let every pending promise reaction run first
      if (state) break;
      if (!this._q.length) throw new Error("the show is waiting for something that can never happen (nothing is scheduled)");
      this._q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this._q.shift();
      if (next.at > maxMs) throw new Error(`simulated time passed ${maxMs / 1000} s: the show does not finish`);
      this.t = next.at; next.res();
    }
    if (state.e) throw state.e;
    return state.v;
  }
}
