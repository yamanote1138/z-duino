import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { FakeWebSocket } from './setup'

async function mountPanel(statusExtra: object) {
  vi.resetModules()
  FakeWebSocket.instances.length = 0
  const Panel = (await import('../src/components/BeamPanel.vue')).default
  const socket = FakeWebSocket.instances[0]
  socket.simulateOpen()
  socket.simulateMessage({ type: 'status', speed: 0, direction: true, connected: true, ...statusExtra })
  const wrapper = mount(Panel, { global: { stubs: { UIcon: true } } })
  await nextTick()
  return { wrapper, socket }
}

const sensor = (beam: object) => ({ features: { sensor: true }, beam: { state: 'clear', level: 748, calibrated: true, calibrating: false, ...beam } })

describe('BeamPanel', () => {
  it('renders nothing without a sensor', async () => {
    const { wrapper } = await mountPanel({ features: { sensor: false }, beam: null })
    expect(wrapper.text()).toBe('')
  })

  it('shows the beam state and level', async () => {
    const { wrapper } = await mountPanel(sensor({ state: 'blocked', level: 231 }))
    expect(wrapper.text()).toContain('Blocked')
    expect(wrapper.text()).toContain('231')
  })

  it('says when the sensor needs calibrating', async () => {
    const { wrapper } = await mountPanel(sensor({ calibrated: false, state: 'uncalibrated' }))
    expect(wrapper.text()).toContain('Not calibrated')
  })

  it('asks before calibrating, then sends beam_calibrate', async () => {
    const { wrapper, socket } = await mountPanel(sensor({}))
    await wrapper.find('[data-test="calibrate"]').trigger('click')
    expect(wrapper.text()).toContain('creep')
    expect(socket.sent.map(m => JSON.parse(m)).some(m => m.cmd === 'beam_calibrate')).toBe(false)
    await wrapper.find('[data-test="calibrate-go"]').trigger('click')
    expect(socket.lastSent()).toEqual({ cmd: 'beam_calibrate' })
  })

  it('offers Stop while calibrating, and Stop sends stop', async () => {
    const { wrapper, socket } = await mountPanel(sensor({ calibrating: true }))
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'creeping', detail: '' })
    await nextTick()
    expect(wrapper.text()).toContain('Looking for the beam')
    await wrapper.find('[data-test="calibrate-stop"]').trigger('click')
    expect(socket.lastSent()).toEqual({ cmd: 'stop' })
  })

  it('shows the result when calibration ends', async () => {
    const { wrapper, socket } = await mountPanel(sensor({}))
    socket.simulateMessage({ type: 'beam', event: 'calibration', phase: 'failed', detail: 'the beam never changed' })
    await nextTick()
    expect(wrapper.text()).toContain('the beam never changed')
  })

  it('shows park buttons with a calibrated sensor, and disables them when it is not', async () => {
    const { wrapper } = await mountPanel(sensor({}))
    expect(wrapper.find('[data-test="park-nose"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-test="park-tail"]').exists()).toBe(true)
    const un = await mountPanel(sensor({ calibrated: false, state: 'uncalibrated' }))
    expect(un.wrapper.find('[data-test="park-nose"]').attributes('disabled')).toBeDefined()
  })

  it('disables parking while the train moves', async () => {
    const { wrapper, socket } = await mountPanel(sensor({}))
    socket.simulateMessage({ type: 'status', speed: 0.3, direction: true, connected: true, ...sensor({}) })
    await nextTick()
    expect(wrapper.find('[data-test="park-tail"]').attributes('disabled')).toBeDefined()
  })

  it('park sends a creep, shows the step and a Stop', async () => {
    const { wrapper, socket } = await mountPanel(sensor({ state: 'blocked' }))
    await wrapper.find('[data-test="park-nose"]').trigger('click')
    await nextTick()
    expect(socket.lastSent()).toMatchObject({ cmd: 'creep', forward: false, until: ['restore'] })
    expect(wrapper.text()).toContain('Backing off the beam')
    await wrapper.find('[data-test="park-stop"]').trigger('click')
    expect(socket.lastSent()).toEqual({ cmd: 'stop' })
  })

  it('says where the loco is parked', async () => {
    const { wrapper } = await mountPanel(sensor({ state: 'blocked', parked: 'nose' }))
    expect(wrapper.find('[data-test="parked"]').text()).toBe('Parked on nose')
  })

  it('Show starts by parking, shows its step, and offers Stop', async () => {
    const { wrapper, socket } = await mountPanel(sensor({ state: 'blocked' }))
    await wrapper.find('[data-test="run-show"]').trigger('click')
    await nextTick()
    expect(socket.lastSent()).toMatchObject({ cmd: 'creep', forward: false, until: ['restore'] })
    expect(wrapper.text()).toContain('Show: Backing off the beam')
    await wrapper.find('[data-test="park-stop"]').trigger('click')
    expect(socket.lastSent()).toEqual({ cmd: 'stop' })
  })
})

