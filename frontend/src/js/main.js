import { createApp } from 'vue'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@fortawesome/fontawesome-free/css/fontawesome.min.css'
import '@fortawesome/fontawesome-free/css/solid.min.css'
import '../css/style.css'

const RAMP_INTERVAL = 100       // ms between ramp steps
const RAMP_TIME_PER_SEGMENT = 200 // ms per segment traversed
const DIRECTION_PAUSE = 500     // ms pause during direction change
const RECONNECT_BASE = 1000     // base reconnect delay
const RECONNECT_MAX = 30000     // max reconnect delay
const PING_INTERVAL = 10000     // keepalive ping interval

const app = createApp({
  data() {
    return {
      socket: null,
      connected: false,
      currentSpeed: 0.0,
      currentDirection: true,
      powerLevels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      rampTimer: null,
      stopFlag: false,
      reconnectDelay: RECONNECT_BASE,
      reconnectTimer: null,
      pingTimer: null
    }
  },

  methods: {
    connect() {
      if (this.socket && this.socket.readyState <= 1) return

      const host = location.hostname || 'localhost'
      this.socket = new WebSocket(`ws://${host}:81/`, ['arduino'])

      this.socket.onopen = () => {
        this.connected = true
        this.reconnectDelay = RECONNECT_BASE
        this.startPing()
      }

      this.socket.onclose = () => {
        this.connected = false
        this.stopPing()
        this.scheduleReconnect()
      }

      this.socket.onerror = () => {
        this.socket.close()
      }

      this.socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'status') {
            this.currentSpeed = msg.speed
            this.currentDirection = msg.direction
          }
        } catch (e) {
          // ignore malformed messages
        }
      }
    },

    scheduleReconnect() {
      if (this.reconnectTimer) return
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX)
    },

    startPing() {
      this.stopPing()
      this.pingTimer = setInterval(() => {
        this.send({ cmd: 'ping' })
      }, PING_INTERVAL)
    },

    stopPing() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
    },

    send(obj) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(obj))
      }
    },

    getSegmentClass(index) {
      const level = this.powerLevels[index]
      let colour
      if (index <= 2) colour = 'btn-danger'
      else if (index <= 6) colour = 'btn-warning'
      else colour = 'btn-success'

      if (this.currentSpeed >= level) {
        return colour
      } else {
        return 'btn-secondary opacity-50'
      }
    },

    setSpeed(clickedLevel, clickedIndex) {
      let targetSpeed

      if (this.currentSpeed >= clickedLevel) {
        // Clicking a lit segment: ramp down to the one below it (or 0)
        targetSpeed = clickedIndex === 0 ? 0 : this.powerLevels[clickedIndex - 1]
      } else {
        // Clicking an unlit segment: ramp up to it
        targetSpeed = clickedLevel
      }

      this.rampTo(targetSpeed)
    },

    rampTo(targetSpeed) {
      this.stopFlag = false
      if (this.rampTimer) {
        clearInterval(this.rampTimer)
        this.rampTimer = null
      }

      const startSpeed = this.currentSpeed
      const distance = Math.abs(targetSpeed - startSpeed)
      // Calculate segments to traverse
      const segmentsCrossed = Math.round(distance / 0.1)
      const duration = Math.max(segmentsCrossed * RAMP_TIME_PER_SEGMENT, 200)
      const totalSteps = Math.max(Math.ceil(duration / RAMP_INTERVAL), 5)

      let step = 0

      this.rampTimer = setInterval(() => {
        if (this.stopFlag) {
          clearInterval(this.rampTimer)
          this.rampTimer = null
          return
        }

        step++
        const progress = Math.min(step / totalSteps, 1.0)
        const speed = startSpeed + (targetSpeed - startSpeed) * progress

        // Snap to nearest 0.001 to avoid floating point drift
        this.currentSpeed = Math.round(speed * 1000) / 1000
        this.send({ cmd: 'speed', value: this.currentSpeed })

        if (step >= totalSteps) {
          clearInterval(this.rampTimer)
          this.rampTimer = null
          this.currentSpeed = targetSpeed
          this.send({ cmd: 'speed', value: this.currentSpeed })
        }
      }, RAMP_INTERVAL)
    },

    async toggleDirection() {
      if (this.currentSpeed === 0) {
        // Stopped: switch immediately
        this.currentDirection = !this.currentDirection
        this.send({ cmd: 'direction', value: this.currentDirection })
      } else {
        // Moving: ramp down, pause, switch, ramp back up
        const previousSpeed = this.currentSpeed
        this.rampTo(0)

        // Wait for ramp to finish
        await this.waitForRampComplete()
        await this.sleep(DIRECTION_PAUSE)

        this.currentDirection = !this.currentDirection
        this.send({ cmd: 'direction', value: this.currentDirection })

        await this.sleep(100)
        this.rampTo(previousSpeed)
      }
    },

    waitForRampComplete() {
      return new Promise(resolve => {
        const check = setInterval(() => {
          if (!this.rampTimer) {
            clearInterval(check)
            resolve()
          }
        }, 50)
      })
    },

    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
    },

    brake() {
      this.rampTo(0)
    },

    emergencyStop() {
      this.stopFlag = true
      if (this.rampTimer) {
        clearInterval(this.rampTimer)
        this.rampTimer = null
      }
      this.currentSpeed = 0
      this.send({ cmd: 'stop' })
    }
  },

  created() {
    this.connect()
  }
})

app.mount('#app')
