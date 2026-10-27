<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, ListChecks, X } from '@lucide/vue'
import { useUi } from '../stores/ui'

const ui = useUi()
const v = computed(() => ui.viewer)
const item = computed(() => v.value?.items[v.value.index])
const loading = ref(true)
const broken = ref(false)

watch(
  () => item.value?.src,
  () => {
    loading.value = true
    broken.value = false
  },
)

function go(d: number) {
  const cur = v.value
  if (!cur || cur.items.length < 2) return
  cur.index = (cur.index + d + cur.items.length) % cur.items.length
}
function close() {
  ui.viewer = null
}
function details() {
  const cur = v.value
  if (!cur?.jobId || item.value?.step === undefined) return
  ui.sheet = { jobId: cur.jobId, step: item.value.step }
  close()
}

function onKey(e: KeyboardEvent) {
  if (!v.value) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') go(-1)
  else if (e.key === 'ArrowRight') go(1)
  else return
  e.preventDefault()
  e.stopPropagation()
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div v-if="v && item" class="viewer" role="dialog" aria-modal="true" :aria-label="'查看大图：' + item.label" @click.self="close">
    <div class="vw-h">
      <div class="vw-t">
        <b>{{ item.label }}</b>
        <span v-if="v.title">{{ v.title }}</span>
        <span v-if="v.items.length > 1">{{ v.index + 1 }} / {{ v.items.length }}</span>
      </div>
      <button v-if="v.jobId && item.step !== undefined" type="button" class="btn sm" @click="details"><ListChecks aria-hidden="true" />这一步的详情 / 重做</button>
      <a class="btn sm" :href="item.src" target="_blank" rel="noopener">新窗口打开原图</a>
      <button type="button" class="ib" aria-label="关闭" @click="close"><X aria-hidden="true" /></button>
    </div>
    <div class="vw-b" @click.self="close">
      <button v-if="v.items.length > 1" type="button" class="vw-nav l" aria-label="上一张" @click="go(-1)"><ChevronLeft aria-hidden="true" /></button>
      <span v-if="broken" class="vw-msg">图片已不在</span>
      <img v-else :key="item.src" :src="item.src" :alt="item.label" :class="{ ld: loading }" @load="loading = false" @error="broken = true" />
      <span v-if="loading && !broken" class="vw-msg">加载原图…</span>
      <button v-if="v.items.length > 1" type="button" class="vw-nav r" aria-label="下一张" @click="go(1)"><ChevronRight aria-hidden="true" /></button>
    </div>
    <div v-if="v.items.length > 1" class="vw-f">
      <button v-for="(it, i) in v.items" :key="it.src" type="button" :aria-pressed="i === v.index" @click="v.index = i">{{ it.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.viewer { position: fixed; inset: 0; z-index: 15; background: rgba(12, 16, 14, 0.94); display: flex; flex-direction: column; color: #fff; }
.vw-h { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
.vw-t { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vw-t b { font-weight: 500; font-size: 15px; }
.vw-t span { font-size: 12px; color: rgba(255, 255, 255, 0.65); overflow: hidden; text-overflow: ellipsis; }
.vw-h .ib { color: #fff; }
.vw-h .ib:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.vw-h .btn { color: var(--tx); text-decoration: none; }
.vw-b { flex: 1; min-height: 0; position: relative; padding: 0 68px; }
.vw-b img { position: absolute; inset: 0; margin: auto; max-width: calc(100% - 136px); max-height: 100%; object-fit: contain; background: #fff; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4); }
.vw-b img.ld { opacity: 0; }
.vw-msg { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: rgba(255, 255, 255, 0.7); pointer-events: none; }
.vw-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 44px; border-radius: 50%; border: 0; background: rgba(255, 255, 255, 0.14); color: #fff; display: grid; place-items: center; }
.vw-nav:hover { background: rgba(255, 255, 255, 0.26); }
.vw-nav.l { left: 12px; }
.vw-nav.r { right: 12px; }
.vw-f { display: flex; justify-content: center; gap: 6px; padding: 12px 16px 16px; flex-wrap: wrap; }
.vw-f button { border: 0; border-radius: 999px; padding: 5px 14px; font-size: 12px; background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.85); }
.vw-f button[aria-pressed='true'] { background: #fff; color: #111; }
</style>
