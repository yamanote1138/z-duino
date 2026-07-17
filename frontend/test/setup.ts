// Test-only fake WebSocket. happy-dom (like jsdom) doesn't implement the
// WebSocket API, and useTrainController.ts opens a real one at module-load
// time, so every test needs this in place before importing the composable.
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  url: string
  protocols?: string | string[]
  sent: string[] = []

  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  // ── Test-only helpers, not part of the real WebSocket API ──

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  lastSent(): unknown {
    return JSON.parse(this.sent[this.sent.length - 1])
  }
}

// @ts-expect-error - replacing the global WebSocket with the fake for tests
global.WebSocket = FakeWebSocket
