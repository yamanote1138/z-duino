import { beforeEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { FakeWebSocket } from './setup'

async function mountFresh() {
  vi.resetModules()
  FakeWebSocket.instances.length = 0
  const Comp = (await import('../src/components/SpeedController.vue')).default
  const socket = FakeWebSocket.instances[0]
  // Open the socket before mounting so `connected` is already true on first
  // render — the segment buttons and controls are all `:disabled="!connected"`.
  socket.simulateOpen()
  const wrapper = mount(Comp)
  await nextTick()
  return { wrapper, socket }
}

beforeEach(() => {
  localStorage.clear()
})

describe('SpeedController', () => {
  it('colors segments red/yellow/green based on the current speed', async () => {
    const { wrapper, socket } = await mountFresh()

    socket.simulateMessage({ type: 'status', speed: 0.5, direction: true, connected: true })
    await nextTick()

    const segments = wrapper.findAll('button.speed-segment')
    expect(segments[0].classes()).toContain('bg-red-500')   // lit, index <= 2
    expect(segments[4].classes()).toContain('bg-yellow-500') // lit, index <= 6, level 0.5 == speed
    expect(segments[9].classes()).toContain('bg-neutral-700') // beyond current speed, unlit
  })

  it('clicking E-Stop sends the stop command', async () => {
    const { wrapper, socket } = await mountFresh()

    const estopButton = wrapper.findAll('button').find(b => b.text().includes('E-Stop'))
    expect(estopButton).toBeTruthy()

    await estopButton!.trigger('click')

    expect(socket.lastSent()).toEqual({ cmd: 'stop' })
  })
})
