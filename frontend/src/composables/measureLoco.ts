// Learn the loco from the beam: laps at two speeds give in/s and the length, single passes give the slower speeds.

export interface LocoProfile {
  lengthIn: number
  points: { thr: number; v: number }[]
  fit: { inPerSecPerUnitThrottle: number; offsetInS: number }
  measuredAt: string
}
export interface MeasureDeps {
  rampTo(speed: number): Promise<void>
  waitBeam(event: 'break' | 'restore', maxMs: number): Promise<{ t?: number } | null>   // null on timeout or Stop
  cancelled(): boolean
  onStep(text: string): void
}
export interface MeasureResult { ok: boolean; profile?: LocoProfile; detail: string }

export const MEASURE = { loopIn: 134, lapSpeeds: [0.45, 0.35], passSpeeds: [0.25, 0.15], waitMs: 150000 }

export function fitLine(points: { thr: number; v: number }[]) {
  const n = points.length
  const mx = points.reduce((a, p) => a + p.thr, 0) / n, my = points.reduce((a, p) => a + p.v, 0) / n
  const sxx = points.reduce((a, p) => a + (p.thr - mx) ** 2, 0), sxy = points.reduce((a, p) => a + (p.thr - mx) * (p.v - my), 0)
  const slope = sxx > 0 ? sxy / sxx : 0
  return { inPerSecPerUnitThrottle: Math.round(slope * 1000) / 1000, offsetInS: Math.round((my - slope * mx) * 1000) / 1000 }
}

class Ended extends Error {}

export async function measureLoco(deps: MeasureDeps): Promise<MeasureResult> {
  let blocked = true   // it starts parked on the nose
  const at = async (event: 'break' | 'restore'): Promise<number> => {
    const m = await deps.waitBeam(event, MEASURE.waitMs)
    if (deps.cancelled()) throw new Ended('stopped')
    if (!m) throw new Ended(`did not see the beam ${event} within ${MEASURE.waitMs / 1000} s`)
    blocked = event === 'break'
    return m.t ?? performance.now()
  }
  const points: { thr: number; v: number }[] = []
  const lengths: number[] = []
  try {
    for (const thr of MEASURE.lapSpeeds) {
      deps.onStep(`Laps at ${thr}`)
      await deps.rampTo(thr)
      if (blocked) await at('restore')
      const b1 = await at('break'), r1 = await at('restore'), b2 = await at('break')
      const v = MEASURE.loopIn / ((b2 - b1) / 1000)
      points.push({ thr, v: Math.round(v * 100) / 100 })
      lengths.push(v * ((r1 - b1) / 1000))
    }
    const lengthIn = lengths.reduce((a, b) => a + b, 0) / lengths.length
    for (const thr of MEASURE.passSpeeds) {
      deps.onStep(`One pass at ${thr}`)
      await deps.rampTo(thr)
      if (blocked) await at('restore')
      const b = await at('break'), r = await at('restore')
      points.push({ thr, v: Math.round((lengthIn / ((r - b) / 1000)) * 100) / 100 })
    }
    deps.onStep('Stopping')
    await deps.rampTo(0)
    points.sort((a, b) => a.thr - b.thr)
    if (points.some((p) => !(p.v > 0))) return { ok: false, detail: 'a speed came out at zero: did the loco stall?' }
    const profile = { lengthIn: Math.round(lengthIn * 10) / 10, points, fit: fitLine(points), measuredAt: new Date().toISOString() }
    return { ok: true, profile, detail: `Loco ${profile.lengthIn} in long; ${points.map((p) => `${p.thr}: ${p.v} in/s`).join(', ')}` }
  } catch (e) {
    if (!(e instanceof Ended)) throw e
    if (e.message !== 'stopped') await deps.rampTo(0)
    return { ok: false, detail: e.message }
  }
}
