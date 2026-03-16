<template>
  <div>
    <div class="flex justify-between items-center mb-2">
      <span class="text-sm text-neutral-400">LED Test</span>
      <UButton
        size="sm"
        :color="ledBright ? 'warning' : 'neutral'"
        :variant="ledBright ? 'solid' : 'outline'"
        :disabled="!connected"
        @click="toggleBright()"
      >
        <UIcon :name="ledBright ? 'i-mdi-white-balance-sunny' : 'i-mdi-weather-night'" />
        {{ ledBright ? 'Bright' : 'Dim' }}
      </UButton>
    </div>
    <div class="flex flex-wrap gap-1">
      <button
        v-for="c in ledColors"
        :key="c.name"
        class="btn-led flex-1 min-w-[60px] px-2 py-1 rounded text-sm font-medium transition-all"
        :style="{
          backgroundColor: c.css,
          color: c.text,
          border: activeLedColor === c.name ? '2px solid #fff' : '1px solid #555',
          fontWeight: activeLedColor === c.name ? 'bold' : 'normal'
        }"
        :disabled="!connected"
        @click="setLed(c)"
      >
        {{ c.name }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTrainController, ledColors } from '../composables/useTrainController'

const {
  connected,
  ledBright,
  activeLedColor,
  toggleBright,
  setLed
} = useTrainController()
</script>
