// The parking search, Mac kit style: a few guarded creeps in a row, each stopped by the controller on a beam event.

export type ParkTarget = 'nose' | 'tail'
export type CreepUntil = 'break' | 'restore'
export interface CreepResult { result: 'event' | 'timeout' | 'aborted' | 'refused'; detail: string; parked: ParkTarget | null }
export interface ParkDeps {
  creep(forward: boolean, until: CreepUntil[], maxMs: number, afterMs?: number): Promise<CreepResult>
  pause(ms: number): Promise<void>
  beamState(): string
  parked(): ParkTarget | null
  cancelled(): boolean
  onStep(text: string): void
}
export interface ParkOptions { from?: 'past' }   // 'past': the loco just ran over the beam, so skip the just-short creep
export interface ParkResult { ok: boolean; parked: ParkTarget | null; detail: string }

export const PARK = {
  backOff: { maxMs: 20000, afterMs: 450 },   // creep is slow on a long loco: give it time to clear
  approachMs: 8000,
  nearMs: 5000,
  past: { maxMs: 12500, afterMs: 450 },
  loopMs: 80000,
  tailMs: 8000,
  reversePauseMs: 500,
}

class Ended extends Error { constructor(public detail: string) { super(detail) } }

export async function park(target: ParkTarget, deps: ParkDeps, opts: ParkOptions = {}): Promise<ParkResult> {
  if (deps.parked() === target) return { ok: true, parked: target, detail: `Already parked on ${target}` }
  let lastForward: boolean | null = null

  // One guarded creep; true if it ended on its events. An abort or refusal ends the whole search.
  async function leg(step: string, forward: boolean, until: CreepUntil[], maxMs: number, afterMs = 0): Promise<boolean> {
    if (deps.cancelled()) throw new Ended('stopped')
    if (lastForward !== null && lastForward !== forward) {
      await deps.pause(PARK.reversePauseMs)
      if (deps.cancelled()) throw new Ended('stopped')
    }
    lastForward = forward
    deps.onStep(step)
    const r = await deps.creep(forward, until, maxMs, afterMs)
    if (r.result === 'aborted' || r.result === 'refused') throw new Ended(r.detail || r.result)
    return r.result === 'event'
  }

  const approach = () => leg('Creeping forward onto the beam', true, ['break'], PARK.approachMs)

  async function toNose(): Promise<void> {
    if (deps.beamState() === 'blocked') {
      if (!await leg('Backing off the beam', false, ['restore'], PARK.backOff.maxMs, PARK.backOff.afterMs))
        throw new Ended('the beam stays blocked when backing off: is something else in it?')
      if (!await approach()) throw new Ended('backed off the beam but could not find it again')
      return
    }
    if (opts.from !== 'past' && await leg('Just short? Creeping forward', true, ['break'], PARK.nearMs)) return
    if (await leg('Just past? Backing over the beam', false, ['break', 'restore'], PARK.past.maxMs, PARK.past.afterMs)) {
      if (await approach()) return
    }
    if (await leg('Looking round the loop (up to 80 s)', true, ['break'], PARK.loopMs)) return
    throw new Ended('the beam did not break in 80 s: is the loco on the track?')
  }

  async function seatTail(): Promise<void> {
    if (!await leg('Seating the tail: forward until it clears', true, ['restore'], PARK.tailMs))
      throw new Ended('could not clear the beam with the tail')
    if (!await leg('Backing the tail onto the beam', false, ['break'], PARK.tailMs))
      throw new Ended('cleared the beam but could not find it again with the tail')
  }

  try {
    if (!(target === 'tail' && deps.parked() === 'nose')) await toNose()
    if (target === 'tail') await seatTail()
    return { ok: true, parked: target, detail: `Parked on ${target}` }
  } catch (e) {
    if (e instanceof Ended) return { ok: false, parked: null, detail: e.detail }
    throw e
  }
}
