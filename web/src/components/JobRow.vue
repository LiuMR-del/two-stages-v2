<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Pause, Play, Trash2 } from '@lucide/vue'
import ImageSlot from './ImageSlot.vue'
import StepTile from './StepTile.vue'
import { useJobs, type FileKind } from '../stores/jobs'
import { activeTemplateName, useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import type { Job } from '../types'
import { useConfirmTwice } from '../confirmTwice'

const props = defineProps<{ job: Job }>()
const jobs = useJobs()
const lib = useLibrary()
const ui = useUi()

const label = computed(() => {
  const r = props.job.route
  return r ? (r.styleName ? `${r.categoryName} · ${r.styleName}` : r.categoryName) : ''
})
const templateName = computed(() => {
  if (props.job.plan) return props.job.plan.main.templateName
  const r = props.job.route
  const c = lib.category(r?.categoryId)
  if (!c) return ''
  return activeTemplateName(c.styles.find((s) => s.id === r!.styleId))
})
const dot = computed(() => ({ queued: 'dot gr', paused: 'dot gr', running: 'dot bl', attention: 'dot am', done: 'dot' })[props.job.view.phase])
const canPause = computed(() => props.job.view.phase === 'queued' || props.job.view.phase === 'running')

async function pause() {
  await ui.act(() => jobs.pauseJob(props.job.id))
}
async function resume() {
  await ui.act(() => jobs.resumeJob(props.job.id))
}
/** 删除点两次：第一次图标变红，几秒内再点才删 */
const { armed: confirmDel, click: remove } = useConfirmTwice(() => ui.act(() => jobs.remove(props.job.id)))

function open(step: number) {
  ui.sheet = { jobId: props.job.id, step }
}
function view(kind: FileKind) {
  const items = jobs.viewItems(props.job)
  ui.view(items, items.findIndex((i) => i.kind === kind), { title: props.job.source.originalName, jobId: props.job.id })
}
function defaultStep() {
  const v = props.job.view
  if (v.runningStep !== null) return v.runningStep
  if (props.job.attention) return props.job.attention.step
  if (v.phase === 'done') return 2
  const i = props.job.steps.findIndex((s) => s.state !== 'done' && s.state !== 'skipped')
  return Math.max(0, i - 1)
}
</script>

<template>
  <div class="job">
    <div class="src">
      <button type="button" class="tile" aria-label="查看竞品图大图" title="点击看大图" @click="view('source')">
        <ImageSlot state="image" :img="jobs.fileUrl(job, 'source')" :size="56" />
      </button>
      <div style="min-width: 0">
        <div class="nm" :title="job.source.originalName">{{ job.source.originalName }}</div>
        <div class="meta">
          <template v-if="job.route">
            <span class="pill ac">{{ label }}</span>
            <span v-if="templateName" class="pill">{{ templateName }}</span>
          </template>
          <span v-else-if="job.steps[0]!.state === 'running'" class="pill bl">识别品类中…</span>
          <span v-else class="pill">待识别</span>
        </div>
      </div>
    </div>
    <div class="flow">
      <StepTile :job="job" :step="1" kind="pattern" label="素材图" @open="open" @view="view" />
      <span class="arr">→</span>
      <StepTile :job="job" :step="2" kind="main" label="主图" @open="open" @view="view" />
      <span class="arr">→</span>
      <StepTile :job="job" :step="4" kind="blank" label="空白图" @open="open" @view="view" />
    </div>
    <div style="display: flex; align-items: center; gap: 2px">
      <span class="st" style="margin-right: auto" :class="{ muted: job.view.phase === 'queued' || job.view.phase === 'paused' }"><span :class="dot"></span>{{ job.view.label }}</span>
      <button v-if="job.view.phase === 'paused'" type="button" class="ib sm" aria-label="继续" title="继续这张图，从停下的那一步接着跑" @click="resume"><Play aria-hidden="true" /></button>
      <button v-else-if="canPause" type="button" class="ib sm" aria-label="暂停" :title="job.view.phase === 'running' ? '暂停这张图：正在跑的这一步会中止，继续时从这一步重新开始' : '暂停这张图，轮到它时先跳过'" @click="pause"><Pause aria-hidden="true" /></button>
      <button type="button" class="ib sm" :class="{ del: confirmDel }" :aria-label="confirmDel ? '再点一次删除' : '删除'" :title="confirmDel ? '再点一次删除：连同已经生成的素材图、主图、空白图和 CSV 里这一行一起删' : '从队列删除这张图'" @click="remove"><Trash2 aria-hidden="true" /></button>
      <button type="button" class="ib sm" aria-label="查看详情" @click="open(defaultStep())"><ChevronRight aria-hidden="true" /></button>
    </div>
  </div>
</template>
