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
</script>

<template>
  <section class="page">
    <DropZone />
    <QueueTabs />
    <template v-if="ui.workTab === 'queue'">
      <div v-if="jobs.attention.length" class="notice">
        <TriangleAlert aria-hidden="true" />
        <span>有 {{ jobs.attention.length }} 张图需要你处理，其余照常在跑</span>
        <button type="button" class="btn sm" @click="ui.workTab = 'attention'">去处理</button>
      </div>
      <div class="box jobs">
        <div v-if="!jobs.queued.length" class="none">队列是空的，把竞品图拖到上面就会开始</div>
        <JobRow v-for="j in jobs.queued" :key="j.id" :job="j" />
      </div>
    </template>
    <AttentionList v-else-if="ui.workTab === 'attention'" />
    <InfoTable v-else />
  </section>
</template>
