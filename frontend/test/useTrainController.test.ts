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
    tc.setSpeed(0.1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.1)
  })

  it('clicking a lower segment ramps down to exactly that level', async () => {
    // ramp is 1s per 10%
    tc.setSpeed(0.9)
    await vi.advanceTimersByTimeAsync(10000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.9)

    tc.setSpeed(0.5)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.5)
  })

  it('clicking the level being passed through mid-ramp pins the train there', async () => {
    tc.setSpeed(0.9)
    await vi.advanceTimersByTimeAsync(3000)
    const passing = tc.currentSpeed.value
    expect(passing).toBeGreaterThan(0.2)
    expect(passing).toBeLessThan(0.9)

    tc.setSpeed(passing)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tc.currentSpeed.value).toBeCloseTo(passing)
  })

  it('clicking the segment matching the current speed does nothing', async () => {
    tc.setSpeed(0.2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.2)

    const socket = FakeWebSocket.instances[0]
    const sentBefore = socket.sent.length
    tc.setSpeed(0.2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tc.currentSpeed.value).toBeCloseTo(0.2)
    expect(socket.sent.length).toBe(sentBefore)
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
    tc.setSpeed(0.2)
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

describe('party mode', () => {
  const ledFrames = (socket: (typeof FakeWebSocket.instances)[number]) =>
    socket.sent.map(m => JSON.parse(m)).filter(m => m.cmd === 'led')

  it('streams beat-synced LED frames, not just one colour per tick', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(1000)
    const frames = ledFrames(socket)
    expect(tc.partyMode.value).toBe(true)
    expect(frames.length).toBeGreaterThan(5)
    // pulsing: brightest and dimmest frames differ substantially
    const levels = frames.map(f => Math.max(f.r, f.g, f.b))
    expect(Math.max(...levels)).toBeGreaterThan(Math.min(...levels) * 3)
  })

  it('never sends two identical frames in a row', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(3000)
    const frames = ledFrames(socket).map(f => `${f.r},${f.g},${f.b}`)
    frames.slice(1).forEach((f, i) => expect(f).not.toBe(frames[i]))
  })

  it('stops streaming and resumes the status LED when toggled off', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(500)
    tc.togglePartyMode()
    const sentAtStop = socket.sent.length
    expect(socket.lastSent()).toEqual({ cmd: 'led_auto' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.sent.length).toBe(sentAtStop)
    expect(tc.partyMode.value).toBe(false)
  })

  it('opening the LED test panel kills party mode', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(200)
    tc.toggleLedTest()
    const sentAfter = socket.sent.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.partyMode.value).toBe(false)
    expect(socket.sent.length).toBe(sentAfter)
  })

  it('respects dim brightness', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.toggleBright() // -> dim
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(2000)
    const peak = Math.max(...ledFrames(socket).flatMap(f => [f.r, f.g, f.b]))
    expect(peak).toBeLessThanOrEqual(250)
  })
})

describe('optional status LED', () => {
  const status = (features?: { led?: boolean }) => ({ type: 'status', speed: 0, direction: true, connected: true, ...(features ? { features } : {}) })
  const ledMessages = (socket: (typeof FakeWebSocket.instances)[number]) =>
    socket.sent.map(m => JSON.parse(m)).filter(m => m.cmd === 'led' || m.cmd === 'led_auto')

  it('assumes an LED when the controller says nothing (older firmware)', () => {
    const socket = FakeWebSocket.instances[0]
    expect(tc.hasLed.value).toBe(true)
    socket.simulateMessage(status())
    expect(tc.hasLed.value).toBe(true)
    tc.toggleLedTest()
    expect(tc.ledTestMode.value).toBe(true)
  })

  it('knows when the controller reports an LED', () => {
    FakeWebSocket.instances[0].simulateMessage(status({ led: true }))
    expect(tc.hasLed.value).toBe(true)
  })

  it('with no LED fitted, LED test and party mode do nothing and send nothing', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(status({ led: false }))
    expect(tc.hasLed.value).toBe(false)
    tc.toggleLedTest()
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.ledTestMode.value).toBe(false)
    expect(tc.partyMode.value).toBe(false)
    expect(ledMessages(socket)).toEqual([])
  })

  it('the debug panel drops the LED rows and says the LED is not fitted', () => {
    FakeWebSocket.instances[0].simulateMessage(status({ led: false }))
    expect(() => getDebugValue('LED Test Mode')).toThrow()
    expect(() => getDebugValue('Party Mode')).toThrow()
    expect(getDebugValue('Status LED')).toBe('not fitted')
  })

  it('party mode stops if the controller turns out to have no LED', async () => {
    const socket = FakeWebSocket.instances[0]
    tc.togglePartyMode()
    await vi.advanceTimersByTimeAsync(300)
    expect(tc.partyMode.value).toBe(true)
    socket.simulateMessage(status({ led: false }))
    const after = socket.sent.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(tc.partyMode.value).toBe(false)
    expect(socket.sent.length).toBe(after)
  })
})

describe('beam sensor add-on', () => {
  const status = (extra: object) => ({ type: 'status', speed: 0, direction: true, connected: true, ...extra })

  it('has no sensor until the controller reports one', () => {
    const socket = FakeWebSocket.instances[0]
    expect(tc.hasSensor.value).toBe(false)
    socket.simulateMessage(status({ features: { led: true, sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false } }))
    expect(tc.hasSensor.value).toBe(true)
    expect(tc.beam.value?.state).toBe('clear')
    socket.simulateMessage(status({ features: { led: true, sensor: false }, beam: null }))
    expect(tc.hasSensor.value).toBe(false)
    expect(tc.beam.value).toBeNull()
  })

  it('keeps the level live from heartbeats and marks a lost sensor', () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false } }))
    socket.simulateMessage({ type: 'beam', event: 'heartbeat', state: 'blocked', level: 231, calibrated: true })
    expect(tc.beam.value?.level).toBe(231)
    expect(tc.beam.value?.state).toBe('blocked')
    socket.simulateMessage({ type: 'beam', event: 'lost' })
    expect(tc.beam.value?.state).toBe('lost')
  })

  it('sends beam_calibrate and follows the calibration phases', () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: false, calibrating: false } }))
    tc.calibrateSensor()
    expect(socket.lastSent()).toEqual({ cmd: 'beam_calibrate' })
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'creeping', detail: '' })
    expect(tc.calibration.value).toEqual({ phase: 'creeping', detail: '' })
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'done', detail: 'clear 747, blocked 235' })
    expect(tc.calibration.value?.phase).toBe('done')
  })

  it('a calibration status from the controller does not trigger the throttle ramp', async () => {
    const socket = FakeWebSocket.instances[0]
    const before = socket.sent.length
    socket.simulateMessage(status({ speed: 0.1, features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: true } }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(socket.sent.slice(before).map(m => JSON.parse(m)).filter(m => m.cmd === 'speed')).toEqual([])
  })

  it('drops a running phase the browser missed the end of, once status says nothing is running', () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: true } }))
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'creeping', detail: '' })
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false } }))
    expect(tc.calibration.value).toBeNull()
  })

  it('keeps a finished result when the status catches up', () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'done', detail: 'clear 747, blocked 235' })
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false } }))
    expect(tc.calibration.value?.phase).toBe('done')
  })

  it('gives up on a request nobody answered', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false } }))
    tc.calibrateSensor()
    expect(tc.calibration.value?.phase).toBe('starting')
    await vi.advanceTimersByTimeAsync(5000)
    expect(tc.calibration.value).toBeNull()
  })

  it('forgets calibration progress across a reconnect', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'creeping', detail: '' })
    socket.simulateClose()
    await vi.advanceTimersByTimeAsync(10000)
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1].simulateOpen()
    expect(tc.calibration.value).toBeNull()
  })
})


describe('parking', () => {
  const status = (extra: object) => ({ type: 'status', speed: 0, direction: true, connected: true, ...extra })
  const sensorStatus = (beam: object = {}) => status({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false, parked: null, ...beam } })
  const creeps = (socket: FakeWebSocket) => socket.sent.map(m => JSON.parse(m)).filter(m => m.cmd === 'creep')

  it('sends creeps with rising ids and resolves on the matching end', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus())
    const done = tc.parkLoco('nose')
    await vi.advanceTimersByTimeAsync(0)
    const first = creeps(socket)[0]
    expect(first).toMatchObject({ cmd: 'creep', forward: true, until: ['break'], maxMs: 5000, afterMs: 0 })
    expect(tc.parking.value).toMatchObject({ target: 'nose', running: true, step: 'Just short? Creeping forward' })
    socket.simulateMessage({ type: 'creep', id: first.id, phase: 'running' })
    socket.simulateMessage({ type: 'creep', id: first.id + 99, phase: 'ended', result: 'event', detail: '', parked: 'nose' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tc.parking.value?.running).toBe(true)
    socket.simulateMessage({ type: 'creep', id: first.id, phase: 'ended', result: 'event', detail: '', parked: 'nose' })
    await done
    expect(tc.parking.value).toMatchObject({ running: false, ok: true, detail: 'Parked on nose' })
  })

  it('a refusal ends the search with its reason', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus())
    const done = tc.parkLoco('nose')
    await vi.advanceTimersByTimeAsync(0)
    socket.simulateMessage({ type: 'creep', id: creeps(socket)[0].id, phase: 'refused', detail: 'stop the train first' })
    await done
    expect(tc.parking.value).toMatchObject({ running: false, ok: false, detail: 'stop the train first' })
  })

  it('a dropped connection ends the search', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus())
    const done = tc.parkLoco('nose')
    await vi.advanceTimersByTimeAsync(0)
    socket.simulateClose()
    await done
    expect(tc.parking.value).toMatchObject({ running: false, ok: false, detail: 'connection lost' })
  })

  it('emergency stop cancels the search and sends no more creeps', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus())
    const done = tc.parkLoco('nose')
    await vi.advanceTimersByTimeAsync(0)
    const id = creeps(socket)[0].id
    tc.emergencyStop()
    expect(socket.lastSent()).toEqual({ cmd: 'stop' })
    socket.simulateMessage({ type: 'creep', id, phase: 'ended', result: 'timeout', detail: '', parked: null })
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(creeps(socket).length).toBe(1)
    expect(tc.parking.value).toMatchObject({ running: false, ok: false, detail: 'stopped' })
  })

  it('a creep that ended on its event sets the beam state before any status arrives', async () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus())
    const done = tc.parkLoco('nose')
    await vi.advanceTimersByTimeAsync(0)
    socket.simulateMessage({ type: 'creep', id: creeps(socket)[0].id, phase: 'ended', result: 'event', detail: '', parked: 'nose' })
    await done
    expect(tc.beam.value?.state).toBe('blocked')
  })

  it('status carries where the loco is parked', () => {
    const socket = FakeWebSocket.instances[0]
    socket.simulateMessage(sensorStatus({ state: 'blocked', parked: 'tail' }))
    expect(tc.beam.value?.parked).toBe('tail')
  })
})
