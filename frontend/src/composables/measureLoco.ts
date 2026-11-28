// Learn the loco from the beam: a lap per speed gives in/s, the pass at the first speed gives the length.

export interface LocoProfile {
  lengthIn: number
  points: { thr: number; v: number }[]
  fit: { inPerSecPerUnitThrottle: number; offsetInS: number }
  measuredAt: string
  method: 'laps'
}
export interface MeasureDeps {
  rampTo(speed: number): Promise<void>
  waitBeam(event: 'break' | 'restore', maxMs: number): Promise<{ t?: number } | null>   // null on timeout or Stop
  cancelled(): boolean
  onStep(text: string): void
}
export interface MeasureResult { ok: boolean; profile?: LocoProfile; detail: string }

export const MEASURE = { loopIn: 134, speeds: [0.45, 0.35, 0.25, 0.15], waitMs: 150000 }

export function fitLine(points: { thr: number; v: number }[]) {
  const n = points.length
  const mx = points.reduce((a, p) => a + p.thr, 0) / n, my = points.reduce((a, p) => a + p.v, 0) / n
  const sxx = points.reduce((a, p) => a + (p.thr - mx) ** 2, 0), sxy = points.reduce((a, p) => a + (p.thr - mx) * (p.v - my), 0)
  const slope = sxx > 0 ? sxy / sxx : 0
  return { inPerSecPerUnitThrottle: Math.round(slope * 1000) / 1000, offsetInS: Math.round((my - slope * mx) * 1000) / 1000 }
}

class Ended extends Error {}

export async function measureLoco(deps: MeasureDeps): Promise<MeasureResult> {
  const at = async (event: 'break' | 'restore'): Promise<number> => {
    const m = await deps.waitBeam(event, MEASURE.waitMs)
    if (deps.cancelled()) throw new Ended('stopped')
    if (!m) throw new Ended(`did not see the beam ${event} within ${MEASURE.waitMs / 1000} s`)
    return m.t ?? performance.now()
  }
  const points: { thr: number; v: number }[] = []
  const lapSpeed = (from: number, to: number) => MEASURE.loopIn / ((to - from) / 1000)
  try {
    const [first, ...rest] = MEASURE.speeds
    deps.onStep(`Lap at ${first}`)
    await deps.rampTo(first)
    await at('restore')   // off the mark
    let b = await at('break')
    const r = await at('restore')
    let next = await at('break')
    let v = lapSpeed(b, next)
    points.push({ thr: first, v: Math.round(v * 100) / 100 })
    const lengthIn = v * ((r - b) / 1000)
    for (const thr of rest) {
      deps.onStep(`Lap at ${thr}`)
      await deps.rampTo(thr)   // at the beam, so the lap from here is at the new speed
      b = next
      next = await at('break')
      v = lapSpeed(b, next)
      points.push({ thr, v: Math.round(v * 100) / 100 })
    }
    deps.onStep('Stopping')
    await deps.rampTo(0)
    points.sort((a, b) => a.thr - b.thr)
    if (points.some((p) => !(p.v > 0))) return { ok: false, detail: 'a speed came out at zero: did the loco stall?' }
    const profile: LocoProfile = { lengthIn: Math.round(lengthIn * 10) / 10, points, fit: fitLine(points), measuredAt: new Date().toISOString(), method: 'laps' }
    return { ok: true, profile, detail: `Loco ${profile.lengthIn} in long; ${points.map((p) => `${p.thr}: ${p.v} in/s`).join(', ')}` }
  } catch (e) {
    if (!(e instanceof Ended)) throw e
    if (e.message !== 'stopped') await deps.rampTo(0)
    return { ok: false, detail: e.message }
  }
}
