<script setup lang="ts">
import { ref } from 'vue'

/** 「?」：长说明默认收起，点一下展开（设置页面整理，2026-11-04） */
defineProps<{ label?: string }>()
const open = ref(false)
</script>

<template>
  <span class="help">
    <button type="button" class="q" :aria-expanded="open" :aria-label="label ? `${label}的说明` : '说明'" @click="open = !open">?</button>
    <span v-if="open" class="txt muted tiny"><slot /></span>
  </span>
</template>

<style scoped>
.help { display: contents; }
.q {
  width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--hair); background: var(--sf);
  font-size: 10px; line-height: 14px; padding: 0; color: var(--sub); cursor: pointer; flex: none;
}
.q[aria-expanded="true"] { border-color: var(--ac); color: var(--ac); }
.txt { flex-basis: 100%; display: block; line-height: 1.6; }
</style>
