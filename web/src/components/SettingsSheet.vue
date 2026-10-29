<script setup lang="ts">
import { reactive, watch } from 'vue'
import { X } from '@lucide/vue'
import AutoText from './AutoText.vue'
import ParentSettings from './ParentSettings.vue'
import { useSettings } from '../stores/settings'
import { useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'

const st = useSettings()
const jobs = useJobs()
const ui = useUi()
const KINDS = ['image', 'analysis'] as const
const URL_PLACEHOLDER = 'https://example.com/v1'
const tests = reactive<Record<string, { ok: boolean; message: string } | 'running' | null>>({ image: null, analysis: null })

watch(
  () => ui.settingsOpen,
  (open) => {
    if (open) {
      tests.image = null
      tests.analysis = null
      void ui.act(() => st.load())
    }
  },
)

function saver(build: (v: string) => Record<string, unknown>) {
  return async (v: string) => {
    try {
      await st.save(build(v))
    } catch (e) {
      ui.toast((e as Error).message, 'error')
      throw e
    }
  }
}

const num = (v: string, field: string) => {
  const n = Number(v.trim())
  if (!Number.isFinite(n)) throw new Error(`${field}要填数字`)
  return n
}

type Kind = 'image' | 'analysis'

function fieldSaver(kind: Kind, field: 'baseUrl' | 'apiKey' | 'model') {
  return saver((v) => ({ [kind]: { [field]: field === 'model' ? v.trim() : v } }))
}

function intSaver(kind: Kind) {
  return saver((v) => ({ [kind]: { concurrency: Math.round(num(v, '同时处理数')) } }))
}

async function toggle(patch: Record<string, unknown>) {
  await ui.act(() => st.save(patch))
}

async function test(kind: 'image' | 'analysis') {
  ;(document.activeElement as HTMLElement | null)?.blur()
  await new Promise((r) => setTimeout(r, 50))
  tests[kind] = 'running'
  const r = await ui.act(() => st.test(kind))
  tests[kind] = r ?? null
}

function authDot(kind: 'image' | 'analysis') {
  const p = jobs.queue?.paused
  return p?.by === 'auth' && p.kind === kind ? 'rd' : ''
}
</script>

<template>
  <template v-if="ui.settingsOpen">
    <div class="mask" @click="ui.settingsOpen = false"></div>
    <aside class="sheet narrow" aria-label="设置">
      <div class="sh-h">
        <b style="font-weight: 500">设置</b>
        <button type="button" class="ib r" aria-label="关闭" @click="ui.settingsOpen = false"><X aria-hidden="true" /></button>
      </div>
      <div v-if="!st.settings" class="sh-b"><div class="none">读取中…</div></div>
      <div v-else class="sh-b">
        <div v-for="kind in KINDS" :key="kind" class="grp">
          <h4><span class="dot" :class="authDot(kind)"></span>{{ kind === 'image' ? '生图接口' : '分析接口' }}</h4>
          <div v-if="authDot(kind)" class="warn rd" style="margin: 0">{{ jobs.queue?.paused?.message }}，改好后会自动继续</div>
          <div class="fld">
            <label>地址（OpenAI 兼容，通常以 /v1 结尾）</label>
            <AutoText :value="st.settings[kind].baseUrl" :save="fieldSaver(kind, 'baseUrl')" label="地址" :placeholder="URL_PLACEHOLDER" />
          </div>
          <div class="fld">
            <label>Key</label>
            <AutoText :value="st.settings[kind].apiKey" :save="fieldSaver(kind, 'apiKey')" label="Key" placeholder="sk-..." />
          </div>
          <div class="two">
            <div class="fld">
              <label>模型</label>
              <AutoText :value="st.settings[kind].model" :save="fieldSaver(kind, 'model')" label="模型" />
            </div>
            <div class="fld">
              <label>同时处理</label>
              <AutoText :value="String(st.settings[kind].concurrency)" :save="intSaver(kind)" label="同时处理数" />
            </div>
          </div>
          <label v-if="kind === 'image'" class="sw">
            <input type="checkbox" :checked="st.settings.image.sendFidelity" @change="toggle({ image: { sendFidelity: ($event.target as HTMLInputElement).checked } })" />
            发送保真参数（quality / input_fidelity）
          </label>
          <div v-if="kind === 'image' && st.settings.image.fidelityAutoDisabled && !st.settings.image.sendFidelity" class="warn" style="margin: 0">
            中转站不支持保真参数，已自动关闭；换了中转站可以重新打开
          </div>
          <div class="row" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <button type="button" class="btn sm" :disabled="tests[kind] === 'running'" @click="test(kind)">{{ tests[kind] === 'running' ? '测试中…' : '测试连接' }}</button>
            <span v-if="tests[kind] && tests[kind] !== 'running'" class="small" :style="{ color: (tests[kind] as any).ok ? 'var(--ac)' : 'var(--rd)' }">{{ (tests[kind] as any).message }}</span>
          </div>
        </div>

        <div class="grp">
          <h4>输出</h4>
          <div class="fld">
            <label>保存到</label>
            <AutoText :value="st.settings.outputDir" :save="saver((v) => ({ outputDir: v.trim() }))" label="保存位置" />
            <div class="muted tiny">每批图一个「主图生成-日期」文件夹放在这里；点「清空队列」后，下一批依次放进「-1」「-2」…，换一天从新日期开始</div>
          </div>
          <div class="fld">
            <label>品类识别把握低于多少时交给你处理（0～1）</label>
            <AutoText :value="st.settings.routeThreshold.toFixed(2)" :save="saver((v) => ({ routeThreshold: num(v, '把握阈值') }))" label="识别把握阈值" />
          </div>
          <label class="sw"><input type="checkbox" :checked="st.settings.padSquare" @change="toggle({ padSquare: ($event.target as HTMLInputElement).checked })" />主图补成方图（只加白边）</label>
          <label class="sw"><input type="checkbox" :checked="st.settings.blankImage" @change="toggle({ blankImage: ($event.target as HTMLInputElement).checked })" />有定制项时生成空白图</label>
          <label class="sw"><input type="checkbox" :checked="st.settings.patternQc" @change="toggle({ patternQc: ($event.target as HTMLInputElement).checked })" />素材图验收（和竞品图对比文字、图案、四边、颜色、版面，不合格进「需处理」）</label>
          <label class="sw"><input type="checkbox" :checked="st.settings.mainQc" @change="toggle({ mainQc: ($event.target as HTMLInputElement).checked })" />主图验收（和素材图对比文字、图案、颜色，检查有没有铺满、露出底材）</label>
          <div v-if="st.settings.patternQc || st.settings.mainQc" class="fld">
            <label>图案相似分低于多少算不合格（0～1）</label>
            <AutoText :value="st.settings.patternQcThreshold.toFixed(2)" :save="saver((v) => ({ patternQcThreshold: num(v, '验收阈值') }))" label="图案相似分阈值" />
            <label>色差 ΔE 超过多少算不合格</label>
            <AutoText :value="String(st.settings.patternQcDeltaE)" :save="saver((v) => ({ patternQcDeltaE: num(v, '色差阈值') }))" label="色差阈值" />
            <div class="muted tiny">两道验收共用这两个阈值。素材图验收每张多发一次分析请求；主图是 AI 贴图时再多发一次，本地合成的在本地核对、不花额度。文字有任何缺、多、改都不合格。色差 ΔE 越小越严，2 左右人眼基本看不出，5 以上能看出偏色；分块比较的阈值是它的 2 倍</div>
          </div>
          <div><button type="button" class="btn sm" @click="ui.act(() => jobs.openFolder())">打开输出文件夹</button></div>
        </div>

        <div class="grp">
          <h4>SKU 命名</h4>
          <div class="muted tiny">子体 SKU = 店铺缩写-材质缩写 + 年份末位 + 地区标识 + 月日 + 专属号 + 当天序号，如 HJ-mtfl671029101。材质缩写在模版库里按品类填；每个品类每天从 01 起，输出的图也用 SKU 命名</div>
          <div class="two">
            <div class="fld">
              <label>店铺缩写</label>
              <AutoText :value="st.settings.sku.store" :save="saver((v) => ({ sku: { store: v.trim() } }))" label="店铺缩写" />
            </div>
            <div class="fld">
              <label>地区标识</label>
              <AutoText :value="st.settings.sku.region" :save="saver((v) => ({ sku: { region: v.trim() } }))" label="地区标识" />
            </div>
          </div>
          <div class="fld">
            <label>专属号（子体 SKU 和建议新建的父体 SKU 都用它）</label>
            <AutoText :value="st.settings.parent.creatorMark" :save="saver((v) => ({ parent: { creatorMark: v.trim() } }))" label="专属号" />
          </div>
        </div>

        <ParentSettings />
      </div>
    </aside>
  </template>
</template>
