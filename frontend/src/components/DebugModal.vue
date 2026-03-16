<template>
  <UButton
    size="sm"
    color="neutral"
    variant="outline"
    @click="open()"
  >
    <UIcon name="i-mdi-bug" />
    Debug
  </UButton>

  <UModal v-model:open="isOpen" title="Debug Info" :ui="{ width: 'sm:max-w-lg' }">
    <template #body>
      <table class="w-full text-sm">
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="row.label"
            :class="i % 2 === 0 ? 'bg-neutral-800/50' : ''"
          >
            <td class="px-3 py-1.5 font-medium text-neutral-400 whitespace-nowrap">{{ row.label }}</td>
            <td class="px-3 py-1.5 text-white break-all">{{ row.value }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useTrainController } from '../composables/useTrainController'

const { getDebugInfo } = useTrainController()

const isOpen = ref(false)
const rows = ref<{ label: string; value: string }[]>([])

function open() {
  rows.value = getDebugInfo()
  isOpen.value = true
}
</script>
