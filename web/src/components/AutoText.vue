<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAutosave } from '../autosave'

const props = withDefaults(
  defineProps<{
    value: string
    save: (v: string) => Promise<unknown>
    multiline?: boolean
    placeholder?: string
    label?: string
    rows?: number
    /** 密钥：用密码框，截图时不露出来 */
    secret?: boolean
  }>(),
  { multiline: false, placeholder: '', label: '', rows: 4, secret: false },
)

const local = ref(props.value)
const focused = ref(false)
const saver = useAutosave(props.save)
saver.reset(props.value)

watch(
  () => props.value,
  (v) => {
    if (!focused.value) {
      local.value = v
      saver.reset(v)
    }
  },
)

function onInput(e: Event) {
  local.value = (e.target as HTMLInputElement).value
  saver.input(local.value)
}
function onBlur() {
  focused.value = false
  void saver.flush(local.value)
}
</script>

<template>
  <span class="autotext" :class="{ ml: multiline }">
    <textarea
      v-if="multiline"
      :value="local"
      :rows="rows"
      :placeholder="placeholder"
      :aria-label="label"
      @focus="focused = true"
      @input="onInput"
      @blur="onBlur"
    />
    <input v-else :type="secret ? 'password' : 'text'" autocomplete="off" :value="local" :placeholder="placeholder" :aria-label="label" @focus="focused = true" @input="onInput" @blur="onBlur" />
    <span v-if="saver.status.value === 'saved'" class="saved">已保存</span>
    <span v-else-if="saver.status.value === 'saving'" class="saved muted">保存中…</span>
    <span v-else-if="saver.status.value === 'error'" class="saved" style="color: var(--rd)">没保存上</span>
  </span>
</template>

<style scoped>
.autotext { display: inline-flex; align-items: center; gap: 6px; }
.autotext.ml { display: flex; flex-direction: column; align-items: stretch; gap: 4px; width: 100%; }
.autotext.ml .saved { align-self: flex-end; }
</style>
