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
    <UButton
      size="sm"
      :color="partyMode ? 'warning' : 'neutral'"
      :variant="partyMode ? 'solid' : 'outline'"
      :disabled="!connected"
      @click="togglePartyMode()"
    >
      <UIcon :name="partyMode ? 'i-mdi-stop' : 'i-mdi-party-popper'" class="shrink-0" />
      <span class="whitespace-nowrap">{{ partyMode ? 'Stop Party' : 'Party Mode' }}</span>
    </UButton>
  </div>
</template>

<script setup lang="ts">
import { useTrainController } from '../composables/useTrainController'
import DirectionInvert from './DirectionInvert.vue'
import DebugModal from './DebugModal.vue'

const { connected, ledTestMode, toggleLedTest, partyMode, togglePartyMode } = useTrainController()
</script>
