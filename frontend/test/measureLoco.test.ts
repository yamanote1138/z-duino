import { describe, it, expect } from 'vitest'
import { measureLoco, fitLine, MEASURE, type MeasureDeps } from '../src/composables/measureLoco'

// A loco 15 in long whose speed is 20 in/s per unit throttle minus 1: beam times follow from where it is
function rig({ stallAt = Infinity, cancelAfter = Infinity } = {}) {
  const v = (thr: number) => 20 * thr - 1
  let t = 0, thr = 0, nose = 0, waits = 0
  const L = 15, LOOP = MEASURE.loopIn
  const ramps: number[] = []
  // advance to the next time the nose (break) or tail (restore) crosses the beam at 0
  const next = (event: string) => {
    const target = event === 'break' ? Math.ceil((nose + 1e-9) / LOOP) * LOOP : Math.ceil((nose - L + 1e-9) / LOOP) * LOOP + L
    const dt = (target - nose) / v(thr)
    t += dt * 1000; nose = target
    return t
  }
  const deps: MeasureDeps = {
    async rampTo(s) { ramps.push(s); thr = s },
    async waitBeam(event) {
      if (++waits > stallAt) return null
      return { event, t: next(event) }
    },
    cancelled: () => waits >= cancelAfter,
    onStep: () => {},
  }
  return { deps, ramps }
}

describe('measureLoco', () => {
  it('measures length and speeds, and fits a line', async () => {
    const { deps, ramps } = rig()
    const r = await measureLoco(deps)
    expect(r.ok).toBe(true)
    expect(r.profile!.lengthIn).toBeCloseTo(15, 1)
    expect(r.profile!.points.map(p => p.thr)).toEqual([0.15, 0.25, 0.35, 0.45])
    for (const p of r.profile!.points) expect(p.v).toBeCloseTo(20 * p.thr - 1, 1)
    expect(r.profile!.fit.inPerSecPerUnitThrottle).toBeCloseTo(20, 1)
    expect(r.profile!.fit.offsetInS).toBeCloseTo(-1, 1)
    expect(ramps).toEqual([0.45, 0.35, 0.25, 0.15, 0])
  })

  it('stops the loco and saves nothing when the beam goes quiet', async () => {
    const { deps, ramps } = rig({ stallAt: 3 })
    const r = await measureLoco(deps)
    expect(r.ok).toBe(false); expect(r.profile).toBeUndefined()
    expect(r.detail).toContain('did not see')
    expect(ramps.at(-1)).toBe(0)
  })

  it('Stop ends it with nothing saved', async () => {
    const { deps } = rig({ cancelAfter: 2 })
    const r = await measureLoco(deps); expect(r).toEqual({ ok: false, detail: 'stopped' })
  })

  it('fitLine is a least-squares line', () => {
    expect(fitLine([{ thr: 0, v: 1 }, { thr: 1, v: 3 }])).toEqual({ inPerSecPerUnitThrottle: 2, offsetInS: 1 })
  })
})
