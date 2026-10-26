<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Settings } from '@lucide/vue'
import { useUi } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const ui = useUi()
const page = computed(() => (route.name === 'library' ? 'library' : 'work'))
</script>

<template>
  <header class="top">
    <div class="brand"><span class="m">TS</span><b>Two stages</b><span>主图批量生成</span></div>
    <div class="seg" role="tablist" aria-label="页面">
      <button type="button" role="tab" :aria-selected="page === 'work'" @click="router.push('/')">工作台</button>
      <button type="button" role="tab" :aria-selected="page === 'library'" @click="router.push('/library')">模版库</button>
    </div>
    <div class="fill"></div>
    <slot />
    <button type="button" class="ib" aria-label="设置" @click="ui.settingsOpen = true"><Settings aria-hidden="true" /></button>
  </header>
</template>
