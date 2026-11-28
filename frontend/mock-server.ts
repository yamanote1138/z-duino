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

type IncomingCommand =
  | SpeedCommand
  | DirectionCommand
  | StopCommand
  | InvertCommand
  | LedCommand
  | LedAutoCommand
  | PingCommand
  | BeamCalibrateCommand

const PORT = 81
const RAILROAD_NAME = 'Mock Railroad Co.'
const HAS_LED = process.env.MOCK_LED !== '0' // MOCK_LED=0 npm run mock: act like a controller built without the status LED
const HAS_SENSOR = process.env.MOCK_SENSOR !== '0' // MOCK_SENSOR=0 npm run mock: act like a controller with no beam sensor
const wss = new WebSocketServer({ port: PORT })

// A pretend beam sensor: a level that dips now and then, and a calibration that walks through its phases
const beam = { state: 'clear', level: 748, calibrated: true, calibrating: false }
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
  step(5500, () => { state.speed = 0; beam.state = 'blocked'; beam.level = 235; broadcast({ type: 'beam', event: 'calibration', phase: 'measuring_second', detail: '' }); broadcastStatus() })
  step(9000, () => endCalibration('done', 'clear 748, blocked 235'))
}

if (HAS_SENSOR) {
  setInterval(() => {
    if (!beam.calibrating && Math.random() < 0.1) beam.state = beam.state === 'clear' ? 'blocked' : 'clear'
    if (!beam.calibrating) beam.level = (beam.state === 'clear' ? 748 : 235) + Math.round(Math.random() * 6 - 3)
    broadcast({ type: 'beam', event: 'heartbeat', state: beam.state, level: beam.level, calibrated: beam.calibrated })
  }, 1000)
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
          state.speed = Math.max(0, Math.min(1, msg.value || 0))
          console.log(`Speed: ${(state.speed * 100).toFixed(0)}%`)
          sendStatus(ws)
          break

        case 'direction':
          state.direction = msg.value !== false
          console.log(`Direction: ${state.direction ? 'FWD' : 'REV'}`)
          sendStatus(ws)
          break

        case 'stop':
          if (beam.calibrating) endCalibration('failed', 'stopped')
          state.speed = 0
          console.log('STOP')
          sendStatus(ws)
          break

        case 'invert':
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
          startCalibration(ws)
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
