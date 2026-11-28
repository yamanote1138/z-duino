import { park, type CreepResult, type CreepUntil, type ParkDeps, type ParkTarget } from './parkSearch'
import { runShow } from './show'
import { BeamFeed, makeController, makeSoundPlayer, type BeamMsg } from './showHost'
import { measureLoco, type LocoProfile } from './measureLoco'
import { runShowEngine, soundsUsed } from './macShow'
import jrLap from '../shows/jr-lap.json'
import { computed, ref } from 'vue'
import { createPartyBeat } from './partyBeat'

// WebSocket protocol types
interface OutgoingSpeed { cmd: 'speed'; value: number }
interface OutgoingDirection { cmd: 'direction'; value: boolean }
interface OutgoingStop { cmd: 'stop' }
interface OutgoingPing { cmd: 'ping' }
interface OutgoingInvert { cmd: 'invert'; value: boolean }
interface OutgoingLed { cmd: 'led'; r: number; g: number; b: number }
interface OutgoingLedAuto { cmd: 'led_auto' }
interface OutgoingBeamCalibrate { cmd: 'beam_calibrate' }

type OutgoingMessage =
  | OutgoingSpeed
  | OutgoingDirection
  | OutgoingStop
  | OutgoingPing
  | OutgoingInvert
  | OutgoingLed
  | OutgoingLedAuto
  | OutgoingBeamCalibrate
  | OutgoingCreep

interface OutgoingCreep { cmd: 'creep'; forward: boolean; until: CreepUntil[]; maxMs: number; afterMs: number; id: number }

interface StatusMessage {
  type: 'status'
  name?: string
  speed: number
  direction: boolean
  connected: boolean
  // Hardware this controller has fitted. Older firmware sends no "features": treat that as everything present.
  features?: { led?: boolean; sensor?: boolean }
  // The beam sensor add-on's latest state; null or absent when no sensor is connected
  beam?: BeamStatus | null
}

export interface BeamStatus {
  state: string        // clear | blocked | uncalibrated | lost
  level: number
  calibrated: boolean
  calibrating: boolean
  parked?: ParkTarget | null
}

export interface ParkingProgress {
  target: ParkTarget
  step: string
  running: boolean
  ok?: boolean
  detail?: string
}

interface CreepMessage {
  type: 'creep'
  id: number
  phase: 'running' | 'ended' | 'refused'
  result?: 'event' | 'timeout' | 'aborted'
  detail?: string
  parked?: ParkTarget | null
}

export interface CalibrationProgress {
  phase: string        // measuring | creeping | measuring_second | done | failed
  detail: string
}

interface BeamMessage {
  type: 'beam'
  event: string
  state?: string
  level?: number
  calibrated?: boolean
  phase?: string
  detail?: string
}

interface PongMessage {
  type: 'pong'
}

type IncomingMessage = StatusMessage | PongMessage | BeamMessage

export interface LedColor {
  name: string
  r: number
  g: number
  b: number
  css: string
  text: string
}

// Constants
const RAMP_INTERVAL = 100
const RAMP_TIME_PER_SEGMENT = 1000
const DIRECTION_PAUSE = 500
const RECONNECT_BASE = 1000
const RECONNECT_MAX = 30000
const PING_INTERVAL = 10000
const PARTY_FRAME_INTERVAL = 50 // ~20 fps of LED updates over the WebSocket
const SUPPLY_VOLTAGE = 12
const TRACK_VOLTAGE_DANGER_THRESHOLD = 10

export const powerLevels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

export const ledColors: LedColor[] = [
  { name: 'Red',     r: 1000, g: 0,    b: 0,    css: '#dc3545', text: '#fff' },
  { name: 'Green',   r: 0,    g: 1000, b: 0,    css: '#198754', text: '#fff' },
  { name: 'Blue',    r: 0,    g: 0,    b: 1000, css: '#0d6efd', text: '#fff' },
  { name: 'Yellow',  r: 1000, g: 1000, b: 0,    css: '#ffc107', text: '#000' },
  { name: 'Cyan',    r: 0,    g: 1000, b: 1000, css: '#0dcaf0', text: '#000' },
  { name: 'Magenta', r: 1000, g: 0,    b: 1000, css: '#d63384', text: '#fff' },
  { name: 'White',   r: 1000, g: 1000, b: 1000, css: '#f8f9fa', text: '#000' },
  { name: 'Off',     r: 0,    g: 0,    b: 0,    css: '#212529', text: '#6c757d' }
]

// ── Singleton state (module-scoped, shared across all consumers) ──

const socket = ref<WebSocket | null>(null)
const connected = ref(false)
const railroadName = ref('Z-Duino')
const currentSpeed = ref(0.0)
const currentDirection = ref(true)
const stopFlag = ref(false)
const directionInverted = ref(localStorage.getItem('directionInverted') === 'true')
const ledTestMode = ref(false)
const ledBright = ref(true)
const activeLedColor = ref<string | null>(null)
const partyMode = ref(false)
const hasSensor = ref(false)
const beam = ref<BeamStatus | null>(null)
const calibration = ref<CalibrationProgress | null>(null)
const parking = ref<ParkingProgress | null>(null)
const show = ref<{ name: string; step: string; running: boolean; ok?: boolean; detail?: string } | null>(null)
const measuring = ref<{ step: string; running: boolean; ok?: boolean; detail?: string } | null>(null)
const LOCO_KEY = 'z-duino.loco'
function loadProfile(): LocoProfile | null {
  try { const p = JSON.parse(localStorage.getItem(LOCO_KEY) ?? 'null'); return p?.method === 'laps' ? p : null } catch { return null }   // older pass-timed profiles were unreliable
}
const locoProfile = ref<LocoProfile | null>(loadProfile())
const hasLed = ref(true) // the status LED is optional hardware; the controller says whether it is fitted

const trackVoltage = computed(() => SUPPLY_VOLTAGE * currentSpeed.value)
const trackVoltageDanger = computed(() => trackVoltage.value > TRACK_VOLTAGE_DANGER_THRESHOLD)

let rampTimer: ReturnType<typeof setInterval> | null = null
let partyTimer: ReturnType<typeof setInterval> | null = null
let lastPartyFrame = ''
let reconnectDelay = RECONNECT_BASE
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null

// ── WebSocket ──

function send(obj: OutgoingMessage) {
  if (socket.value && socket.value.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(obj)
    console.log('TX:', json)
    socket.value.send(json)
  } else {
    console.warn('TX failed (not connected):', obj)
  }
}

function startPing() {
  stopPing()
  pingTimer = setInterval(() => {
    send({ cmd: 'ping' })
  }, PING_INTERVAL)
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX)
}

function connect() {
  if (socket.value && socket.value.readyState <= 1) return

  const host = location.hostname || 'localhost'
  socket.value = new WebSocket(`ws://${host}:81/`, ['arduino'])

  socket.value.onopen = () => {
    connected.value = true
    calibration.value = null   // progress from before the drop is stale; status and events will say what's going on
    reconnectDelay = RECONNECT_BASE
    startPing()
    if (directionInverted.value) {
      send({ cmd: 'invert', value: true })
    }
  }

  socket.value.onclose = () => {
    connected.value = false
    endPendingCreeps('connection lost')
    endBeamWaits()
    showAbort?.abort()
    stopPing()
    scheduleReconnect()
  }

  socket.value.onerror = () => {
    socket.value?.close()
  }

  socket.value.onmessage = (event: MessageEvent) => {
    try {
      const msg: IncomingMessage = JSON.parse(event.data)
      console.log('RX:', msg)
      if (msg.type === 'status') {
        if (msg.name) {
          railroadName.value = msg.name
          document.title = msg.name
        }
        currentSpeed.value = msg.speed
        currentDirection.value = msg.direction
        hasLed.value = msg.features?.led !== false
        hasSensor.value = msg.features?.sensor === true
        beam.value = hasSensor.value && msg.beam ? { ...msg.beam } : null
        // We may have missed the end of a run (screen locked, WiFi blip): trust the controller's word that none is going
        if (!beam.value?.calibrating && calibration.value && CALIBRATION_RUNNING.includes(calibration.value.phase)) calibration.value = null
        if (!hasLed.value && (ledTestMode.value || partyMode.value)) {
          // The LED vanished under us (re-flashed without one): drop out of LED test and party mode
          stopParty()
          ledTestMode.value = false
          activeLedColor.value = null
        }
      }
      if (msg.type === 'beam') handleBeam(msg)
      if (msg.type === 'creep') handleCreep(msg)
    } catch (e) {
      // ignore malformed messages
    }
  }
}

// ── Beam sensor ──

const CALIBRATION_RUNNING = ['measuring', 'creeping', 'measuring_second']
const CALIBRATION_ANSWER_MS = 5000
let calibrationRequestTimer: ReturnType<typeof setTimeout> | null = null

function handleBeam(msg: BeamMessage) {
  if (msg.event === 'calibration') {
    if (calibrationRequestTimer) { clearTimeout(calibrationRequestTimer); calibrationRequestTimer = null }
    calibration.value = { phase: msg.phase ?? '', detail: msg.detail ?? '' }
    return
  }
  if (!beam.value) return
  if (msg.event === 'heartbeat') {
    beam.value = { ...beam.value, state: msg.state ?? beam.value.state, level: msg.level ?? beam.value.level, calibrated: msg.calibrated ?? beam.value.calibrated }
  } else if (msg.event === 'lost') {
    beamFeed.emit(msg as BeamMsg)
    beam.value = { ...beam.value, state: 'lost' }
  } else if (msg.event === 'break' || msg.event === 'restore') {
    beam.value = { ...beam.value, state: msg.event === 'break' ? 'blocked' : 'clear' }
    for (const w of [...beamWaits]) if (w.event === msg.event) w.done(msg as BeamMsg)
  }
  if (msg.event === 'break' || msg.event === 'restore' || msg.event === 'pass') {
    beamFeed.emit(msg as BeamMsg)
  }
}

function calibrateSensor() {
  calibration.value = { phase: 'starting', detail: '' }
  send({ cmd: 'beam_calibrate' })
  if (calibrationRequestTimer) clearTimeout(calibrationRequestTimer)
  calibrationRequestTimer = setTimeout(() => {   // no answer: older firmware, or the request was lost
    calibrationRequestTimer = null
    if (calibration.value?.phase === 'starting') calibration.value = null
  }, CALIBRATION_ANSWER_MS)
}

// ── Parking: guarded creeps strung together by parkSearch ──

let creepId = 0
let parkCancelled = false
const pendingCreeps = new Map<number, (r: CreepResult) => void>()

function handleCreep(msg: CreepMessage) {
  if (msg.phase === 'running') return
  const resolve = pendingCreeps.get(msg.id)
  if (!resolve) return
  pendingCreeps.delete(msg.id)
  resolve({ result: msg.phase === 'refused' ? 'refused' : (msg.result ?? 'aborted'), detail: msg.detail ?? '', parked: msg.parked ?? null })
}

function endPendingCreeps(detail: string) {
  for (const resolve of pendingCreeps.values()) resolve({ result: 'aborted', detail, parked: null })
  pendingCreeps.clear()
}

function creep(forward: boolean, until: CreepUntil[], maxMs: number, afterMs = 0): Promise<CreepResult> {
  if (!connected.value) return Promise.resolve({ result: 'aborted', detail: 'connection lost', parked: null })
  const id = ++creepId
  return new Promise((resolve) => {
    pendingCreeps.set(id, (r) => {
      // the controller sends the end before the status, so set the state the stop proves: the last event's
      if (r.result === 'event' && beam.value) beam.value = { ...beam.value, state: until[until.length - 1] === 'break' ? 'blocked' : 'clear', parked: r.parked }
      resolve(r)
    })
    send({ cmd: 'creep', forward, until, maxMs, afterMs, id })
  })
}

function parkDeps(onStep: (step: string) => void): ParkDeps {
  return {
    creep,
    pause: (ms) => new Promise((res) => setTimeout(res, ms)),
    beamState: () => beam.value?.state ?? '',
    parked: () => beam.value?.parked ?? null,
    cancelled: () => parkCancelled,
    onStep,
  }
}

async function parkLoco(target: ParkTarget): Promise<void> {
  if (anyRunning()) return
  parkCancelled = false
  parking.value = { target, step: '', running: true }
  const r = await park(target, parkDeps((step) => { if (parking.value) parking.value = { ...parking.value, step } }))
  parking.value = { target, step: '', running: false, ok: r.ok, detail: r.detail }
}

// ── Shows: beam waits and sound ──

const beamWaits = new Set<{ event: string; done: (m: BeamMsg | null) => void }>()

// The next beam event of this kind, or null on timeout, Stop or a dropped connection
function waitBeamEvent(event: 'break' | 'restore', maxMs: number): Promise<BeamMsg | null> {
  return new Promise((resolve) => {
    const w = { event, done: (m: BeamMsg | null) => { clearTimeout(timer); beamWaits.delete(w); resolve(m) } }
    const timer = setTimeout(() => w.done(null), maxMs)
    beamWaits.add(w)
  })
}

async function waitBeam(event: 'break' | 'restore', maxMs: number): Promise<boolean> {
  return (await waitBeamEvent(event, maxMs)) !== null
}

function endBeamWaits() {
  for (const w of [...beamWaits]) w.done(null)
}

const beamFeed = new BeamFeed({ state: () => beam.value?.state ?? '', level: () => beam.value?.level ?? 0 })
let showAbort: AbortController | null = null
const LAYOUT = { loopIn: 134, zones: {} }
const anyRunning = () => !!(parking.value?.running || show.value?.running || measuring.value?.running)

function controllerDeps() {
  return {
    speed: () => currentSpeed.value,
    forward: () => currentDirection.value,
    connected: () => connected.value,
    hasLed: () => hasLed.value,
    send: (m: object) => send(m as OutgoingMessage),
    setDirection: (forward: boolean) => { currentDirection.value = forward; send({ cmd: 'direction', value: forward }) },
    rampTo,
    setSpeedNow: (v: number) => {
      if (rampTimer) { clearInterval(rampTimer); rampTimer = null }
      currentSpeed.value = v; send({ cmd: 'speed', value: v })
    },
    emergencyStop,
    creep,
  }
}

async function startJrLap(): Promise<void> {
  if (anyRunning()) return
  const name = 'JR lap'
  const loco = locoProfile.value
  if (!loco) { show.value = { name, step: '', running: false, ok: false, detail: 'measure the loco first' }; return }
  parkCancelled = false
  parking.value = null
  const ctx = new AudioContext()   // made inside the click so the browser lets it play
  show.value = { name, step: 'Loading sounds', running: true }
  const onStep = (step: string) => { if (show.value) show.value = { ...show.value, step } }
  try {
    const res = await fetch('/sounds/jr/pack.json')
    if (!res.ok) throw new Error('no show sounds on the controller: run frontend/scripts/import-sounds.sh and flash the app')
    const sound = makeSoundPlayer(ctx, await res.json(), '/sounds/jr/')
    await sound.load(soundsUsed(jrLap))
    if (parkCancelled) throw new Error('stopped')
    const p = await park('nose', parkDeps(onStep))
    if (!p.ok) throw new Error(p.detail)
    if (parkCancelled) throw new Error('stopped')
    showAbort = new AbortController()
    await runShowEngine(jrLap, { controller: makeController(controllerDeps()), sensor: beamFeed, sound, layout: LAYOUT, loco, signal: showAbort.signal, onLog: (e: { text: string }) => onStep(e.text) })
    show.value = { name, step: '', running: false, ok: true, detail: 'Show done' }
  } catch (e) {
    show.value = { name, step: '', running: false, ok: false, detail: parkCancelled ? 'stopped' : (e as Error).message }
  } finally {
    showAbort = null
    ctx.close().catch(() => {})
  }
}

async function startMeasure(): Promise<void> {
  if (anyRunning()) return
  parkCancelled = false
  parking.value = null
  measuring.value = { step: 'Parking on nose', running: true }
  const onStep = (step: string) => { if (measuring.value) measuring.value = { ...measuring.value, step } }
  const p = await park('nose', parkDeps(onStep))
  if (!p.ok || parkCancelled) { measuring.value = { step: '', running: false, ok: false, detail: parkCancelled ? 'stopped' : p.detail }; return }
  const r = await measureLoco({
    rampTo: (s) => { const ramp = rampTo(s); return s === 0 ? ramp : Promise.resolve() },   // listen for the beam while it ramps
    waitBeam: waitBeamEvent,
    cancelled: () => parkCancelled,
    onStep,
  })
  if (r.ok && r.profile) {
    locoProfile.value = r.profile
    try { localStorage.setItem(LOCO_KEY, JSON.stringify(r.profile)) } catch { /* kept for this visit only */ }
  }
  measuring.value = { step: '', running: false, ok: r.ok, detail: r.detail }
}

function playSound(url: string, capMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(done, capMs)
    try {
      const a = new Audio(url)
      a.onended = done; a.onerror = done
      a.play()?.catch(done)
    } catch { done() }
  })
}

async function startShow(): Promise<void> {
  if (anyRunning()) return
  parkCancelled = false
  parking.value = null
  show.value = { name: 'Horn show', step: '', running: true }
  const onStep = (step: string) => { if (show.value) show.value = { ...show.value, step } }
  const r = await runShow({
    park: (t, o) => park(t, parkDeps(onStep), o),
    horn: () => playSound('/sounds/horn.wav'),
    rampTo,
    setDirection: (forward) => { currentDirection.value = forward; send({ cmd: 'direction', value: forward }) },
    waitBeam,
    pause: (ms) => new Promise((res) => setTimeout(res, ms)),
    cancelled: () => parkCancelled,
    onStep,
  })
  show.value = { name: 'Horn show', step: '', running: false, ok: r.ok, detail: r.detail }
}

// ── Speed control ──

function getSegmentClass(index: number): string {
  const level = powerLevels[index]
  if (currentSpeed.value >= level) {
    if (index <= 2) return 'bg-red-500 text-white'
    if (index <= 6) return 'bg-yellow-500 text-black'
    return 'bg-green-500 text-white'
  }
  return 'bg-neutral-700 text-neutral-400 opacity-50'
}

function setSpeed(level: number) {
  // Already steady at this level: nothing to do. (Mid-ramp we still ramp, so a click
  // on the level being passed through pins the train there instead of being ignored.)
  // currentSpeed is rounded to 3 decimals while ramping, so compare with a tolerance.
  if (rampTimer === null && Math.abs(currentSpeed.value - level) < 0.0005) return
  rampTo(level)
}

function rampTo(targetSpeed: number, durationMs?: number): Promise<void> {
  return new Promise(resolve => {
    stopFlag.value = false
    if (rampTimer) {
      clearInterval(rampTimer)
      rampTimer = null
    }

    const startSpeed = currentSpeed.value
    const distance = Math.abs(targetSpeed - startSpeed)
    const segmentsCrossed = Math.round(distance / 0.1)
    const duration = durationMs ?? Math.max(segmentsCrossed * RAMP_TIME_PER_SEGMENT, 200)
    const totalSteps = Math.max(Math.ceil(duration / RAMP_INTERVAL), 5)

    let step = 0

    rampTimer = setInterval(() => {
      if (stopFlag.value) {
        clearInterval(rampTimer!)
        rampTimer = null
        resolve()
        return
      }

      step++
      const progress = Math.min(step / totalSteps, 1.0)
      const speed = startSpeed + (targetSpeed - startSpeed) * progress

      currentSpeed.value = Math.round(speed * 1000) / 1000
      send({ cmd: 'speed', value: currentSpeed.value })

      if (step >= totalSteps) {
        clearInterval(rampTimer!)
        rampTimer = null
        currentSpeed.value = targetSpeed
        send({ cmd: 'speed', value: currentSpeed.value })
        resolve()
      }
    }, RAMP_INTERVAL)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function toggleDirection() {
  if (currentSpeed.value === 0) {
    currentDirection.value = !currentDirection.value
    send({ cmd: 'direction', value: currentDirection.value })
  } else {
    const previousSpeed = currentSpeed.value
    await rampTo(0)

    await sleep(DIRECTION_PAUSE)

    currentDirection.value = !currentDirection.value
    send({ cmd: 'direction', value: currentDirection.value })

    await sleep(100)
    rampTo(previousSpeed)
  }
}

function brake() {
  rampTo(0)
}

function emergencyStop() {
  stopFlag.value = true
  parkCancelled = true
  showAbort?.abort()
  endBeamWaits()
  if (rampTimer) {
    clearInterval(rampTimer)
    rampTimer = null
  }
  currentSpeed.value = 0
  send({ cmd: 'stop' })
}

// ── Direction invert ──

function toggleInvert() {
  directionInverted.value = !directionInverted.value
  localStorage.setItem('directionInverted', String(directionInverted.value))
  send({ cmd: 'invert', value: directionInverted.value })
  console.log('Direction inverted:', directionInverted.value)
}

// ── LED test panel ──

function toggleLedTest() {
  if (!hasLed.value) return // no LED fitted: nothing to test
  // Kill party mode if active
  if (partyMode.value) stopParty()
  ledTestMode.value = !ledTestMode.value
  console.log('LED test mode:', ledTestMode.value ? 'ON' : 'OFF')
  if (!ledTestMode.value) {
    activeLedColor.value = null
    send({ cmd: 'led_auto' })
  }
}

function setLed(color: LedColor) {
  activeLedColor.value = color.name
  sendLed(color)
}

function toggleBright() {
  ledBright.value = !ledBright.value
  console.log('Brightness:', ledBright.value ? 'BRIGHT' : 'DIM')
  if (activeLedColor.value) {
    const color = ledColors.find(c => c.name === activeLedColor.value)
    if (color) sendLed(color)
  }
}

function ledPayload(r: number, g: number, b: number): OutgoingLed {
  const scale = ledBright.value ? 1.0 : 0.25
  return { cmd: 'led', r: Math.round(r * scale), g: Math.round(g * scale), b: Math.round(b * scale) }
}

function sendLed(color: LedColor) {
  const payload = ledPayload(color.r, color.g, color.b)
  console.log(`LED: ${color.name} (${ledBright.value ? 'bright' : 'dim'}) →`, payload)
  send(payload)
}

// ── Party mode ──
// Techno-style light show: kick pulses, off-beat hats, colour change per bar.
// The beat logic lives in partyBeat.ts; here we just drive it on a timer.

const partyColors = ledColors.filter(c => c.name !== 'Off')

function stopParty() {
  partyMode.value = false
  if (partyTimer) {
    clearInterval(partyTimer)
    partyTimer = null
  }
}

function startParty() {
  const beat = createPartyBeat({ colors: partyColors })
  const startedAt = Date.now()
  lastPartyFrame = ''
  partyTimer = setInterval(() => {
    if (!connected.value) return
    const { r, g, b } = beat.frame(Date.now() - startedAt)
    const payload = ledPayload(r, g, b)
    const key = `${payload.r},${payload.g},${payload.b}`
    if (key === lastPartyFrame) return // don't spam the ESP8266 with identical frames
    lastPartyFrame = key
    send(payload)
  }, PARTY_FRAME_INTERVAL)
}

function togglePartyMode() {
  if (!hasLed.value) return // no LED fitted: nothing to party with
  partyMode.value = !partyMode.value
  if (partyMode.value) {
    activeLedColor.value = null
    startParty()
  } else {
    stopParty()
    activeLedColor.value = null
    ledTestMode.value = false
    send({ cmd: 'led_auto' })
  }
}

// ── Debug ──

const WS_READY_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const

function getDebugInfo(): { label: string; value: string; danger?: boolean }[] {
  const wsUrl = socket.value ? socket.value.url : `ws://${location.hostname || 'localhost'}:81/`
  const wsState = socket.value ? WS_READY_STATES[socket.value.readyState] : 'N/A'

  return [
    { label: 'App Version', value: __APP_VERSION__ },
    { label: 'Railroad Name', value: railroadName.value },
    { label: 'Connected', value: String(connected.value) },
    { label: 'WebSocket URL', value: wsUrl },
    { label: 'WebSocket State', value: wsState },
    { label: 'Reconnect Delay', value: `${reconnectDelay}ms` },
    { label: 'Current Speed', value: currentSpeed.value === 0 ? 'stopped' : `${Math.round(currentSpeed.value * 100)}%` },
    { label: 'Supply Voltage', value: `${SUPPLY_VOLTAGE}V` },
    { label: 'Track Voltage', value: `${trackVoltage.value.toFixed(1)}V`, danger: trackVoltageDanger.value },
    { label: 'Direction', value: currentDirection.value ? 'FWD' : 'REV' },
    { label: 'Direction Inverted', value: String(directionInverted.value) },
    { label: 'Ramping', value: String(rampTimer !== null) },
    ...(hasLed.value
      ? [
          { label: 'LED Test Mode', value: String(ledTestMode.value) },
          { label: 'Party Mode', value: String(partyMode.value) },
          { label: 'LED Brightness', value: ledBright.value ? 'Bright' : 'Dim' },
          { label: 'Active LED Color', value: activeLedColor.value ?? 'none' },
        ]
      : [{ label: 'Status LED', value: 'not fitted' }]),
    { label: 'Ping Interval', value: `${PING_INTERVAL}ms` },
    { label: 'Ping Active', value: String(pingTimer !== null) },
    { label: 'Hostname', value: location.hostname || 'localhost' },
    { label: 'User Agent', value: navigator.userAgent },
    { label: 'Screen', value: `${screen.width}×${screen.height} @ ${devicePixelRatio}x` },
    { label: 'Viewport', value: `${window.innerWidth}×${window.innerHeight}` },
  ]
}

// ── Connect on module load ──

connect()

// ── Public API ──

export function useTrainController() {
  return {
    connected,
    railroadName,
    currentSpeed,
    currentDirection,
    directionInverted,
    trackVoltage,
    trackVoltageDanger,
    ledTestMode,
    ledBright,
    activeLedColor,
    hasLed,

    hasSensor,
    beam,
    calibration,
    calibrateSensor,
    parking,
    parkLoco,
    show,
    startShow,
    startJrLap,
    measuring,
    startMeasure,
    locoProfile,

    getSegmentClass,
    setSpeed,
    toggleDirection,
    brake,
    emergencyStop,

    toggleInvert,

    toggleLedTest,
    setLed,
    toggleBright,

    partyMode,
    togglePartyMode,

    getDebugInfo
  }
}
