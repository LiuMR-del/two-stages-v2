<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue'
import DropZone from '../components/DropZone.vue'
import QueueTabs from '../components/QueueTabs.vue'
import JobRow from '../components/JobRow.vue'
import AttentionList from '../components/AttentionList.vue'
import InfoTable from '../components/InfoTable.vue'
import { useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'

const jobs = useJobs()
const ui = useUi()

// 列表直接取 store 里的计算结果：图跑完、重做、删掉时自动换到对应标签，数字跟着变
async function clearDone() {
  const r = await ui.act(() => jobs.clearDone())
  if (!r) return
  // 清掉后「已完成」是空的，回到未完成
  ui.workTab = 'todo'
  ui.toast(`已从队列移除 ${r.removed} 张已完成的图（输出文件不受影响）`)
}
</script>

<template>
  <section class="page">
    <DropZone />
    <QueueTabs />
    <template v-if="ui.workTab === 'todo'">
      <div v-if="jobs.attention.length" class="notice">
        <TriangleAlert aria-hidden="true" />
        <span>有 {{ jobs.attention.length }} 张图需要你处理，其余照常在跑</span>
        <button type="button" class="btn sm" @click="ui.workTab = 'attention'">去处理</button>
      </div>
      <div class="box jobs">
        <div v-if="!jobs.unfinished.length" class="none">
          <template v-if="jobs.finished.length">
            没有未完成的图，都跑完了
            <button type="button" class="btn txt sm" @click="ui.workTab = 'done'">看已完成的 {{ jobs.finished.length }} 张</button>
          </template>
          <template v-else-if="!jobs.attention.length">队列是空的，把竞品图拖到上面就会开始</template>
          <template v-else>其余的图都在「需处理」里等你</template>
        </div>
        <JobRow v-for="j in jobs.unfinished" :key="j.id" :job="j" />
      </div>
    </template>
    <div v-else-if="ui.workTab === 'done'" class="box jobs">
      <div v-if="jobs.finished.length" class="list-hd">
        <span>已完成 <i>{{ jobs.finished.length }}</i> 张</span>
        <button type="button" class="btn txt sm" title="只从队列移除，输出文件不受影响" @click="clearDone">清除已完成</button>
      </div>
      <div v-else class="none">还没有跑完的图</div>
      <JobRow v-for="j in jobs.finished" :key="j.id" :job="j" />
    </div>
    <AttentionList v-else-if="ui.workTab === 'attention'" />
    <InfoTable v-else />
  </section>
</template>

<style scoped>
/* 和下面第一张图之间的分隔线由图自己的上边线画 */
.list-hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; color: var(--sub); font-size: 12px; }
.list-hd i { font-style: normal; color: var(--tx); font-variant-numeric: tabular-nums; }
</style>
