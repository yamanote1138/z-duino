<template>
  <div class="flex justify-center gap-2">
    <DirectionInvert />
    <DebugModal />
    <UButton
      size="sm"
      :color="ledTestMode ? 'primary' : 'neutral'"
      variant="outline"
      @click="toggleLedTest()"
    >
      <UIcon :name="ledTestMode ? 'i-mdi-gauge' : 'i-mdi-led-on'" />
      {{ ledTestMode ? 'Back to Throttle' : 'LED Test' }}
    </UButton>
  </div>
</template>

<script setup lang="ts">
import { useTrainController } from '../composables/useTrainController'
import DirectionInvert from './DirectionInvert.vue'
import DebugModal from './DebugModal.vue'

const { ledTestMode, toggleLedTest } = useTrainController()
</script>
