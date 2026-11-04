<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import AutoText from './AutoText.vue'
import ParentSettings from './ParentSettings.vue'
import StoresSettings from './StoresSettings.vue'
import Help from './Help.vue'
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

/** 分页签（2026-11-04 用户要求整理设置页面）：一次只看一类；页签上的点表示那一类有要处理的 */
type Tab = 'api' | 'output' | 'stores' | 'parent'
const tab = ref<Tab>('api')
const TABS: { id: Tab; label: string }[] = [
  { id: 'api', label: '接口' },
  { id: 'output', label: '生成与验收' },
  { id: 'stores', label: '店铺' },
  { id: 'parent', label: '父体匹配' },
]
const tabDot = computed<Record<Tab, '' | 'am' | 'rd'>>(() => {
  const s = st.settings
  const apiBad = KINDS.some((k) => authDot(k))
  const apiMissing = !!s && KINDS.some((k) => !s[k].baseUrl || !s[k].apiKey)
  const storeMissing = !!s && s.stores.some((x) => !(x.spapi.sellerId && x.spapi.clientId && x.spapi.clientSecret && x.spapi.refreshToken))
  return {
    api: apiBad ? 'rd' : apiMissing ? 'am' : '',
    output: '',
    stores: storeMissing ? 'am' : '',
    parent: jobs.queue?.parentPaused ? 'rd' : '',
  }
})

function authDot(kind: 'image' | 'analysis') {
  const p = jobs.queue?.paused
  return p?.by === 'auth' && p.kind === kind ? 'rd' : ''
}
</script>

<template>
  <template v-if="ui.settingsOpen">
    <div class="mask" @click="ui.settingsOpen = false"></div>
    <aside class="sheet settings" aria-label="设置">
      <div class="sh-h">
        <b style="font-weight: 500">设置</b>
        <button type="button" class="ib r" aria-label="关闭" @click="ui.settingsOpen = false"><X aria-hidden="true" /></button>
      </div>
      <div class="tabs">
        <div class="seg" role="tablist" aria-label="设置分类">
          <button v-for="t in TABS" :key="t.id" type="button" role="tab" :aria-selected="tab === t.id" @click="tab = t.id">
            {{ t.label }}<span v-if="tabDot[t.id]" class="dot" :class="tabDot[t.id]" aria-hidden="true"></span>
          </button>
        </div>
        <div v-if="jobs.queue?.parentPaused && tab !== 'parent'" class="warn rd" style="margin: 0">匹配父体暂停：{{ jobs.queue.parentPaused }}</div>
      </div>
      <div v-if="!st.settings" class="sh-b"><div class="none">读取中…</div></div>

      <div v-else-if="tab === 'api'" class="sh-b">
        <div v-for="kind in KINDS" :key="kind" class="grp">
          <h4>
            <span class="dot" :class="authDot(kind) || (!st.settings[kind].baseUrl || !st.settings[kind].apiKey ? 'am' : '')"></span>{{ kind === 'image' ? '生图接口' : '分析接口' }}
            <span class="sp"></span>
            <button type="button" class="btn sm" :disabled="tests[kind] === 'running'" @click="test(kind)">{{ tests[kind] === 'running' ? '测试中…' : '测试连接' }}</button>
          </h4>
          <div v-if="tests[kind] && tests[kind] !== 'running'" class="small" :style="{ color: (tests[kind] as any).ok ? 'var(--ac)' : 'var(--rd)' }">{{ (tests[kind] as any).message }}</div>
          <div v-if="authDot(kind)" class="warn rd" style="margin: 0">{{ jobs.queue?.paused?.message }}，改好后会自动继续</div>
          <div class="fld">
            <label class="lbl">地址<Help label="地址">OpenAI 兼容的中转站地址，通常以 /v1 结尾。生图和分析可以用同一个中转站。</Help></label>
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
          <template v-if="kind === 'image'">
            <label class="sw">
              <input type="checkbox" :checked="st.settings.image.sendFidelity" @change="toggle({ image: { sendFidelity: ($event.target as HTMLInputElement).checked } })" />
              发送保真参数
              <Help label="保真参数">请求里带 quality / input_fidelity。有的中转站不认这两个参数，工具会自动关掉；换了中转站可以重新打开。</Help>
            </label>
            <div v-if="st.settings.image.fidelityAutoDisabled && !st.settings.image.sendFidelity" class="warn" style="margin: 0">中转站不支持保真参数，已自动关闭</div>
          </template>
        </div>
      </div>

      <div v-else-if="tab === 'output'" class="sh-b">
        <div class="grp">
          <h4>输出<span class="sp"></span><button type="button" class="btn sm" @click="ui.act(() => jobs.openFolder())">打开输出文件夹</button></h4>
          <div class="fld">
            <label class="lbl">保存到<Help label="保存位置">每批图一个「主图生成-日期」文件夹放在这里；点「清空队列」后，下一批依次放进「-1」「-2」…，换一天从新日期开始。</Help></label>
            <AutoText :value="st.settings.outputDir" :save="saver((v) => ({ outputDir: v.trim() }))" label="保存位置" />
          </div>
        </div>
        <div class="grp">
          <h4>生成</h4>
          <div class="fld">
            <label class="lbl">品类识别把握低于多少交给你处理（0～1）</label>
            <AutoText :value="st.settings.routeThreshold.toFixed(2)" :save="saver((v) => ({ routeThreshold: num(v, '把握阈值') }))" label="识别把握阈值" />
          </div>
          <label class="sw"><input type="checkbox" :checked="st.settings.padSquare" @change="toggle({ padSquare: ($event.target as HTMLInputElement).checked })" />主图补成方图（只加白边）</label>
          <label class="sw"><input type="checkbox" :checked="st.settings.blankImage" @change="toggle({ blankImage: ($event.target as HTMLInputElement).checked })" />有定制项时生成空白图</label>
        </div>
        <div class="grp">
          <h4>
            验收
            <Help label="验收">
              素材图验收：和竞品图对比文字、图案、四边、颜色、版面，每张多发一次分析请求。主图验收：和素材图对比文字、图案、颜色，检查有没有铺满、露出底材；AI 贴图时多发一次请求，本地合成的在本地核对、不花额度。不合格的进「需处理」。
            </Help>
          </h4>
          <label class="sw"><input type="checkbox" :checked="st.settings.patternQc" @change="toggle({ patternQc: ($event.target as HTMLInputElement).checked })" />素材图验收</label>
          <label class="sw"><input type="checkbox" :checked="st.settings.mainQc" @change="toggle({ mainQc: ($event.target as HTMLInputElement).checked })" />主图验收</label>
          <div v-if="st.settings.patternQc || st.settings.mainQc" class="two">
            <div class="fld">
              <label>图案相似分低于（0～1）</label>
              <AutoText :value="st.settings.patternQcThreshold.toFixed(2)" :save="saver((v) => ({ patternQcThreshold: num(v, '验收阈值') }))" label="图案相似分阈值" />
            </div>
            <div class="fld">
              <label class="lbl">色差 ΔE 超过<Help label="色差">越小越严：2 左右人眼基本看不出，5 以上能看出偏色；分块比较的阈值是它的 2 倍。两道验收共用这两个阈值，文字有任何缺、多、改都不合格。</Help></label>
              <AutoText :value="String(st.settings.patternQcDeltaE)" :save="saver((v) => ({ patternQcDeltaE: num(v, '色差阈值') }))" label="色差阈值" />
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="tab === 'stores'" class="sh-b">
        <StoresSettings />
      </div>

      <div v-else class="sh-b">
        <ParentSettings />
      </div>
    </aside>
  </template>
</template>

<style scoped>
.sheet.settings { width: min(460px, 100%); }
.tabs { padding: 12px 20px 0; display: grid; gap: 8px; }
.tabs .seg { width: 100%; }
.tabs .seg button { flex: 1; justify-content: center; padding: 5px 8px; }
.grp h4 .sp { flex: 1; }
.lbl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sw { flex-wrap: wrap; }
</style>
