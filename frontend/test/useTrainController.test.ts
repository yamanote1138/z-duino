import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { FakeWebSocket } from './setup'

// useTrainController.ts is a singleton composable (module-scoped state),
// so each test gets a fresh module instance via resetModules() + a dynamic
// import — otherwise state (and the fake WebSocket) would bleed across tests.
let tc: Awaited<ReturnType<typeof importController>>

async function importController() {
  const mod = await import('../src/composables/useTrainController')
  return { ...mod.useTrainController(), ledColors: mod.ledColors }
}

function getDebugValue(label: string): string {
  const entry = tc.getDebugInfo().find(i => i.label === label)
  if (!entry) throw new Error(`debug entry not found: ${label}`)
  return entry.value
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  FakeWebSocket.instances.length = 0
  localStorage.clear()
  tc = await importController()
  FakeWebSocket.instances[0].simulateOpen()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('speed segments', () => {
  it('ramps up to a higher segment', async () => {
    tc.setSpeed(0.1, 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.1)
  })

  it('clicking an already-lit segment ramps back down one level', async () => {
    tc.setSpeed(0.2, 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.2)

    tc.setSpeed(0.2, 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.1)
  })

  it('clicking segment 0 when lit ramps all the way down to 0', async () => {
    tc.setSpeed(0.1, 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.1)

    tc.setSpeed(0.1, 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.currentSpeed.value).toBeCloseTo(0)
  })

  it('getSegmentClass colors zones red/yellow/green by speed', () => {
    // segments 0-2 red, 3-6 yellow, 7-9 green (per powerLevels thresholds)
    tc.currentSpeed.value = 1.0
    expect(tc.getSegmentClass(0)).toContain('bg-red-500')
    expect(tc.getSegmentClass(3)).toContain('bg-yellow-500')
    expect(tc.getSegmentClass(7)).toContain('bg-green-500')
    tc.currentSpeed.value = 0
    expect(tc.getSegmentClass(0)).toContain('bg-neutral-700')
  })
})

describe('toggleDirection', () => {
  it('flips immediately when already stopped', () => {
    expect(tc.currentDirection.value).toBe(true)
    tc.toggleDirection()
    expect(tc.currentDirection.value).toBe(false)
  })

  it('ramps to zero, pauses, flips direction, then ramps back up (fire-and-forget)', async () => {
    tc.setSpeed(0.2, 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.2)

    let resolved = false
    const toggling = tc.toggleDirection().then(() => { resolved = true })

    // Still ramping down — direction must not have flipped yet, promise not resolved.
    await vi.advanceTimersByTimeAsync(500)
    expect(tc.currentDirection.value).toBe(true)
    expect(resolved).toBe(false)

    // Enough time for ramp-down (2000ms) + DIRECTION_PAUSE (500ms) + the
    // short post-flip pause (100ms) to fully elapse.
    await vi.advanceTimersByTimeAsync(2200)
    await toggling
    expect(resolved).toBe(true)
    expect(tc.currentDirection.value).toBe(false)

    // The ramp back up to the previous speed is fire-and-forget — it
    // shouldn't have been awaited by the promise above, but should
    // complete on its own once given enough time.
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.2)
  })
})

describe('direction invert', () => {
  it('toggling persists to localStorage and sends the invert command', () => {
    const socket = FakeWebSocket.instances[0]
    expect(tc.directionInverted.value).toBe(false)

    tc.toggleInvert()

    expect(tc.directionInverted.value).toBe(true)
    expect(localStorage.getItem('directionInverted')).toBe('true')
    expect(socket.lastSent()).toEqual({ cmd: 'invert', value: true })
  })

  it('reads a persisted preference on load and sends it once connected', async () => {
    localStorage.setItem('directionInverted', 'true')
    vi.resetModules()
    FakeWebSocket.instances.length = 0
    tc = await importController()

    expect(tc.directionInverted.value).toBe(true)

    const socket = FakeWebSocket.instances[0]
    socket.simulateOpen()
    expect(socket.lastSent()).toEqual({ cmd: 'invert', value: true })
  })
})

describe('LED brightness scaling', () => {
  it('scales r/g/b down when dim, full-scale when bright', () => {
    const socket = FakeWebSocket.instances[0]
    const red = tc.ledColors.find(c => c.name === 'Red')!

    tc.setLed(red)
    expect(socket.lastSent()).toEqual({ cmd: 'led', r: 1000, g: 0, b: 0 })

    tc.toggleBright() // bright -> dim (0.25x)
    tc.setLed(red)
    expect(socket.lastSent()).toEqual({ cmd: 'led', r: 250, g: 0, b: 0 })
  })
})

describe('reconnect backoff', () => {
  it('doubles on each disconnect, capped at RECONNECT_MAX', async () => {
    expect(getDebugValue('Reconnect Delay')).toBe('1000ms')

    FakeWebSocket.instances[0].simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('2000ms')
    await vi.advanceTimersByTimeAsync(1000)

    FakeWebSocket.instances.at(-1)!.simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('4000ms')
    await vi.advanceTimersByTimeAsync(2000)

    FakeWebSocket.instances.at(-1)!.simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('8000ms')
    await vi.advanceTimersByTimeAsync(4000)

    FakeWebSocket.instances.at(-1)!.simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('16000ms')
    await vi.advanceTimersByTimeAsync(8000)

    FakeWebSocket.instances.at(-1)!.simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('30000ms') // 32000 clamped to RECONNECT_MAX

    await vi.advanceTimersByTimeAsync(16000)
    FakeWebSocket.instances.at(-1)!.simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('30000ms') // stays capped
  })

  it('resets the backoff to base once reconnected', async () => {
    FakeWebSocket.instances[0].simulateClose()
    expect(getDebugValue('Reconnect Delay')).toBe('2000ms')
    await vi.advanceTimersByTimeAsync(1000)

    FakeWebSocket.instances.at(-1)!.simulateOpen()
    expect(getDebugValue('Reconnect Delay')).toBe('1000ms')
  })
})
