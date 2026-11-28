import { describe, it, expect } from 'vitest'
// @ts-expect-error plain JS from the Mac kit
import { validateShow } from '../../tools/train/lib/show/schema.mjs'
// @ts-expect-error plain JS from the Mac kit
import { runShow } from '../../tools/train/lib/show/runtime.mjs'
import fullLap from '../../tools/train/examples/shows/full-lap.json'

describe('the Mac kit show engine in the browser build', () => {
  it('imports and validates a show', () => {
    expect(typeof runShow).toBe('function')
    const r = validateShow(fullLap, { soundFiles: false })
    expect(r.errors.filter((e: string) => !e.includes('zone'))).toEqual([])
  })

  it('allows a creep at 0.15', () => {
    const show = { format: 'z-show/1', name: 't', start: 'clear', steps: [{ do: 'creep', forward: true, speed: 0.15, until: 'break', maxMs: 5000 }] }
    expect(validateShow(show, { soundFiles: false }).errors).toEqual([])
  })
})

import jrLap from '../src/shows/jr-lap.json'

describe('the JR lap show', () => {
  const ids = ['idle.compressor', 'melody.seseragi', 'door.close', 'door.open', 'brake.release', 'brake.squeal', 'motion.accelerate', 'motion.coast', 'motion.decelerate', 'horn.depart', 'chime.station']
  const sounds = { check(want: string[]) { const bad = want.filter(i => !ids.includes(i)); if (bad.length) throw new Error(`unknown ${bad}`) } }
  const loco = { lengthIn: 15, points: [{ thr: 0.15, v: 1.8 }, { thr: 0.45, v: 7 }], fit: { inPerSecPerUnitThrottle: 17.3, offsetInS: -0.8 } }

  it('is valid with the import script\'s sounds and a measured loco', () => {
    const r = validateShow(jrLap, { sounds, layout: { loopIn: 134, zones: {} }, loco, soundFiles: false })
    expect(r.errors).toEqual([])
  })
})
