import { beforeEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { FakeWebSocket } from './setup'

async function mountFooter(features?: { led?: boolean }) {
  vi.resetModules()
  FakeWebSocket.instances.length = 0
  const Footer = (await import('../src/components/TrainFooter.vue')).default
  const socket = FakeWebSocket.instances[0]
  socket.simulateOpen()
  socket.simulateMessage({ type: 'status', speed: 0, direction: true, connected: true, ...(features ? { features } : {}) })
  // The debug modal and invert button are not what is under test (and the modal starts a pending fetch at teardown)
  const wrapper = mount(Footer, { global: { stubs: { DebugModal: true, DirectionInvert: true, UIcon: true } } })
  await nextTick()
  return wrapper
}

const labels = (w: Awaited<ReturnType<typeof mountFooter>>) => w.findAll('button').map(b => b.text())

beforeEach(() => {
  localStorage.clear()
})

describe('TrainFooter with the optional status LED', () => {
  it('shows LED Test and Party Mode when the LED is fitted, or the controller says nothing', async () => {
    for (const features of [undefined, { led: true }]) {
      const l = labels(await mountFooter(features))
      expect(l.some(t => t.includes('LED Test'))).toBe(true)
      expect(l.some(t => t.includes('Party Mode'))).toBe(true)
    }
  })

  it('leaves both out when no LED is fitted', async () => {
    const l = labels(await mountFooter({ led: false }))
    // the stubbed children render no buttons, so with the LED buttons gone nothing is left
    expect(l).toEqual([])
  })
})
