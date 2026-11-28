<template>
  <div v-if="hasSensor && beam" class="mt-4 rounded-lg border border-neutral-700 p-3 text-sm">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-block h-3 w-3 rounded-full" :class="dotClass" />
        <span class="font-medium">Beam: {{ stateLabel }}</span>
        <span v-if="beam.calibrated && beam.state !== 'lost'" class="text-neutral-400">({{ beam.level }})</span>
      </div>
      <span v-if="beam.parked" data-test="parked" class="text-neutral-300">Parked on {{ beam.parked }}</span>
    </div>

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <template v-if="!parkBusy">
        <UButton data-test="park-nose" size="xs" color="neutral" variant="outline" :disabled="!canPark" @click="parkLoco('nose')">
          <UIcon name="i-mdi-arrow-collapse-right" />
          Park on nose
        </UButton>
        <UButton data-test="park-tail" size="xs" color="neutral" variant="outline" :disabled="!canPark" @click="parkLoco('tail')">
          <UIcon name="i-mdi-arrow-collapse-left" />
          Park on tail
        </UButton>
      </template>
      <UButton v-else data-test="park-stop" size="xs" color="error" @click="emergencyStop()">
        <UIcon name="i-mdi-stop" />
        Stop
      </UButton>
      <span class="grow" />
      <UButton
        v-if="!busy && !confirming && !parkBusy"
        data-test="calibrate"
        size="xs"
        color="neutral"
        variant="outline"
        :disabled="!connected || beam.state === 'lost'"
        @click="confirming = true"
      >
        <UIcon name="i-mdi-tune-vertical" />
        Calibrate
      </UButton>
      <UButton v-if="busy" data-test="calibrate-stop" size="xs" color="error" @click="emergencyStop()">
        <UIcon name="i-mdi-stop" />
        Stop
      </UButton>
    </div>

    <div v-if="confirming && !busy" class="mt-2 flex items-center justify-between gap-2 text-neutral-300">
      <span>The loco will creep until it finds the beam, then stop.</span>
      <div class="flex shrink-0 gap-1">
        <UButton data-test="calibrate-go" size="xs" color="primary" @click="start()">Go</UButton>
        <UButton size="xs" color="neutral" variant="ghost" @click="confirming = false">Cancel</UButton>
      </div>
    </div>

    <div v-if="parkText" data-test="park-progress" class="mt-2" :class="parking && !parking.running && !parking.ok ? 'text-red-400' : 'text-neutral-300'">
      {{ parkText }}
    </div>

    <div v-if="progressText" class="mt-2" :class="calibration?.phase === 'failed' ? 'text-red-400' : 'text-neutral-300'">
      {{ progressText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrainController } from '../composables/useTrainController'

const { connected, hasSensor, beam, calibration, calibrateSensor, emergencyStop, parking, parkLoco, currentSpeed } = useTrainController()

const confirming = ref(false)

const RUNNING = ['starting', 'measuring', 'creeping', 'measuring_second']
const busy = computed(() => beam.value?.calibrating || RUNNING.includes(calibration.value?.phase ?? ''))

const parkBusy = computed(() => parking.value?.running === true)
const canPark = computed(() => connected.value && !!beam.value?.calibrated && beam.value.state !== 'lost' && !busy.value && currentSpeed.value === 0)

const parkText = computed(() => {
  const p = parking.value
  if (!p) return ''
  if (p.running) return p.step ? `${p.step}...` : 'Starting...'
  return p.ok ? p.detail : `Parking failed: ${p.detail}`
})

const stateLabel = computed(() => {
  if (!beam.value) return ''
  if (beam.value.state === 'lost') return 'Sensor lost'
  if (!beam.value.calibrated) return 'Not calibrated'
  return beam.value.state === 'blocked' ? 'Blocked' : 'Clear'
})

const dotClass = computed(() => {
  if (!beam.value || beam.value.state === 'lost') return 'bg-red-500'
  if (!beam.value.calibrated) return 'bg-yellow-500'
  return beam.value.state === 'blocked' ? 'bg-orange-500' : 'bg-green-500'
})

const PHASE_TEXT: Record<string, string> = {
  starting: 'Starting...',
  measuring: 'Measuring the beam where the loco is...',
  creeping: 'Looking for the beam...',
  measuring_second: 'Found it. Measuring again...'
}

const progressText = computed(() => {
  const c = calibration.value
  if (!c) return ''
  if (c.phase === 'done') return `Calibrated: ${c.detail}`
  if (c.phase === 'failed') return `Calibration failed: ${c.detail}`
  return PHASE_TEXT[c.phase] ?? ''
})

function start() {
  confirming.value = false
  calibrateSensor()
}
</script>
