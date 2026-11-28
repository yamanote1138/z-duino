import { describe, it, expect } from 'vitest'
import { runShow, SHOW, type ShowDeps } from '../src/composables/show'
import type { ParkResult } from '../src/composables/parkSearch'

function rig(opts: { parks?: ParkResult[]; beam?: Record<string, boolean>; cancelAt?: string } = {}) {
  const log: string[] = []
  const parks = opts.parks ?? [{ ok: true, parked: 'nose', detail: 'Parked on nose' }, { ok: true, parked: 'nose', detail: 'Parked on nose' }]
  let cancelled = false
  const deps: ShowDeps = {
    async park(t, o) { log.push(`park ${t}${o?.from ? ' from ' + o.from : ''}`); return parks.shift()! },
    async horn() { log.push('horn'); if (opts.cancelAt === 'horn') cancelled = true },
    async rampTo(s, ms) { log.push(`ramp ${s}${ms ? ' in ' + ms : ''}`) },
    setDirection(f) { log.push(`dir ${f}`) },
    async waitBeam(e, ms) { log.push(`wait ${e} ${ms}`); return opts.beam?.[e] ?? true },
    async pause(ms) { log.push(`pause ${ms}`) },
    cancelled: () => cancelled,
    onStep: (t) => log.push(`step ${t}`),
  }
  return { deps, log }
}

describe('runShow', () => {
  it('parks, horns, does a lap, parks from past, horns', async () => {
    const { deps, log } = rig()
    expect(await runShow(deps)).toEqual({ ok: true, detail: 'Show done' })
    expect(log.filter(l => !l.startsWith('step'))).toEqual([
      'park nose', 'horn', 'dir true', 'wait restore 30000', `ramp ${SHOW.cruise}`,
      'wait break 90000', 'ramp 0 in 1000', 'pause 500', 'park nose from past', 'horn',
    ])
  })

  it('stops when the first park fails', async () => {
    const { deps, log } = rig({ parks: [{ ok: false, parked: null, detail: 'calibrate the sensor first' }] })
    expect(await runShow(deps)).toEqual({ ok: false, detail: 'calibrate the sensor first' })
    expect(log).not.toContain('horn')
  })

  it('stops the loco when it never comes back round', async () => {
    const { deps, log } = rig({ beam: { break: false } })
    expect(await runShow(deps)).toEqual({ ok: false, detail: 'the loco did not come back round in 90 s' })
    expect(log.at(-1)).toBe('ramp 0')
  })

  it('stops the loco when it never leaves the beam', async () => {
    const { deps, log } = rig({ beam: { restore: false } })
    expect((await runShow(deps)).detail).toBe('the loco did not leave the beam in 30 s')
    expect(log.at(-1)).toBe('ramp 0')
  })

  it('Stop during the horn ends it before departing', async () => {
    const { deps, log } = rig({ cancelAt: 'horn' })
    expect(await runShow(deps)).toEqual({ ok: false, detail: 'stopped' })
    expect(log).not.toContain('dir true')
  })
})
