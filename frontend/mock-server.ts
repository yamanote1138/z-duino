import { WebSocketServer, WebSocket } from 'ws'

interface TrainState {
  speed: number
  direction: boolean
}

interface SpeedCommand { cmd: 'speed'; value: number }
interface DirectionCommand { cmd: 'direction'; value: boolean }
interface StopCommand { cmd: 'stop' }
interface InvertCommand { cmd: 'invert'; value: boolean }
interface LedCommand { cmd: 'led'; r: number; g: number; b: number }
interface LedAutoCommand { cmd: 'led_auto' }
interface PingCommand { cmd: 'ping' }
interface BeamCalibrateCommand { cmd: 'beam_calibrate' }
interface CreepCommand { cmd: 'creep'; forward: boolean; until: string[]; maxMs: number; afterMs?: number; id?: number }

type IncomingCommand =
  | SpeedCommand
  | DirectionCommand
  | StopCommand
  | InvertCommand
  | LedCommand
  | LedAutoCommand
  | PingCommand
  | BeamCalibrateCommand
  | CreepCommand

const PORT = 81
const RAILROAD_NAME = 'Mock Railroad Co.'
const HAS_LED = process.env.MOCK_LED !== '0' // MOCK_LED=0 npm run mock: act like a controller built without the status LED
const HAS_SENSOR = process.env.MOCK_SENSOR !== '0' // MOCK_SENSOR=0 npm run mock: act like a controller with no beam sensor
const wss = new WebSocketServer({ port: PORT })

// A pretend beam sensor: a level that dips now and then, and a calibration that walks through its phases
const beam = { state: 'clear', level: 748, calibrated: true, calibrating: false, parked: null as 'nose' | 'tail' | null }
let calTimers: ReturnType<typeof setTimeout>[] = []

function broadcast(obj: object) {
  const json = JSON.stringify(obj)
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json) })
}

function broadcastStatus() {
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) sendStatus(c) })
}

function endCalibration(phase: 'done' | 'failed', detail: string) {
  calTimers.forEach(clearTimeout); calTimers = []
  beam.calibrating = false
  state.speed = 0
  if (phase === 'done') beam.calibrated = true
  broadcast({ type: 'beam', event: 'calibration', phase, detail })
  broadcastStatus()
}

function startCalibration(ws: WebSocket) {
  const refuse = !HAS_SENSOR ? 'no sensor connected' : beam.calibrating ? 'already calibrating' : state.speed > 0 ? 'stop the train first' : ''
  if (refuse) { ws.send(JSON.stringify({ type: 'beam', event: 'calibration', phase: 'failed', detail: refuse })); return }
  beam.calibrating = true
  const step = (ms: number, fn: () => void) => calTimers.push(setTimeout(fn, ms))
  broadcast({ type: 'beam', event: 'calibration', phase: 'measuring', detail: '' }); broadcastStatus()
  step(3000, () => { state.speed = 0.1; state.direction = true; broadcast({ type: 'beam', event: 'calibration', phase: 'creeping', detail: '' }); broadcastStatus() })
  step(5500, () => { state.speed = 0; broadcast({ type: 'beam', event: 'calibration', phase: 'measuring_second', detail: '' }); broadcastStatus() })
  step(9000, () => endCalibration('done', 'clear 748, blocked 235'))
}

// A pretend loco on a loop: the nose at `nose` inches, the body trailing behind it, the beam at 0
const LOOP_IN = 134, LOCO_IN = 3, IN_PER_S_AT_FULL = 23.5, CREEP_SPEED = 0.15
let nose = LOOP_IN - 20   // 20 in short of the beam
const wrap = (x: number) => ((x % LOOP_IN) + LOOP_IN) % LOOP_IN
const inBeam = () => wrap(nose) < LOCO_IN   // the body covers the 3 in behind the nose

interface Creep { id: number; forward: boolean; until: string[]; seen: number; maxMs: number; afterMs: number; start: number; doneAt: number | null }
let creep: Creep | null = null

function endCreep(result: 'event' | 'timeout' | 'aborted', detail = '') {
  if (!creep) return
  const c = creep; creep = null
  state.speed = 0
  if (result === 'event' && c.afterMs === 0) {
    const isBreak = c.until[c.until.length - 1] === 'break'
    beam.parked = isBreak === c.forward ? 'nose' : 'tail'
  }
  broadcast({ type: 'creep', id: c.id, phase: 'ended', result, detail, parked: beam.parked })
  broadcastStatus()
}

function startCreep(ws: WebSocket, m: CreepCommand) {
  const id = m.id ?? 0
  const valid = typeof m.forward === 'boolean' && Array.isArray(m.until) && m.until.length >= 1 && m.until.length <= 2 &&
    m.until.every(e => e === 'break' || e === 'restore') && m.maxMs >= 1 && m.maxMs <= 120000 && (m.afterMs ?? 0) >= 0 && (m.afterMs ?? 0) <= 1000
  const refuse = !HAS_SENSOR ? 'no sensor connected' : !valid ? 'bad creep arguments' : !beam.calibrated ? 'calibrate the sensor first'
    : beam.calibrating ? 'calibration is running' : creep ? 'a creep is already running' : state.speed > CREEP_SPEED + 0.001 || (state.speed > 0 && state.direction !== m.forward) ? 'stop the train first' : ''
  if (refuse) { ws.send(JSON.stringify({ type: 'creep', id, phase: 'refused', detail: refuse })); return }
  beam.parked = null
  creep = { id, forward: m.forward, until: m.until, seen: 0, maxMs: m.maxMs, afterMs: m.afterMs ?? 0, start: Date.now(), doneAt: null }
  state.speed = CREEP_SPEED; state.direction = m.forward
  broadcast({ type: 'creep', id, phase: 'running' })
  broadcastStatus()
}

function beamEvent(event: 'break' | 'restore') {
  const moving = state.speed > 0
  const edge = event === 'break' ? (state.direction ? 'nose' : 'tail') : (state.direction ? 'tail' : 'nose')
  broadcast({ type: 'beam', event, t: Date.now(), level: beam.level, ...(moving ? { direction: state.direction ? 'forward' : 'reverse', edge } : {}) })
  if (!creep) { beam.parked = null; return }
  if (creep.doneAt !== null || creep.until[creep.seen] !== event) return
  if (++creep.seen < creep.until.length) return
  creep.doneAt = Date.now()
  if (creep.afterMs === 0) endCreep('event')
}

if (HAS_SENSOR) {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now(), dt = (now - last) / 1000; last = now
    const was = inBeam()
    nose += (state.direction ? 1 : -1) * state.speed * IN_PER_S_AT_FULL * dt
    const blocked = inBeam()
    beam.state = blocked ? 'blocked' : 'clear'
    beam.level = (blocked ? 0 : 771) + Math.round(Math.random() * 6 - 3 + (blocked ? 3 : 0))
    if (blocked !== was) beamEvent(blocked ? 'break' : 'restore')
    if (creep) {
      const t = now - creep.start
      if (creep.doneAt !== null && (now - creep.doneAt >= creep.afterMs || t >= creep.maxMs + 1000)) endCreep('event')
      else if (creep.doneAt === null && t >= creep.maxMs) endCreep('timeout')
    }
  }, 20)
  setInterval(() => broadcast({ type: 'beam', event: 'heartbeat', state: beam.state, level: beam.level, calibrated: beam.calibrated }), 1000)
}

const state: TrainState = {
  speed: 0.0,
  direction: true
}

function sendStatus(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'status',
    name: RAILROAD_NAME,
    speed: state.speed,
    direction: state.direction,
    connected: true,
    features: { led: HAS_LED, sensor: HAS_SENSOR },
    beam: HAS_SENSOR ? beam : null
  }))
}

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected')
  sendStatus(ws)

  ws.on('message', (data: Buffer) => {
    try {
      const msg: IncomingCommand = JSON.parse(data.toString())

      switch (msg.cmd) {
        case 'speed':
          if (creep) endCreep('aborted', 'throttle used')
          if (msg.value > 0) beam.parked = null
          state.speed = Math.max(0, Math.min(1, msg.value || 0))
          console.log(`Speed: ${(state.speed * 100).toFixed(0)}%`)
          sendStatus(ws)
          break

        case 'direction':
          if (creep) endCreep('aborted', 'throttle used')
          state.direction = msg.value !== false
          console.log(`Direction: ${state.direction ? 'FWD' : 'REV'}`)
          sendStatus(ws)
          break

        case 'stop':
          if (creep) endCreep('aborted', 'stopped')
          if (beam.calibrating) endCalibration('failed', 'stopped')
          state.speed = 0
          console.log('STOP')
          sendStatus(ws)
          break

        case 'invert':
          if (creep) endCreep('aborted', 'throttle used')
          beam.parked = null
          console.log(`Direction invert: ${msg.value ? 'on' : 'off'}`)
          break

        case 'led':
          console.log(HAS_LED ? `LED: r=${msg.r} g=${msg.g} b=${msg.b}` : 'LED command ignored: no status LED fitted')
          break

        case 'led_auto':
          if (HAS_LED) console.log('LED: auto status resumed')
          break

        case 'beam_calibrate':
          console.log('Beam calibration')
          if (creep) endCreep('aborted', 'calibration started')
          beam.parked = null
          startCalibration(ws)
          break

        case 'creep':
          startCreep(ws, msg)
          break

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          break

        default:
          console.log('Unknown command:', (msg as { cmd: string }).cmd)
      }
    } catch (e) {
      console.log('Bad message:', data.toString())
    }
  })

  ws.on('close', () => {
    console.log('Client disconnected')
  })
})

console.log(`Mock WebSocket server running on ws://localhost:${PORT}`)
