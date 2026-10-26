<script setup lang="ts">
import { computed } from 'vue'
import { api } from '../api'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import RecipeCard, { type RecipeSlot } from './RecipeCard.vue'

const lib = useLibrary()
const ui = useUi()
const d = computed(() => lib.library!.defaults)

function saver(field: 'extractPrompt' | 'pastePrompt') {
  return async (v: string) => {
    try {
      return await lib.mutate(() => api.put<any>('/library/defaults', { [field]: v }))
    } catch (e) {
      ui.toast((e as Error).message, 'error')
      throw e
    }
  }
}

const extractSlots: RecipeSlot[] = [{ key: 'src', no: 1, role: '竞品图', sub: '上传的原图', state: 'auto', text: '竞品图\n自动填入' }]
const pasteSlots: RecipeSlot[] = [
  { key: 'white', no: 1, role: '白底图', sub: '按品类和款式自动选', state: 'auto', text: '白底图\n自动选择' },
  { key: 'pattern', no: 2, role: '素材图', sub: '第 ② 步的结果', state: 'auto', text: '素材图\n自动填入' },
]
</script>

<template>
  <div class="box">
    <div class="cd">
      <div class="cd-h">
        <div>
          <h2>全局提示词</h2>
          <div class="hint">所有品类共用。提示词里的 {品类}、{款式}、{比例} 会自动换成识别结果和款式比例；画布描述按每个款式的比例或白底图尺寸自动生成</div>
        </div>
      </div>
      <div class="rc">
        <div class="rc-h"><b>② 提取素材图</b><span class="pill">默认</span></div>
        <RecipeCard
          :slots="extractSlots"
          prefix="[Canvas: 款式比例] 第一张图片是竞品商品图。"
          :prompt="d.extractPrompt"
          scope="全局默认 · 品类可单独覆盖"
          :edit="{ raw: d.extractPrompt, save: saver('extractPrompt') }"
          :out="{ label: '素材图', state: 'auto', text: '素材图' }"
        />
      </div>
      <div class="rc">
        <div class="rc-h"><b>③ 生成主图 · 默认模版「贴图」</b></div>
        <RecipeCard
          :slots="pasteSlots"
          prefix="[Canvas: 白底图比例] 第一张图片是白底图，第二张图片是素材图。"
          :prompt="d.pastePrompt"
          scope="全局共用 · 所有品类"
          :edit="{ raw: d.pastePrompt, save: saver('pastePrompt') }"
          :out="{ label: '主图', state: 'auto', text: '主图' }"
        />
      </div>
    </div>
  </div>
</template>
