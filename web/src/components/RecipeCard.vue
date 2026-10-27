<script setup lang="ts">
import { ref } from 'vue'
import { Lock, TriangleAlert } from '@lucide/vue'
import ImageSlot, { type SlotState } from './ImageSlot.vue'
import AutoText from './AutoText.vue'
import { useUi } from '../stores/ui'

export type RecipeSlot = {
  key: string
  /** 「图 1」；不发送时为 null */
  no: number | null
  role: string
  sub?: string
  state: SlotState
  img?: string | null
  text?: string
  white?: boolean
  /** 可以上传、替换、移除 */
  editable?: boolean
  /** 原图地址，有就能点开看大图 */
  full?: string | null
}

const props = withDefaults(
  defineProps<{
    slots: RecipeSlot[]
    prefix: string
    prompt: string
    scope?: string
    /** 可编辑时给出原始提示词（含占位符）和保存函数 */
    edit?: { raw: string; save: (v: string) => Promise<unknown>; hint?: string } | null
    out?: { label: string; state: SlotState; img?: string | null; text?: string; white?: boolean; full?: string | null } | null
    warnings?: string[]
    prefixLabel?: string
  }>(),
  { scope: '', edit: null, out: null, warnings: () => [], prefixLabel: '系统自动加在最前面：' },
)
const emit = defineEmits<{ upload: [key: string, file: File]; remove: [key: string] }>()

const ui = useUi()
const editing = ref(false)
const picker = ref<HTMLInputElement | null>(null)
let pickKey = ''

function pick(key: string) {
  pickKey = key
  picker.value?.click()
}
function onPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) emit('upload', pickKey, f)
}

const OUT_KEY = '__out'
function viewAt(key: string) {
  const all = [...props.slots.map((s) => ({ key: s.key, label: s.role, full: s.state === 'image' ? s.full : null })), { key: OUT_KEY, label: props.out?.label ?? '', full: props.out?.state === 'image' ? props.out.full : null }]
  const items = all.filter((i) => i.full)
  ui.view(
    items.map((i) => ({ src: i.full!, label: i.label })),
    items.findIndex((i) => i.key === key),
  )
}
const viewable = (s: RecipeSlot) => s.state === 'image' && !!s.full
function slotClick(s: RecipeSlot) {
  if (viewable(s)) viewAt(s.key)
  else if (s.editable) pick(s.key)
}
</script>

<template>
  <div class="rcp">
    <template v-for="s in props.slots" :key="s.key">
      <div class="slot">
        <div class="no" :class="{ off: s.no === null }">{{ s.no === null ? '不发送' : '图 ' + s.no }}</div>
        <button
          v-if="viewable(s) || s.editable"
          type="button"
          class="tile"
          :aria-label="viewable(s) ? '查看' + s.role + '大图' : '上传' + s.role"
          :title="viewable(s) ? '点击看大图' : '点击选择图片，也可以把图片拖进来'"
          @click="slotClick(s)"
        >
          <ImageSlot :state="s.state" :img="s.img" :text="s.text" :white="s.white" :droppable="s.editable" @drop="(f) => emit('upload', s.key, f)" />
        </button>
        <ImageSlot v-else :state="s.state" :img="s.img" :text="s.text" :white="s.white" />
        <div class="cap">{{ s.role }}<span v-if="s.sub">{{ s.sub }}</span></div>
        <div v-if="s.editable" class="acts">
          <button type="button" class="btn txt sm" @click="pick(s.key)">{{ s.state === 'image' ? '替换' : '上传' }}</button>
          <button v-if="s.state === 'image'" type="button" class="btn txt sm rd" @click="emit('remove', s.key)">移除</button>
        </div>
      </div>
      <span class="op">+</span>
    </template>
    <div class="pbox">
      <div class="no">提示词</div>
      <div class="body">
        <div class="pre"><Lock aria-hidden="true" /><span>{{ prefixLabel }}{{ prefix }}</span></div>
        <template v-if="editing && edit">
          <AutoText :value="edit.raw" :save="edit.save" multiline :rows="6" label="提示词" placeholder="在这里写提示词" />
          <div class="muted tiny">{{ edit.hint ?? '{品类}、{款式}、{比例} 会自动替换成识别结果和款式比例' }}</div>
        </template>
        <div v-else class="txt">{{ prompt || '（提示词为空）' }}</div>
        <div class="foot">
          <span>{{ scope }}</span>
          <button v-if="edit" type="button" class="btn txt sm" @click="editing = !editing">{{ editing ? '完成' : '编辑' }}</button>
        </div>
      </div>
    </div>
    <template v-if="out">
      <span class="op">→</span>
      <div class="slot">
        <div class="no">结果</div>
        <button v-if="out.state === 'image' && out.full" type="button" class="tile" :aria-label="'查看' + out.label + '大图'" title="点击看大图" @click="viewAt(OUT_KEY)">
          <ImageSlot :state="out.state" :img="out.img" :text="out.text" :white="out.white" />
        </button>
        <ImageSlot v-else :state="out.state" :img="out.img" :text="out.text" :white="out.white" />
        <div class="cap">{{ out.label }}</div>
      </div>
    </template>
    <input ref="picker" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onPicked" />
  </div>
  <div v-for="w in warnings" :key="w" class="warn"><TriangleAlert aria-hidden="true" />{{ w }}</div>
</template>
