<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import Toast from './components/Toast.vue'
import { connectEvents } from './sse'
import { useLibrary } from './stores/library'
import { useUi } from './stores/ui'

const lib = useLibrary()
const ui = useUi()

let disconnect: (() => void) | null = null
onMounted(() => {
  disconnect = connectEvents({
    onOpen: () => {
      void ui.act(() => lib.load())
    },
    onEvent: (name, data) => {
      if (name === 'library') lib.apply(data)
      else if (name === 'toast') ui.toast(data.message, data.level)
    },
  })
})
onBeforeUnmount(() => disconnect?.())
</script>

<template>
  <TopBar />
  <RouterView />
  <Toast />
</template>
