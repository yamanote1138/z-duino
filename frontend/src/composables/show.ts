// The first show: park on nose, horn, one lap at cruise, back onto the nose, horn.
import type { ParkOptions, ParkResult, ParkTarget } from './parkSearch'

export interface ShowDeps {
  park(target: ParkTarget, opts?: ParkOptions): Promise<ParkResult>
  horn(): Promise<void>
  rampTo(speed: number, durationMs?: number): Promise<void>
  setDirection(forward: boolean): void
  waitBeam(event: 'break' | 'restore', maxMs: number): Promise<boolean>   // false on timeout or Stop
  pause(ms: number): Promise<void>
  cancelled(): boolean
  onStep(text: string): void
}
export interface ShowResult { ok: boolean; detail: string }

export const SHOW = { cruise: 0.35, leaveMs: 30000, lapMs: 90000, stopMs: 1000, settleMs: 500 }

export async function runShow(deps: ShowDeps): Promise<ShowResult> {
  const stopped = { ok: false, detail: 'stopped' }
  async function halt(detail: string): Promise<ShowResult> {
    await deps.rampTo(0)
    return deps.cancelled() ? stopped : { ok: false, detail }
  }

  deps.onStep('Parking on nose')
  const first = await deps.park('nose')
  if (!first.ok) return { ok: false, detail: first.detail }
  if (deps.cancelled()) return stopped

  deps.onStep('Horn')
  await deps.horn()
  if (deps.cancelled()) return stopped

  deps.onStep('Departing')
  deps.setDirection(true)
  const left = deps.waitBeam('restore', SHOW.leaveMs)   // listen before moving: the tail may clear during the ramp
  await deps.rampTo(SHOW.cruise)
  if (!await left) return halt('the loco did not leave the beam in 30 s')

  deps.onStep('Running a lap')
  if (!await deps.waitBeam('break', SHOW.lapMs)) return halt('the loco did not come back round in 90 s')

  deps.onStep('Slowing for the mark')
  await deps.rampTo(0, SHOW.stopMs)   // a short stop keeps the overshoot small
  if (deps.cancelled()) return stopped
  await deps.pause(SHOW.settleMs)

  const last = await deps.park('nose', { from: 'past' })
  if (!last.ok) return { ok: false, detail: last.detail }

  deps.onStep('Horn')
  await deps.horn()
  return { ok: true, detail: 'Show done' }
}
