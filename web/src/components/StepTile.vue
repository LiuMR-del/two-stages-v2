<script setup lang="ts">
import { computed } from 'vue'
import ImageSlot from './ImageSlot.vue'
import { useJobs, type FileKind } from '../stores/jobs'
import type { Job } from '../types'

const props = defineProps<{ job: Job; step: number; kind: FileKind; label: string }>()
/** view：已出图，看大图；open：生成中或失败，打开这一步的详情 */
const emit = defineEmits<{ open: [step: number]; view: [kind: FileKind] }>()
const jobs = useJobs()

const s = computed(() => props.job.steps[props.step]!)
const view = computed(() => {
  switch (s.value.state) {
    case 'done':
      return { state: 'image' as const, img: jobs.fileUrl(props.job, props.kind), text: '', clickable: true }
    case 'running':
      return { state: 'run' as const, img: null, text: '', clickable: true }
    case 'failed':
      return { state: 'err' as const, img: null, text: '', clickable: true }
    case 'skipped':
      return { state: 'empty' as const, img: null, text: '无需', clickable: false }
    default:
      return { state: 'empty' as const, img: null, text: '', clickable: false }
  }
})

function click() {
  if (s.value.state === 'done') emit('view', props.kind)
  else emit('open', props.step)
}
</script>

<template>
  <button
    type="button"
    class="tile"
    :disabled="!view.clickable"
    :aria-label="s.state === 'done' ? '查看' + label + '大图' : label"
    :title="s.state === 'done' ? '点击看大图' : undefined"
    @click="click"
  >
    <ImageSlot :state="view.state" :img="view.img" :text="view.text" :size="64" white />
    <span class="lb">{{ label }}</span>
  </button>
</template>
