// What the Mac kit's show engine needs from its surroundings, built from the throttle app: throttle, beam events, sound.
import type { CreepResult, CreepUntil } from './parkSearch'

export interface BeamMsg { event: string; edge?: string; t?: number; [k: string]: unknown }
type Listener = (m: BeamMsg) => void

// The beam as the engine sees it: the relayed events, plus `nose`/`tail` for labeled edges.
export class BeamFeed {
  private listeners = new Map<string, Set<Listener>>()
  constructor(private d: { state(): string; level(): number }) {}
  get state() { return this.d.state() }
  get lastReading() { return this.d.level() }
  setDirection() { /* the controller labels edges itself */ }
  on(event: string, f: Listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(f) }
  off(event: string, f: Listener) { this.listeners.get(event)?.delete(f) }
  emit(m: BeamMsg) {
    for (const f of [...(this.listeners.get(m.event) ?? [])]) f(m)
    if ((m.event === 'break' || m.event === 'restore') && (m.edge === 'nose' || m.edge === 'tail')) for (const f of [...(this.listeners.get(m.edge) ?? [])]) f(m)
  }
  waitFor(event: string, { timeoutMs = 30000 } = {}): Promise<BeamMsg> {
    return new Promise((resolve, reject) => {
      const f = (m: BeamMsg) => { clearTimeout(timer); this.off(event, f); resolve(m) }
      const timer = setTimeout(() => { this.off(event, f); reject(new Error(`no ${event} within ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
      this.on(event, f)
    })
  }
}

export interface ControllerDeps {
  speed(): number
  forward(): boolean
  connected(): boolean
  hasLed(): boolean
  send(m: object): void
  setDirection(forward: boolean): void
  rampTo(speed: number, durationMs?: number): Promise<void>
  setSpeedNow(speed: number): void
  emergencyStop(): void
  creep(forward: boolean, until: CreepUntil[], maxMs: number, afterMs?: number): Promise<CreepResult>
}

interface Move { event: string; forward: boolean; speed?: number; maxMs: number; afterMs?: number }

export function makeController(d: ControllerDeps) {
  const ctl = {
    config: { creepMax: 0.15, rampSecondsPer01: 1 },
    get speed() { return d.speed() },
    get forward() { return d.forward() },
    get connected() { return d.connected() },
    send(m: object) { d.send(m) },
    async setDirection(forward: boolean) {
      if (d.speed() > 0 && forward !== d.forward()) throw new Error('cannot change direction while moving: ramp to 0 first')
      d.setDirection(forward)
    },
    rampTo(to: number, opts: { secondsPer01?: number } = {}) {
      const ms = opts.secondsPer01 ? Math.round((Math.abs(to - d.speed()) / 0.1) * opts.secondsPer01 * 1000) : undefined
      return d.rampTo(to, ms)
    },
    halt(opts: { secondsPer01?: number } = {}) { return ctl.rampTo(0, opts) },
    setSpeed(v: number) { d.setSpeedNow(v) },
    emergencyStop() { d.emergencyStop() },
    async guardedMove(m: Move) {   // the firmware stops it on the beam event, at its own creep speed
      const t0 = Date.now()
      const r = await d.creep(m.forward, [m.event as CreepUntil], m.maxMs, m.afterMs ?? 0)
      return { result: r.result === 'event' ? 'guard' : `${r.result}${r.detail ? ': ' + r.detail : ''}`, elapsedMs: Date.now() - t0 }
    },
    led(r: number, g: number, b: number) { if (!d.hasLed()) return false; d.send({ cmd: 'led', r, g, b }); return true },
    ledAuto() { if (!d.hasLed()) return false; d.send({ cmd: 'led_auto' }); return true },
  }
  return ctl
}

interface Node { src: AudioBufferSourceNode; gain: GainNode }

// Web Audio player with the Mac kit's sound interface: one-shots, looping slots, stop with a short fade.
export function makeSoundPlayer(ctx: AudioContext, pack: Record<string, { file: string }>, base: string) {
  const buffers = new Map<string, AudioBuffer>()
  const slots = new Map<string, Node>()
  const playing = new Set<Node>()

  function start(id: string, gain: number, loop: boolean): Node {
    const buffer = buffers.get(id)
    if (!buffer) throw new Error(`sound ${id} is not loaded`)
    const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = loop
    const g = ctx.createGain(); g.gain.value = gain
    src.connect(g).connect(ctx.destination); src.start()
    return { src, gain: g }
  }
  function fadeOut(n: Node, at = ctx.currentTime) {
    try { n.gain.gain.setTargetAtTime(0, at, 0.06); n.src.stop(at + 0.4) } catch { /* already stopped */ }
  }

  return {
    async load(ids: string[]) {
      await Promise.all(ids.map(async (id) => {
        if (buffers.has(id)) return
        const entry = pack[id]
        if (!entry) throw new Error(`sound ${id} is not in the pack`)
        const res = await fetch(base + entry.file)
        if (!res.ok) throw new Error(`could not load ${entry.file} (${res.status}): run frontend/scripts/import-sounds.sh and flash the app`)
        buffers.set(id, await ctx.decodeAudioData(await res.arrayBuffer()))
      }))
    },
    check(ids: string[]) { const missing = ids.filter((id) => !pack[id]); if (missing.length) throw new Error(`unknown sound ${missing.join(', ')}`) },
    play(id: string, { gain = 1, seconds }: { gain?: number; seconds?: number } = {}) {
      const n = start(id, gain, false); playing.add(n)
      const done = new Promise<void>((resolve) => { n.src.onended = () => { playing.delete(n); resolve() } })
      if (seconds) fadeOut(n, ctx.currentTime + Math.max(0, seconds - 0.3))
      return { done, stop: () => fadeOut(n) }
    },
    loop(slot: string, id: string, { gain = 1 }: { gain?: number } = {}) {
      const old = slots.get(slot); if (old) fadeOut(old)
      slots.set(slot, start(id, gain, true))
    },
    stop(slot: string) { const n = slots.get(slot); if (n) { fadeOut(n); slots.delete(slot) } },
    stopAll() { for (const n of slots.values()) fadeOut(n); slots.clear(); for (const n of playing) fadeOut(n); playing.clear() },
    fill() { throw new Error('fill (flange squeals) is not in the app yet') },
  }
}
