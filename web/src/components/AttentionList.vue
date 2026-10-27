<script setup lang="ts">
import { reactive } from 'vue'
import { useRouter } from 'vue-router'
import { Trash2 } from '@lucide/vue'
import ImageSlot from './ImageSlot.vue'
import { useJobs, STEP_NAMES } from '../stores/jobs'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import type { Job } from '../types'

const jobs = useJobs()
const lib = useLibrary()
const ui = useUi()
const router = useRouter()
const picks = reactive<Record<string, string>>({})

function canCreate(j: Job) {
  const g = j.attention?.guess?.trim()
  return !!g && !lib.categories.some((c) => c.name === g)
}

function title(j: Job) {
  const a = j.attention!
  if (a.kind === 'nomatch') return '没找到对应品类'
  if (a.kind === 'nowhite') return '缺白底图'
  if (a.kind === 'refused') return '内容被拒'
  return `${STEP_NAMES[a.step]}失败`
}

async function resolve(j: Job) {
  const v = picks[j.id]
  if (!v) return ui.toast('先选一个品类', 'warn')
  const [cid, sid] = v.split('|') as [string, string]
  const r = await ui.act(() => jobs.resolve(j.id, cid, sid))
  if (r) ui.toast(`已按「${r.job.route.styleName ? r.job.route.categoryName + ' · ' + r.job.route.styleName : r.job.route.categoryName}」放回队尾`)
}

async function createCategory(j: Job) {
  const r = await ui.act(() => jobs.createCategory(j.id))
  if (r) ui.toast(`已新建品类「${r.job.route.categoryName}」${r.job.attention?.kind === 'nowhite' ? '，上传白底图后这张图会自动继续' : ''}`)
}

async function rerecognize(j: Job) {
  const r = await ui.act(() => jobs.redo(j.id, { step: 0 }))
  if (r) ui.toast('已重新识别')
}

async function retry(j: Job) {
  const r = await ui.act(() => jobs.retry(j.id))
  if (r) ui.toast('已放回队尾')
}

async function remove(j: Job) {
  await ui.act(() => jobs.remove(j.id))
}

function goUpload(j: Job) {
  if (!j.route) return
  ui.libSel = j.route.categoryId
  ui.libStyle = j.route.styleId
  ui.libTpl = 'default'
  void router.push('/library')
}
</script>

<template>
  <div class="box">
    <div v-if="!jobs.attention.length" class="none">没有需要处理的图</div>
    <div v-for="j in jobs.attention" :key="j.id" class="exc">
      <button type="button" class="tile" aria-label="查看竞品图大图" title="点击看大图" @click="ui.view(jobs.viewItems(j), 0, { title: j.source.originalName, jobId: j.id })">
        <ImageSlot state="image" :img="jobs.fileUrl(j, 'source')" :size="48" />
      </button>
      <div class="why">
        <b>{{ title(j) }}</b> <span class="muted small">{{ j.source.originalName }}</span>
        <div class="muted small">{{ j.attention!.message }}</div>
      </div>
      <div class="fix">
        <template v-if="j.attention!.kind === 'nomatch'">
          <select :value="picks[j.id] ?? ''" aria-label="指定品类" @change="picks[j.id] = ($event.target as HTMLSelectElement).value">
            <option value="">选择品类…</option>
            <template v-for="c in lib.categories" :key="c.id">
              <option v-for="s in c.styles" :key="s.id" :value="`${c.id}|${s.id}`">{{ c.name }}{{ s.name ? ' · ' + s.name : '' }}</option>
            </template>
          </select>
          <button type="button" class="btn sm pri" @click="resolve(j)">放回队列</button>
          <button v-if="canCreate(j)" type="button" class="btn sm" @click="createCategory(j)">新建品类「{{ j.attention!.guess }}」</button>
          <button v-if="j.steps[0]!.state !== 'pending'" type="button" class="btn sm" @click="rerecognize(j)">重新识别</button>
        </template>
        <button v-else-if="j.attention!.kind === 'nowhite'" type="button" class="btn sm pri" @click="goUpload(j)">去上传白底图</button>
        <template v-else>
          <button type="button" class="btn sm pri" @click="retry(j)">重试</button>
          <button type="button" class="btn sm" @click="ui.sheet = { jobId: j.id, step: j.attention!.step }">查看详情</button>
        </template>
        <button type="button" class="ib" aria-label="删除" title="删除这张图" @click="remove(j)"><Trash2 aria-hidden="true" /></button>
      </div>
    </div>
  </div>
</template>
