<template>
  <div class="min-h-screen bg-neutral-900">
    <div class="container mx-auto max-w-lg py-4 px-4">
      <UCard>
        <template #header>
          <TrainHeader />
        </template>

        <SpeedController v-if="!ledTestMode" />
        <LedTestPanel v-if="ledTestMode" />

        <template #footer>
          <TrainFooter />
        </template>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTrainController } from './composables/useTrainController'
import TrainHeader from './components/TrainHeader.vue'
import SpeedController from './components/SpeedController.vue'
import LedTestPanel from './components/LedTestPanel.vue'
import TrainFooter from './components/TrainFooter.vue'

const { ledTestMode } = useTrainController()
</script>
