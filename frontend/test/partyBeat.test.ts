import { describe, it, expect } from 'vitest'
import { createPartyBeat, PARTY_BPM } from '../src/composables/partyBeat'

const RED = { r: 1000, g: 0, b: 0 }
const BLUE = { r: 0, g: 0, b: 1000 }
const GREEN = { r: 0, g: 1000, b: 0 }

// Always picks index 0, then 1, then 2... (but never repeats — see "no repeats")
function seq(...values: number[]) {
  let i = 0
  return () => values[i++ % values.length]
}

describe('partyBeat', () => {
  const beatMs = 60000 / PARTY_BPM

  it('kick flashes on the beat and decays toward a dim floor', () => {
    const b = createPartyBeat({ colors: [RED], random: () => 0 })
    const onBeat = b.frame(0)
    const midway = b.frame(beatMs * 0.4)
    const late = b.frame(beatMs * 0.49)
    expect(onBeat.r).toBe(1000)
    expect(midway.r).toBeLessThan(onBeat.r)
    expect(late.r).toBeLessThan(midway.r)
    expect(late.r).toBeGreaterThan(0) // never fully dark
  })

  it('pulses again on the next beat', () => {
    const b = createPartyBeat({ colors: [RED], random: () => 0 })
    b.frame(0)
    const dip = b.frame(beatMs * 0.49).r
    const nextKick = b.frame(beatMs * 1.0).r
    expect(nextKick).toBeGreaterThan(dip * 5)
    expect(nextKick).toBe(1000)
  })

  it('adds a white hi-hat sparkle on the off-beat', () => {
    const b = createPartyBeat({ colors: [RED], random: () => 0 })
    b.frame(0)
    const before = b.frame(beatMs * 0.49)
    const hat = b.frame(beatMs * 0.5)
    expect(before.g).toBe(0)
    expect(hat.g).toBeGreaterThan(0)
    expect(hat.b).toBeGreaterThan(0)
  })

  it('changes colour on each bar, never repeating back-to-back', () => {
    // random: 0, 0 (repeat → rerolled), 0.99 → RED, then forced off RED
    const b = createPartyBeat({ colors: [RED, BLUE, GREEN], random: seq(0, 0, 0.5) })
    const barMs = beatMs * 4
    const bar0 = b.frame(0)
    const bar1 = b.frame(barMs)
    expect(bar0.r).toBe(1000) // RED
    expect(bar1.b).toBe(1000) // BLUE — the repeated RED roll was rejected
  })

  it('holds one colour for the whole bar', () => {
    const b = createPartyBeat({ colors: [RED, BLUE], random: seq(0, 1) })
    for (let beat = 0; beat < 4; beat++) {
      const f = b.frame(beatMs * beat)
      expect(f.b).toBe(0)
      expect(f.r).toBe(1000)
    }
  })

  it('fill: last beat of every 4th bar fires four rising 16th-note hits', () => {
    const b = createPartyBeat({ colors: [RED], random: () => 0 })
    const barMs = beatMs * 4
    const fillStart = barMs * 3 + beatMs * 3
    // Walk the bars in order so the engine tracks bar changes
    for (let t = 0; t < fillStart; t += 25) b.frame(t)
    const peaks = [0, 1, 2, 3].map(i => b.frame(fillStart + (beatMs / 4) * i).r)
    expect(peaks[1]).toBeGreaterThan(peaks[0])
    expect(peaks[2]).toBeGreaterThan(peaks[1])
    expect(peaks[3]).toBeGreaterThan(peaks[2])
    // ...and it dips between hits (strobe, not a solid glow)
    const dip = b.frame(fillStart + (beatMs / 4) * 0.9).r
    expect(dip).toBeLessThan(peaks[0])
  })

  it('keeps every channel within 0–1000 as integers', () => {
    const b = createPartyBeat({ colors: [RED, BLUE, GREEN, { r: 1000, g: 1000, b: 1000 }] })
    for (let t = 0; t < 20000; t += 17) {
      const { r, g, b: blue } = b.frame(t)
      for (const v of [r, g, blue]) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1000)
      }
    }
  })

  it('rejects an empty palette', () => {
    expect(() => createPartyBeat({ colors: [] })).toThrow()
  })
})
