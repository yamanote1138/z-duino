import { describe, it, expect, vi } from 'vitest'
import { BeamFeed, makeController } from '../src/composables/showHost'

describe('BeamFeed', () => {
  it('waitFor resolves with the event, and rejects on timeout', async () => {
    vi.useFakeTimers()
    const feed = new BeamFeed({ state: () => 'clear', level: () => 771 })
    const got = feed.waitFor('break', { timeoutMs: 1000 })
    feed.emit({ event: 'break', edge: 'nose', t: 5 })
    expect(await got).toMatchObject({ edge: 'nose', t: 5 })
    const late = feed.waitFor('restore', { timeoutMs: 1000 })
    vi.advanceTimersByTime(1001)
    await expect(late).rejects.toThrow('no restore within 1 s')
    vi.useRealTimers()
  })

  it('also emits nose and tail edges', () => {
    const feed = new BeamFeed({ state: () => 'clear', level: () => 0 })
    const seen: string[] = []
    feed.on('nose', () => seen.push('nose')); feed.on('break', () => seen.push('break'))
    feed.emit({ event: 'break', edge: 'nose' })
    expect(seen).toEqual(['break', 'nose'])
  })
})

describe('makeController', () => {
  const deps = () => {
    const sent: object[] = []
    return {
      sent,
      d: {
        speed: () => 0, forward: () => true, connected: () => true, hasLed: () => true,
        send: (m: object) => { sent.push(m) },
        setDirection: vi.fn(), rampTo: vi.fn(async () => {}), setSpeedNow: vi.fn(), emergencyStop: vi.fn(),
        creep: vi.fn(async () => ({ result: 'event' as const, detail: '', parked: 'nose' as const })),
      },
    }
  }

  it('a guarded move becomes a firmware creep on the named event', async () => {
    const { d } = deps()
    const r = await makeController(d).guardedMove({ event: 'break', forward: true, speed: 0.15, maxMs: 30000, afterMs: 0 })
    expect(d.creep).toHaveBeenCalledWith(true, ['break'], 30000, 0)
    expect(r.result).toBe('guard')
  })

  it('a refused creep says why', async () => {
    const { d } = deps()
    d.creep.mockResolvedValueOnce({ result: 'refused', detail: 'stop the train first', parked: null } as never)
    expect((await makeController(d).guardedMove({ event: 'break', forward: true, maxMs: 1000 })).result).toBe('refused: stop the train first')
  })

  it('ramps take the show engine\'s seconds per 0.1', async () => {
    const { d } = deps()
    await makeController(d).rampTo(0.35, { secondsPer01: 2 })
    expect(d.rampTo).toHaveBeenCalledWith(0.35, 7000)
  })

  it('LED commands are skipped without an LED', () => {
    const { d, sent } = deps()
    d.hasLed = () => false
    expect(makeController(d).led(1000, 0, 0)).toBe(false)
    expect(sent).toEqual([])
  })
})
