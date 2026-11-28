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
