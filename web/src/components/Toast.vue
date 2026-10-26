<script setup lang="ts">
import { useUi } from '../stores/ui'
const ui = useUi()
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="t.level" role="status">{{ t.message }}</div>
  </div>
</template>
