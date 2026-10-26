<script setup lang="ts">
import { ref, watch } from 'vue'
import { LoaderCircle, X } from '@lucide/vue'

export type SlotState = 'image' | 'auto' | 'empty' | 'run' | 'err'

const props = withDefaults(
  defineProps<{
    state: SlotState
    img?: string | null
    text?: string
    size?: number
    white?: boolean
    /** 允许拖图上传 */
    droppable?: boolean
  }>(),
  { img: null, text: '', size: 120, white: false, droppable: false },
)
const emit = defineEmits<{ drop: [file: File] }>()
const over = ref(false)
const broken = ref(false)
watch(
  () => props.img,
  () => (broken.value = false),
)

function onDrop(e: DragEvent) {
  over.value = false
  if (!props.droppable) return
  const f = e.dataTransfer?.files?.[0]
  if (f) emit('drop', f)
}
</script>

<template>
  <div
    class="ph"
    :class="[state === 'image' ? (white ? 'w' : '') : state, { drag: over }]"
    :style="{ width: size + 'px', height: size + 'px' }"
    @dragover.prevent="droppable && (over = true)"
    @dragleave="over = false"
    @drop.prevent="onDrop"
  >
    <span v-if="state === 'image' && img && broken" class="ph-text muted">图片已不在</span>
    <img v-else-if="state === 'image' && img" :src="img" alt="" loading="lazy" @error="broken = true" />
    <LoaderCircle v-else-if="state === 'run'" class="spin" aria-hidden="true" />
    <template v-else-if="state === 'err'">
      <span v-if="text" style="font-size: 11px">{{ text }}</span>
      <X v-else aria-hidden="true" />
    </template>
    <span v-else-if="text" class="ph-text">{{ text }}</span>
  </div>
</template>

<style scoped>
.ph-text { text-align: center; font-size: 11px; line-height: 1.4; white-space: pre-line; padding: 4px; }
</style>
