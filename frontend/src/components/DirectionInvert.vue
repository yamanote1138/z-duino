<template>
  <UButton
    size="sm"
    :color="directionInverted ? 'primary' : 'neutral'"
    variant="outline"
    @click="toggleInvert()"
  >
    <UIcon name="i-mdi-shuffle-variant" />
    {{ directionInverted ? 'Dir Inverted' : 'Invert Dir' }}
  </UButton>
</template>

<script setup lang="ts">
import { useTrainController } from '../composables/useTrainController'

const { directionInverted, toggleInvert } = useTrainController()
</script>
