<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Pause, Play, Settings } from '@lucide/vue'
import { useUi } from '../stores/ui'
import { useJobs } from '../stores/jobs'
import { useSettings } from '../stores/settings'
import { api } from '../api'
import type { Settings as SettingsData } from '../types'

const route = useRoute()
const router = useRouter()
const ui = useUi()
const jobs = useJobs()
const st = useSettings()
const page = computed(() => (route.name === 'library' ? 'library' : 'work'))
const props = defineProps<{ connected: boolean }>()

function status(kind: 'image' | 'analysis') {
  const name = kind === 'image' ? '生图' : '分析'
  const p = jobs.queue?.paused
  if (!props.connected) return { dot: 'gr', text: `${name}：连不上本机服务` }
  if (p?.by === 'auth' && p.kind === kind) return { dot: 'rd', text: `${name}：${p.message}` }
  const s = st.settings?.[kind]
  if (s && (!s.baseUrl || !s.apiKey)) return { dot: 'am', text: `${name}：还没配置，点右边的设置` }
  return { dot: '', text: `${name}接口正常` }
}
const image = computed(() => status('image'))
const analysis = computed(() => status('analysis'))
const parentPaused = computed(() => (props.connected ? (jobs.queue?.parentPaused ?? null) : null))
const problem = computed(
  () =>
    [image.value, analysis.value].find((s) => s.dot === 'rd' || s.dot === 'gr') ??
    (parentPaused.value ? { dot: 'rd', text: `匹配父体暂停：${parentPaused.value}，去设置检查` } : null) ??
    [image.value, analysis.value].find((s) => s.dot === 'am'),
)
const userPaused = computed(() => jobs.queue?.paused?.by === 'user')

/** 一批图只属于一个店铺：队列里有图时不能换（2026-11-04 用户要求「生图过程中不可切换店铺」） */
const storeLocked = computed(() => jobs.all.length > 0)
async function useStore(e: Event) {
  const el = e.target as HTMLSelectElement
  const id = el.value
  const r = await ui.act(() => api.post<SettingsData>(`/stores/${encodeURIComponent(id)}/use`))
  if (r) {
    st.settings = r
    await jobs.loadBatch()
    ui.toast(`换到「${st.currentStore?.name}」，之后加的图用这个店铺命名`)
  } else el.value = st.settings?.currentStoreId ?? id
}

async function togglePause() {
  await ui.act(() => (userPaused.value ? jobs.resume() : jobs.pause()))
}
</script>

<template>
  <header class="top">
    <div class="brand"><span class="m">TS</span><b>Two stages</b><span>主图批量生成</span></div>
    <div class="seg" role="tablist" aria-label="页面">
      <button type="button" role="tab" :aria-selected="page === 'work'" @click="router.push('/')">工作台</button>
      <button type="button" role="tab" :aria-selected="page === 'library'" @click="router.push('/library')">模版库</button>
    </div>
    <div class="fill"></div>
    <label v-if="st.settings" class="store" :title="storeLocked ? '队列里还有图，先「清空队列」再换店铺（一批图只能属于一个店铺）' : '新加的图用这个店铺的缩写命名 SKU、匹配父体'">
      <span class="muted small">店铺</span>
      <select :value="st.settings.currentStoreId" :disabled="storeLocked" aria-label="店铺" @change="useStore">
        <option v-for="s in st.settings.stores" :key="s.id" :value="s.id">{{ s.name }}（{{ s.abbr }}）</option>
      </select>
    </label>
    <button type="button" class="ok" style="border: 0; background: transparent" :title="`${image.text}\n${analysis.text}`" @click="ui.settingsOpen = true">
      <span class="dot" :class="image.dot" aria-hidden="true"></span>
      <span class="dot" :class="analysis.dot" aria-hidden="true"></span>
      <span v-if="parentPaused" class="dot rd" aria-hidden="true"></span>
      <span class="ok-text" :style="problem?.dot === 'rd' ? 'color: var(--rd)' : ''">{{ problem ? problem.text : '接口正常' }}</span>
    </button>
    <button type="button" class="btn sm" :class="{ pri: userPaused }" :aria-label="userPaused ? '继续队列' : '暂停队列'" @click="togglePause">
      <component :is="userPaused ? Play : Pause" aria-hidden="true" /><span class="pause-text">{{ userPaused ? '继续队列' : '暂停队列' }}</span>
    </button>
    <button type="button" class="ib" aria-label="设置" @click="ui.settingsOpen = true"><Settings aria-hidden="true" /></button>
  </header>
</template>

<style scoped>
.store { display: inline-flex; align-items: center; gap: 6px; }
.store select:disabled { opacity: 0.7; }
</style>
