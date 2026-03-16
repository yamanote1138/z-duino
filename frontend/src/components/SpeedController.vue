<template>
  <div>
    <!-- Speed Bar -->
    <div class="mb-3">
      <div class="flex justify-between text-sm text-neutral-400 mb-1">
        <span><span class="font-bold">Speed:</span> {{ currentSpeed === 0 ? 'stopped' : Math.round(currentSpeed * 100) + '%' }}</span>
        <span><span class="font-bold">Track:</span> {{ (12 * currentSpeed).toFixed(1) }}V</span>
      </div>
      <div class="flex w-full">
        <button
          v-for="(level, index) in powerLevels"
          :key="index"
          type="button"
          class="speed-segment flex-1"
          :class="getSegmentClass(index)"
          :disabled="!connected"
          @click="setSpeed(level, index)"
        >
          {{ index + 1 }}
        </button>
      </div>
    </div>

    <!-- Controls -->
    <div class="flex gap-2">
      <UButton
        class="flex-1 justify-center"
        color="primary"
        :disabled="!connected"
        @click="toggleDirection()"
      >
        <UIcon :name="currentDirection ? 'i-mdi-arrow-right-bold' : 'i-mdi-arrow-left-bold'" />
        {{ currentDirection ? 'FWD' : 'REV' }}
      </UButton>
      <UButton
        class="flex-1 justify-center"
        color="neutral"
        :disabled="!connected || currentSpeed === 0"
        @click="brake()"
      >
        <UIcon name="i-mdi-pause" />
        Brake
      </UButton>
      <UButton
        class="flex-1 justify-center"
        color="error"
        :disabled="!connected"
        @click="emergencyStop()"
      >
        <UIcon name="i-mdi-hand-back-left" />
        E-Stop
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTrainController } from '../composables/useTrainController'
import { powerLevels } from '../composables/useTrainController'

const {
  connected,
  currentSpeed,
  currentDirection,
  getSegmentClass,
  setSpeed,
  toggleDirection,
  brake,
  emergencyStop
} = useTrainController()
</script>
