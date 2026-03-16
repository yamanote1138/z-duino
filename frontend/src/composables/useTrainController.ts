import { ref } from 'vue'

// WebSocket protocol types
interface OutgoingSpeed { cmd: 'speed'; value: number }
interface OutgoingDirection { cmd: 'direction'; value: boolean }
interface OutgoingStop { cmd: 'stop' }
interface OutgoingPing { cmd: 'ping' }
interface OutgoingInvert { cmd: 'invert'; value: boolean }
interface OutgoingLed { cmd: 'led'; r: number; g: number; b: number }
interface OutgoingLedAuto { cmd: 'led_auto' }

type OutgoingMessage =
  | OutgoingSpeed
  | OutgoingDirection
  | OutgoingStop
  | OutgoingPing
  | OutgoingInvert
  | OutgoingLed
  | OutgoingLedAuto

interface StatusMessage {
  type: 'status'
  name?: string
  speed: number
  direction: boolean
  connected: boolean
}

interface PongMessage {
  type: 'pong'
}

type IncomingMessage = StatusMessage | PongMessage

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

let rampTimer: ReturnType<typeof setInterval> | null = null
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
    reconnectDelay = RECONNECT_BASE
    startPing()
    if (directionInverted.value) {
      send({ cmd: 'invert', value: true })
    }
  }

  socket.value.onclose = () => {
    connected.value = false
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
      }
    } catch (e) {
      // ignore malformed messages
    }
  }
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

function setSpeed(clickedLevel: number, clickedIndex: number) {
  let targetSpeed: number
  if (currentSpeed.value >= clickedLevel) {
    targetSpeed = clickedIndex === 0 ? 0 : powerLevels[clickedIndex - 1]
  } else {
    targetSpeed = clickedLevel
  }
  rampTo(targetSpeed)
}

function rampTo(targetSpeed: number) {
  stopFlag.value = false
  if (rampTimer) {
    clearInterval(rampTimer)
    rampTimer = null
  }

  const startSpeed = currentSpeed.value
  const distance = Math.abs(targetSpeed - startSpeed)
  const segmentsCrossed = Math.round(distance / 0.1)
  const duration = Math.max(segmentsCrossed * RAMP_TIME_PER_SEGMENT, 200)
  const totalSteps = Math.max(Math.ceil(duration / RAMP_INTERVAL), 5)

  let step = 0

  rampTimer = setInterval(() => {
    if (stopFlag.value) {
      clearInterval(rampTimer!)
      rampTimer = null
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
    }
  }, RAMP_INTERVAL)
}

function waitForRampComplete(): Promise<void> {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (!rampTimer) {
        clearInterval(check)
        resolve()
      }
    }, 50)
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
    rampTo(0)

    await waitForRampComplete()
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

function sendLed(color: LedColor) {
  const scale = ledBright.value ? 1.0 : 0.25
  const payload: OutgoingLed = {
    cmd: 'led',
    r: Math.round(color.r * scale),
    g: Math.round(color.g * scale),
    b: Math.round(color.b * scale)
  }
  console.log(`LED: ${color.name} (${ledBright.value ? 'bright' : 'dim'}) →`, payload)
  send(payload)
}

// ── Debug ──

const WS_READY_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const

function getDebugInfo(): { label: string; value: string }[] {
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
    { label: 'Supply Voltage', value: '12V' },
    { label: 'Track Voltage', value: `${(12 * currentSpeed.value).toFixed(1)}V` },
    { label: 'Direction', value: currentDirection.value ? 'FWD' : 'REV' },
    { label: 'Direction Inverted', value: String(directionInverted.value) },
    { label: 'Ramping', value: String(rampTimer !== null) },
    { label: 'LED Test Mode', value: String(ledTestMode.value) },
    { label: 'LED Brightness', value: ledBright.value ? 'Bright' : 'Dim' },
    { label: 'Active LED Color', value: activeLedColor.value ?? 'none' },
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
    ledTestMode,
    ledBright,
    activeLedColor,

    getSegmentClass,
    setSpeed,
    toggleDirection,
    brake,
    emergencyStop,

    toggleInvert,

    toggleLedTest,
    setLed,
    toggleBright,

    getDebugInfo
  }
}
