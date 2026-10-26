<script setup lang="ts">
import { useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'

const jobs = useJobs()
const ui = useUi()

async function clearDone() {
  const r = await ui.act(() => jobs.clearDone())
  if (r) ui.toast(`已从队列移除 ${r.removed} 张已完成的图（输出文件不受影响）`)
}
</script>

<template>
  <div class="bar">
    <div class="seg" role="tablist" aria-label="视图">
      <button type="button" role="tab" :aria-selected="ui.workTab === 'queue'" @click="ui.workTab = 'queue'">队列 <span class="n">{{ jobs.queued.length }}</span></button>
      <button type="button" role="tab" :aria-selected="ui.workTab === 'attention'" @click="ui.workTab = 'attention'">
        需处理 <span class="n" :class="{ am: jobs.attention.length > 0 }">{{ jobs.attention.length }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="ui.workTab === 'info'" @click="ui.workTab = 'info'">识别信息 <span class="n">{{ jobs.withInfo.length }}</span></button>
    </div>
    <div class="sum" aria-live="polite">
      <span>进行中 <i>{{ jobs.runningCount }}</i></span>
      <span>完成 <i>{{ jobs.finished.length }}</i></span>
      <span v-if="jobs.queue">生图 <i>{{ jobs.queue.slots.image.busy }}/{{ jobs.queue.slots.image.limit }}</i> · 分析 <i>{{ jobs.queue.slots.analysis.busy }}/{{ jobs.queue.slots.analysis.limit }}</i></span>
      <button v-if="jobs.finished.length" type="button" class="btn txt sm" @click="clearDone">清除已完成</button>
    </div>
  </div>
</template>
