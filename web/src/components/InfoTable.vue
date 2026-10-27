<script setup lang="ts">
import { ref } from 'vue'
import { Copy, Download } from '@lucide/vue'
import ImageSlot from './ImageSlot.vue'
import { useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'
import type { Job } from '../types'

const jobs = useJobs()
const ui = useUi()

function viewMain(j: Job) {
  const items = jobs.viewItems(j)
  ui.view(items, items.findIndex((i) => i.kind === 'main'), { title: j.source.originalName, jobId: j.id })
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const day = ref(today())

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  ui.toast('已复制')
}
</script>

<template>
  <div class="box">
    <div style="display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 10px 14px 0; flex-wrap: wrap">
      <span class="muted small">按天导出</span>
      <input v-model="day" type="date" aria-label="导出日期" />
      <a class="btn sm" :href="`/api/info.csv?day=${day}`" download><Download aria-hidden="true" />导出 CSV</a>
    </div>
    <div style="overflow-x: auto">
      <table class="tbl">
        <thead>
          <tr><th>主图</th><th>场景</th><th>搜索关键词</th><th>可定制项</th></tr>
        </thead>
        <tbody>
          <tr v-if="!jobs.withInfo.length"><td colspan="4" class="none">主图生成后，这里汇总每张图的场景、关键词和可定制项</td></tr>
          <tr v-for="j in jobs.withInfo" :key="j.id">
            <td>
              <button type="button" class="tile" :aria-label="'查看 ' + j.source.originalName + ' 的主图大图'" title="点击看大图" @click="viewMain(j)">
                <ImageSlot state="image" :img="jobs.fileUrl(j, 'main')" :size="44" white />
              </button>
            </td>
            <td>{{ j.info!.scene }}<button type="button" class="cp" aria-label="复制场景" @click="copy(j.info!.scene)"><Copy aria-hidden="true" /></button></td>
            <td>
              <div class="kw">
                <span v-for="k in j.info!.keywords" :key="k" class="pill">{{ k }}</span>
                <button type="button" class="cp" aria-label="复制关键词" @click="copy(j.info!.keywords.join(', '))"><Copy aria-hidden="true" /></button>
              </div>
            </td>
            <td>
              {{ j.info!.customizable.length ? j.info!.customizable.join('，') : '无' }}
              <button v-if="j.info!.customizable.length" type="button" class="cp" aria-label="复制可定制项" @click="copy(j.info!.customizable.join('，'))"><Copy aria-hidden="true" /></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
