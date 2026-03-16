<template>
  <div class="flex justify-between items-center">
    <h4 class="text-lg font-semibold text-white flex items-center gap-2">
      <UIcon name="i-mdi-train" class="text-xl" />
      {{ railroadName }}
    </h4>
    <UBadge
      :color="connected ? 'success' : 'error'"
      variant="solid"
      size="md"
    >
      <UIcon :name="connected ? 'i-mdi-wifi' : 'i-mdi-wifi-off'" />
      {{ connected ? 'Connected' : 'Disconnected' }}
    </UBadge>
  </div>
</template>

<script setup lang="ts">
import { useTrainController } from '../composables/useTrainController'

const { railroadName, connected } = useTrainController()
</script>
