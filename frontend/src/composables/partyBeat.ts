// Party mode beat engine — pure logic, no timers, no WebSocket.
//
// Simulates a techno track at a fixed BPM and turns the elapsed time into an
// RGB frame (0–1000 per channel, same scale as the `led` command):
//   - Kick: four-on-the-floor. Flash on every beat, exponential decay.
//   - Hi-hat: white sparkle on the off-beat (halfway between kicks).
//   - Bar change: new colour every 4 beats (never repeats back-to-back).
//   - Fill: the last beat of every 4th bar becomes four rising 16th-note hits.

export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface PartyBeatOptions {
  colors: RgbColor[]
  bpm?: number
  /** Injectable for deterministic tests. Defaults to Math.random. */
  random?: () => number
}

export const PARTY_BPM = 128
const BEATS_PER_BAR = 4
const BARS_PER_PHRASE = 4
const MAX = 1000
const KICK_FLOOR = 0.1 // LED never goes fully dark between kicks
const KICK_DECAY = 5 // higher = snappier pulse
const HAT_LEVEL = 0.45
const HAT_DECAY = 22

const clamp = (v: number) => Math.min(MAX, Math.max(0, Math.round(v)))

function kick(phase: number, peak = 1): number {
  return KICK_FLOOR + (peak - KICK_FLOOR) * Math.exp(-KICK_DECAY * phase)
}

function hat(phase: number): number {
  return phase < 0.5 ? 0 : HAT_LEVEL * Math.exp(-HAT_DECAY * (phase - 0.5))
}

export function createPartyBeat({ colors, bpm = PARTY_BPM, random = Math.random }: PartyBeatOptions) {
  if (colors.length === 0) throw new Error('createPartyBeat needs at least one colour')

  const beatMs = 60000 / bpm
  let currentBar = -1
  let colorIdx = -1

  function pickColor() {
    if (colors.length === 1) {
      colorIdx = 0
      return
    }
    let next = colorIdx
    while (next === colorIdx) next = Math.floor(random() * colors.length)
    colorIdx = next
  }

  /** RGB frame for `elapsedMs` since the party started. Call with non-decreasing times. */
  function frame(elapsedMs: number): RgbColor {
    const beat = elapsedMs / beatMs
    const beatIdx = Math.floor(beat)
    const phase = beat - beatIdx
    const bar = Math.floor(beatIdx / BEATS_PER_BAR)
    const beatInBar = beatIdx % BEATS_PER_BAR

    if (bar !== currentBar) {
      currentBar = bar
      pickColor()
    }
    const color = colors[colorIdx]

    const isFill = bar % BARS_PER_PHRASE === BARS_PER_PHRASE - 1 && beatInBar === BEATS_PER_BAR - 1
    let level: number
    let sparkle = 0
    if (isFill) {
      const sub = phase * 4
      const hit = Math.floor(sub)
      level = kick(sub - hit, 0.6 + 0.1 * hit) // builds toward the next bar's downbeat
    } else {
      level = kick(phase)
      sparkle = hat(phase)
    }

    return {
      r: clamp(color.r * level + MAX * sparkle),
      g: clamp(color.g * level + MAX * sparkle),
      b: clamp(color.b * level + MAX * sparkle)
    }
  }

  return { frame, beatMs }
}
