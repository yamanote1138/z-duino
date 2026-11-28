import { describe, it, expect } from 'vitest'
import { park, type CreepResult, type CreepUntil, type ParkTarget } from '../src/composables/parkSearch'

type Call = [boolean, CreepUntil[], number, number] | ['pause', number]

function rig(state: string, results: Partial<CreepResult>[], parked: ParkTarget | null = null, cancelAfter = Infinity) {
  const calls: Call[] = []
  const steps: string[] = []
  let creeps = 0
  const deps = {
    async creep(forward: boolean, until: CreepUntil[], maxMs: number, afterMs = 0): Promise<CreepResult> {
      calls.push([forward, until, maxMs, afterMs]); creeps++
      const r = results.shift() ?? { result: 'timeout' }
      return { result: 'event', detail: '', parked: null, ...r } as CreepResult
    },
    async pause(ms: number) { calls.push(['pause', ms]) },
    beamState: () => state,
    parked: () => parked,
    cancelled: () => creeps >= cancelAfter,
    onStep: (t: string) => steps.push(t),
  }
  return { deps, calls, steps }
}

const ev = (parked: ParkTarget | null = null): Partial<CreepResult> => ({ result: 'event', parked })
const timeout: Partial<CreepResult> = { result: 'timeout' }

describe('park', () => {
  it('blocked: backs off then approaches', async () => {
    const { deps, calls, steps } = rig('blocked', [ev(), ev('nose')])
    const r = await park('nose', deps)
    expect(calls).toEqual([[false, ['restore'], 20000, 450], ['pause', 500], [true, ['break'], 8000, 0]])
    expect(steps).toEqual(['Backing off the beam', 'Creeping forward onto the beam'])
    expect(r).toEqual({ ok: true, parked: 'nose', detail: 'Parked on nose' })
  })

  it('clear: just short', async () => {
    const { deps, calls } = rig('clear', [ev('nose')])
    const r = await park('nose', deps)
    expect(calls).toEqual([[true, ['break'], 5000, 0]])
    expect(r.ok).toBe(true)
  })

  it('clear: just past', async () => {
    const { deps, calls, steps } = rig('clear', [timeout, ev(), ev('nose')])
    const r = await park('nose', deps)
    expect(calls).toEqual([
      [true, ['break'], 5000, 0], ['pause', 500],
      [false, ['break', 'restore'], 12500, 450], ['pause', 500],
      [true, ['break'], 8000, 0],
    ])
    expect(steps).toEqual(['Just short? Creeping forward', 'Just past? Backing over the beam', 'Creeping forward onto the beam'])
    expect(r.parked).toBe('nose')
  })

  it('clear: round the loop', async () => {
    const { deps, calls, steps } = rig('clear', [timeout, timeout, ev('nose')])
    const r = await park('nose', deps)
    expect(calls.slice(-2)).toEqual([['pause', 500], [true, ['break'], 80000, 0]])
    expect(steps.at(-1)).toBe('Looking round the loop (up to 80 s)')
    expect(r.ok).toBe(true)
  })

  it('gives up after the loop', async () => {
    const { deps } = rig('clear', [timeout, timeout, timeout])
    expect(await park('nose', deps)).toEqual({ ok: false, parked: null, detail: 'the beam did not break in 80 s: is the loco on the track?' })
  })

  it('gives up when backing off never clears', async () => {
    const { deps } = rig('blocked', [timeout])
    expect((await park('nose', deps)).detail).toBe('the beam stays blocked when backing off: is something else in it?')
  })

  it('gives up when it backed off but lost the beam', async () => {
    const { deps } = rig('blocked', [ev(), timeout])
    expect((await park('nose', deps)).detail).toBe('backed off the beam but could not find it again')
  })

  it('tail: nose first, then seats the tail', async () => {
    const { deps, calls, steps } = rig('clear', [ev('nose'), ev('tail'), ev('tail')])
    const r = await park('tail', deps)
    expect(calls).toEqual([
      [true, ['break'], 5000, 0],
      [true, ['restore'], 8000, 0], ['pause', 500],
      [false, ['break'], 8000, 0],
    ])
    expect(steps.slice(-2)).toEqual(['Seating the tail: forward until it clears', 'Backing the tail onto the beam'])
    expect(r).toEqual({ ok: true, parked: 'tail', detail: 'Parked on tail' })
  })

  it('tail fails when the tail never clears or never comes back', async () => {
    expect((await park('tail', rig('clear', [ev('nose'), timeout]).deps)).detail).toBe('could not clear the beam with the tail')
    expect((await park('tail', rig('clear', [ev('nose'), ev(), timeout]).deps)).detail).toBe('cleared the beam but could not find it again with the tail')
  })

  it('tail when already parked on nose skips to the tail steps', async () => {
    const { deps, calls } = rig('blocked', [ev('tail'), ev('tail')], 'nose')
    await park('tail', deps)
    expect(calls[0]).toEqual([true, ['restore'], 8000, 0])
  })

  it('already parked on the target does nothing', async () => {
    const { deps, calls } = rig('blocked', [], 'nose')
    expect(await park('nose', deps)).toEqual({ ok: true, parked: 'nose', detail: 'Already parked on nose' })
    expect(calls).toEqual([])
  })

  it('an aborted creep ends the search with its detail', async () => {
    const { deps, calls } = rig('blocked', [{ result: 'aborted', detail: 'stopped' }])
    expect(await park('nose', deps)).toEqual({ ok: false, parked: null, detail: 'stopped' })
    expect(calls.length).toBe(1)
  })

  it('a refused creep ends the search with its reason', async () => {
    const { deps } = rig('clear', [{ result: 'refused', detail: 'calibrate the sensor first' }])
    expect((await park('nose', deps)).detail).toBe('calibrate the sensor first')
  })

  it('cancelled between creeps sends no more creeps', async () => {
    const { deps, calls } = rig('clear', [timeout, ev(), ev('nose')], null, 1)
    expect(await park('nose', deps)).toEqual({ ok: false, parked: null, detail: 'stopped' })
    expect(calls.filter((c) => c[0] !== 'pause').length).toBe(1)
  })

  it('pauses only before a creep that changes direction', async () => {
    const { deps, calls } = rig('clear', [ev('nose'), ev(), ev('tail')])
    await park('tail', deps)
    expect(calls.findIndex((c) => c[0] === 'pause')).toBe(2)
    expect(calls.filter((c) => c[0] === 'pause').length).toBe(1)
  })
})

describe('park from past', () => {
  it('skips the just-short creep when told the loco is just past', async () => {
    const { deps, calls } = rig('clear', [ev(), ev('nose')])
    const r = await park('nose', deps, { from: 'past' })
    expect(calls).toEqual([[false, ['break', 'restore'], 12500, 450], ['pause', 500], [true, ['break'], 8000, 0]])
    expect(r.ok).toBe(true)
  })
})
