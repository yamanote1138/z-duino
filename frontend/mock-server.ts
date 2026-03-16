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

type IncomingCommand =
  | SpeedCommand
  | DirectionCommand
  | StopCommand
  | InvertCommand
  | LedCommand
  | LedAutoCommand
  | PingCommand

const PORT = 81
const RAILROAD_NAME = 'Mock Railroad Co.'
const wss = new WebSocketServer({ port: PORT })

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
    connected: true
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
          state.speed = 0
          console.log('STOP')
          sendStatus(ws)
          break

        case 'invert':
          console.log(`Direction invert: ${msg.value ? 'on' : 'off'}`)
          break

        case 'led':
          console.log(`LED: r=${msg.r} g=${msg.g} b=${msg.b}`)
          break

        case 'led_auto':
          console.log('LED: auto status resumed')
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
