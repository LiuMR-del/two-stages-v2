<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TopBar from './components/TopBar.vue'
import Toast from './components/Toast.vue'
import JobSheet from './components/JobSheet.vue'
import SettingsSheet from './components/SettingsSheet.vue'
import { connectEvents } from './sse'
import { useLibrary } from './stores/library'
import { useJobs } from './stores/jobs'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'

const lib = useLibrary()
const jobs = useJobs()
const st = useSettings()
const ui = useUi()
const connected = ref(true)

let disconnect: (() => void) | null = null
onMounted(() => {
  disconnect = connectEvents({
    onOpen: () => {
      void ui.act(() => Promise.all([lib.load(), jobs.load(), st.load()]))
    },
    onStatus: (ok) => (connected.value = ok),
    onEvent: (name, data) => {
      if (name === 'library') lib.apply(data)
      else if (name === 'toast') ui.toast(data.message, data.level)
      else jobs.onEvent(name, data)
    },
  })
})
onBeforeUnmount(() => disconnect?.())
</script>

<template>
  <TopBar :connected="connected" />
  <RouterView />
  <JobSheet />
  <SettingsSheet />
  <Toast />
</template>
