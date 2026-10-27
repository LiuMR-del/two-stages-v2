<script setup lang="ts">
import { ref } from 'vue'
import { Download, Plus, Sparkles, Upload } from '@lucide/vue'
import { api, imageUrl } from '../api'
import { activeTemplateName, useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import ImageSlot from './ImageSlot.vue'
import type { Category } from '../types'

const lib = useLibrary()
const ui = useUi()

const dragId = ref<string | null>(null)
const overId = ref<string | null>(null)
const importFile = ref<File | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)

function select(c: Category | null) {
  if (!c) {
    ui.libSel = '__global'
    return
  }
  ui.libSel = c.id
  ui.libStyle = c.styles[0]!.id
  ui.libTpl = c.styles[0]!.activeTemplate
}

function templateName(c: Category) {
  return [...new Set(c.styles.map(activeTemplateName))].join(' / ')
}

function dot(c: Category) {
  const l = lib.checks[c.id]?.level
  return l === 'error' ? 'rd' : l === 'warn' ? 'am' : ''
}

async function addCategory() {
  const names = new Set(lib.categories.map((c) => c.name))
  let n = 1
  while (names.has(`新品类 ${n}`)) n++
  const r = await ui.act(() => lib.mutate(() => api.post<{ category: Category; library: any; checks: any }>('/library/categories', { name: `新品类 ${n}` })))
  if (r) select(r.category)
}

async function onDrop(target: Category) {
  const from = dragId.value
  dragId.value = null
  overId.value = null
  if (!from || from === target.id) return
  const ids = lib.categories.map((c) => c.id).filter((id) => id !== from)
  ids.splice(ids.indexOf(target.id), 0, from)
  await ui.act(() => lib.mutate(() => api.put('/library/categories/order', { ids })))
}

function onImportPicked(e: Event) {
  const input = e.target as HTMLInputElement
  importFile.value = input.files?.[0] ?? null
  input.value = ''
}

async function doImport(mode: 'merge' | 'replace') {
  const f = importFile.value
  if (!f) return
  importing.value = true
  const r = await ui.act(() => lib.mutate(() => api.upload<{ imported: number; library: any; checks: any }>('POST', `/library/import?mode=${mode}`, 'file', f)))
  importing.value = false
  importFile.value = null
  if (r) ui.toast(`已导入 ${r.imported} 个品类`)
}
</script>

<template>
  <div class="box cats">
    <button type="button" class="cat" :aria-selected="ui.libSel === '__global'" @click="select(null)">
      <span class="glob"><Sparkles aria-hidden="true" /></span>
      <span><span class="nm">全局提示词</span><br /><span class="ds">提取 · 贴图，所有品类共用</span></span>
    </button>
    <div class="sep"></div>
    <div v-if="!lib.categories.length" class="muted small" style="padding: 8px 10px">还没有品类，点下面「新增品类」开始</div>
    <button
      v-for="c in lib.categories"
      :key="c.id"
      type="button"
      class="cat"
      draggable="true"
      :class="{ dragover: overId === c.id && dragId !== c.id }"
      :aria-selected="ui.libSel === c.id"
      @click="select(c)"
      @dragstart="dragId = c.id"
      @dragover.prevent="overId = c.id"
      @dragleave="overId === c.id && (overId = null)"
      @drop.prevent="onDrop(c)"
      @dragend="dragId = null; overId = null"
    >
      <ImageSlot
        :state="c.styles[0]!.whiteImage ? 'image' : 'empty'"
        :img="c.styles[0]!.whiteImage ? imageUrl(c.styles[0]!.whiteImage) : null"
        :size="36"
        white
      />
      <span style="min-width: 0">
        <span class="nm">{{ c.name }}</span><br />
        <span class="ds">{{ c.styles.length }} 个款式 · {{ templateName(c) }}</span>
      </span>
      <span class="d2">
        <span v-if="dot(c)" class="dot" :class="dot(c)" :aria-label="dot(c) === 'rd' ? '有问题' : '有提醒'"></span>
      </span>
    </button>
    <div class="sep"></div>
    <div class="cfoot">
      <button type="button" class="btn sm" @click="addCategory"><Plus aria-hidden="true" />新增品类</button>
      <span class="fill"></span>
      <button type="button" class="ib" aria-label="导入模版库" title="导入模版库" @click="importInput?.click()"><Upload aria-hidden="true" /></button>
      <a class="ib" href="/api/library/export" download aria-label="导出模版库" title="导出模版库"><Download aria-hidden="true" /></a>
      <input ref="importInput" type="file" accept=".zip,application/zip" hidden @change="onImportPicked" />
    </div>
  </div>

  <template v-if="importFile">
    <div class="mask" @click="!importing && (importFile = null)"></div>
    <div class="dialog" role="dialog" aria-label="导入模版库">
      <h3>导入「{{ importFile.name }}」</h3>
      <div class="small">
        <p style="margin: 0 0 6px"><b style="font-weight: 500">合并</b>：同名品类用导入的版本整个覆盖，其他品类追加到末尾；全局提示词不变。</p>
        <p style="margin: 0"><b style="font-weight: 500">替换</b>：整个模版库换成导入的内容（当前的会先备份）。</p>
      </div>
      <div class="row">
        <button type="button" class="btn" :disabled="importing" @click="importFile = null">取消</button>
        <button type="button" class="btn" :disabled="importing" @click="doImport('replace')">替换</button>
        <button type="button" class="btn pri" :disabled="importing" @click="doImport('merge')">{{ importing ? '导入中…' : '合并' }}</button>
      </div>
    </div>
  </template>
</template>
