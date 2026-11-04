<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderOpen, RotateCcw, Search, TriangleAlert, X, Copy } from '@lucide/vue'
import ImageSlot, { type SlotState } from './ImageSlot.vue'
import RecipeCard, { type RecipeSlot } from './RecipeCard.vue'
import { useJobs, STEP_NAMES, PARENT_STEP, type FileKind } from '../stores/jobs'
import { activeTemplateName, useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { imageUrl } from '../api'
import { api } from '../api'
import type { Job } from '../types'

const jobs = useJobs()
const lib = useLibrary()
const settings = useSettings()
const ui = useUi()

const job = computed<Job | undefined>(() => (ui.sheet ? jobs.byId[ui.sheet.jobId] : undefined))
const step = computed(() => ui.sheet?.step ?? 0)
const rec = computed(() => job.value?.steps[step.value])
const label = computed(() => {
  const r = job.value?.route
  return r ? (r.styleName ? `${r.categoryName} · ${r.styleName}` : r.categoryName) : '品类待识别'
})

watch(
  () => job.value,
  (j) => {
    if (ui.sheet && !j) ui.sheet = null
  },
)

const DOT: Record<string, string> = { done: 'dot', running: 'dot bl', failed: 'dot rd', skipped: 'dot gr', pending: 'dot gr' }
const OUT_KIND: Record<number, FileKind> = { 1: 'pattern', 2: 'main', 4: 'blank' }

function imgFor(j: Job, role: string, sha: string, thumb = true): string {
  if (role === '竞品图') return jobs.fileUrl(j, 'source', thumb)
  if (role === '印刷面') return jobs.fileUrl(j, 'face', thumb)
  if (role === '素材图') return jobs.fileUrl(j, 'pattern', thumb)
  if (role === '主图') return jobs.fileUrl(j, 'main', thumb)
  return imageUrl(sha, thumb)
}

const recipe = computed(() => {
  const j = job.value
  const r = rec.value
  if (!j || !r?.snapshot || ![1, 2, 4].includes(step.value)) return null
  const slots: RecipeSlot[] = r.snapshot.images.map((im) => ({
    key: String(im.no),
    no: im.no,
    role: im.role,
    sub:
      im.role === '素材图'
        ? '第 ② 步的结果'
        : im.role === '主图'
          ? '第 ③ 步的结果'
          : im.role === '竞品图'
            ? j.source.originalName
            : im.role === '印刷面'
              ? '从竞品图裁出并拉正'
              : '开始生成时记录',
    state: 'image',
    img: imgFor(j, im.role, im.sha256),
    full: imgFor(j, im.role, im.sha256, false),
    white: im.role !== '竞品图',
  }))
  const kind = OUT_KIND[step.value]!
  let out: { label: string; state: SlotState; img?: string | null; text?: string; white?: boolean; full?: string }
  // 素材图没过验收、或提取完正在验收：素材图已经有了
  // 没过验收、或生成完正在验收：结果图已经有了
  const pendingQc = step.value === 1 ? j.qc : step.value === 2 ? j.mainQc : null
  const hasPattern = (j.attention?.kind === 'qc' && j.attention.step === step.value) || pendingQc?.state === 'pending'
  if (r.state === 'done' || hasPattern) out = { label: '', state: 'image', img: jobs.fileUrl(j, kind), full: jobs.fileUrl(j, kind, false), white: true }
  else if (r.state === 'running') out = { label: '生成中', state: 'run' }
  else if (r.state === 'failed') out = { label: '失败', state: 'err', text: '失败' }
  else out = { label: '等待', state: 'empty' }
  out.label = { 1: '素材图', 2: '主图', 4: '空白图' }[step.value] ?? out.label
  if (r.snapshot.mode === 'local') {
    const p = r.snapshot.params ?? {}
    return { slots, prefix: `${r.snapshot.prompt}（${String(p.why ?? '')}）`, prompt: `${String(p.fit ?? '')}；${String(p.shape ?? '')}`, out, local: true }
  }
  return { slots, prefix: r.snapshot.prefix, prompt: r.snapshot.prompt, out, local: false }
})

function colorText(q: NonNullable<Job['qc']>): string {
  const c = q.color
  if (!c) return '—'
  if (!c.checked) return c.note ?? '没检查'
  const s = c.shift!
  const sign = (v: number) => (v > 0 ? '+' : '') + v
  const head = c.issues.length ? c.issues.join('；') : `和竞品图一致（ΔE ${c.deltaE}，分块 ${c.gridDeltaE}，阈值 ${c.threshold ?? 5}，分块 ×2）`
  return `${head}；素材图比竞品图：亮度 ${sign(s.L)}、红绿 ${sign(s.a)}、黄蓝 ${sign(s.b)}、鲜艳度 ${sign(s.C)}`
}

function borderText(b: NonNullable<NonNullable<Job['qc']>['border']>): string {
  if (b.error) return `没检查成（${b.error}），不拦`
  if (!b.hasBorder) return '没有一圈格子边框，不用查'
  const n = (s: Record<string, number> | null) => (s ? `上 ${s.top ?? '?'}、下 ${s.bottom ?? '?'}、左 ${s.left ?? '?'}、右 ${s.right ?? '?'}` : '?')
  return `${b.overflow || '没有往外延伸'}（格子数仅供参考：竞品图 ${n(b.source)}；素材图 ${n(b.pattern)}）`
}

async function shift(delta: 1 | -1) {
  await ui.act(() => jobs.shiftParent(job.value!.id, delta))
}

const PARENT_STATUS: Record<string, string> = { matched: '已匹配', unsure: '待确认', none: '没有合适的父体', new: '建议新建' }
const parentPickBusy = ref(false)
const parentSearchOpen = ref(false)
const parentSearchBusy = ref(false)
const parentSearch = ref<{ title: string; rows: { tab: string; sku: string; asin: string; theme: string }[]; failed: { tab: string; message: string }[]; tabs?: string[] } | null>(null)
/** 搜索的范围：飞书来源是标签页，店铺来源是商品类型（搜过一次后从结果里拿） */
const parentTabs = computed(() => (settings.currentStore?.parentSource === 'store' ? (parentSearch.value?.tabs ?? []) : (settings.currentStore?.feishu.tabs ?? [])))
const parentTab = ref('')

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  ui.toast('已复制')
}
async function pickParent(sku: string) {
  if (!job.value) return
  parentPickBusy.value = true
  const r = await ui.act(() => jobs.setParent(job.value!.id, sku))
  parentPickBusy.value = false
  if (r) ui.toast('已切换父体，变体名已重新计算')
}
async function searchParents() {
  parentSearchBusy.value = true
  const r = await ui.act(() =>
    api.get<{ title: string; rows: { tab: string; sku: string; asin: string; theme: string }[]; failed: { tab: string; message: string }[]; tabs?: string[] }>(`/parent/rows${parentTab.value ? `?tab=${encodeURIComponent(parentTab.value)}` : ''}`),
  )
  // 店铺来源按商品类型筛过后，下拉里仍保留所有商品类型
  if (r && parentSearch.value?.tabs && !r.tabs?.length) r.tabs = parentSearch.value.tabs
  parentSearch.value = r ?? null
  parentSearchBusy.value = false
}
const QC_STATE: Record<string, string> = { pending: '等待验收', pass: '验收合格', fail: '没过验收', bypassed: '没过验收，已选择仍然使用' }
const qc = computed(() => (step.value === 1 ? (job.value?.qc ?? null) : step.value === 2 ? (job.value?.mainQc ?? null) : null))
const isMain = computed(() => step.value === 2)
const qcSlots = computed<RecipeSlot[]>(() => {
  const j = job.value
  const s = qc.value?.snapshot
  if (!j || !s) return []
  return s.images.map((im) => ({
    key: 'qc' + im.no,
    no: im.no,
    role: im.role,
    sub: '缩小后的 JPEG',
    state: 'image' as const,
    img: imgFor(j, im.role, im.sha256),
    full: imgFor(j, im.role, im.sha256, false),
    white: im.role !== '竞品图',
  }))
})

// ---- 重做 ----
const redoOpen = ref(false)
const redoText = ref('')
const redoPick = ref('')
/** 第②步重做时改按整张竞品图提取（第①步给的印刷面区域不对时用） */
const redoWhole = ref(false)
const busy = ref(false)

function prefill(): string {
  const j = job.value!
  const r = rec.value!
  if (j.override?.step === step.value) return j.override.prompt
  if (r.snapshot) return r.snapshot.prompt
  if (step.value === 1) return j.plan?.extractPrompt ?? ''
  if (step.value === 2) return j.plan?.main.prompt ?? ''
  return ''
}

watch([() => ui.sheet?.jobId, step], () => {
  redoOpen.value = false
})

// 从「需处理」点「重新提取」进来时直接展开重做
watch(
  () => ui.sheet?.redo,
  (r) => {
    if (!r || !ui.sheet) return
    ui.sheet.redo = false
    if (job.value && canRedo.value) openRedo()
  },
  { flush: 'post' },
)

function openRedo() {
  redoText.value = prefill()
  redoPick.value = ''
  redoWhole.value = false
  redoOpen.value = true
}

const canRedo = computed(() => !!rec.value && ['done', 'skipped', 'failed'].includes(rec.value.state))
const downstream = computed(() => STEP_NAMES.slice(step.value + 1).join('、'))
/** 第 6 步重做 = 重新读表、重新问 AI */
const isParent = computed(() => step.value === PARENT_STEP)

async function confirmRedo() {
  const j = job.value!
  const body: { step: number; prompt?: string; categoryId?: string; styleId?: string; wholePhoto?: boolean } = { step: step.value }
  if (step.value === 1 && redoWhole.value) body.wholePhoto = true
  if (step.value === 0) {
    if (redoPick.value) {
      const [cid, sid] = redoPick.value.split('|')
      body.categoryId = cid
      body.styleId = sid
    }
  } else if (recipe.value?.local || isParent.value) {
    // 本地合成没有提示词
  } else if (redoText.value.trim() && redoText.value !== prefill()) {
    body.prompt = redoText.value
  } else if (step.value === 4 && !redoText.value.trim() && !j.info?.blankItemsEn.length) {
    ui.toast('这张图没有需要留空的内容；要生成空白图，请写上提示词', 'warn')
    return
  }
  busy.value = true
  const r = await ui.act(() => jobs.redo(j.id, body))
  busy.value = false
  if (r) {
    redoOpen.value = false
    ui.toast(`已重做「${STEP_NAMES[step.value]}」${step.value < PARENT_STEP ? '，后面的步骤会自动跟上' : ''}`)
  }
}

const nextTemplate = computed(() => {
  const j = job.value
  if (!j?.route) return ''
  if (j.plan) return j.plan.main.templateName
  const c = lib.category(j.route.categoryId)
  if (!c) return ''
  return activeTemplateName(c.styles.find((s) => s.id === j.route!.styleId))
})

async function openFolder() {
  await ui.act(() => jobs.openFolder(job.value!.id))
}
</script>

<template>
  <template v-if="job && ui.sheet">
    <div class="mask" @click="ui.sheet = null"></div>
    <aside class="sheet" aria-label="图片详情">
      <div class="sh-h">
        <button type="button" class="tile" aria-label="查看竞品图大图" title="点击看大图" @click="ui.view(jobs.viewItems(job), 0, { title: job.source.originalName, jobId: job.id })">
          <ImageSlot state="image" :img="jobs.fileUrl(job, 'source')" :size="40" />
        </button>
        <div style="min-width: 0">
          <b style="font-weight: 500; word-break: break-all">{{ job.source.originalName }}</b>
          <div class="muted small">{{ label }}</div>
        </div>
        <button type="button" class="ib r" aria-label="关闭" @click="ui.sheet = null"><X aria-hidden="true" /></button>
      </div>
      <div class="sh-b">
        <div class="steps" role="tablist">
          <button v-for="(n, i) in STEP_NAMES" :key="i" type="button" role="tab" :aria-selected="step === i" @click="ui.sheet = { jobId: job.id, step: i }">
            <span :class="DOT[job.steps[i]!.state]"></span>{{ i + 1 }} {{ n }}
          </button>
        </div>

        <div v-if="job.attention && job.attention.step === step" class="warn" :class="{ rd: job.attention.kind === 'failed' || job.attention.kind === 'refused' }" style="margin-top: 0">
          <TriangleAlert aria-hidden="true" />{{ job.attention.message }}
        </div>
        <div v-else-if="rec?.error && rec.state !== 'done'" class="warn" style="margin-top: 0"><TriangleAlert aria-hidden="true" />{{ rec.error }}</div>

        <!-- ① 识别品类 -->
        <template v-if="step === 0">
          <div v-if="rec!.state === 'running'" class="none">分析模型正在对照模版库判断品类…</div>
          <dl v-else-if="job.route && rec!.state === 'done'" class="kv">
            <dt>品类</dt>
            <dd>
              <span class="pill ac">{{ label }}</span>
              <span class="muted small"> {{ job.route.confidence !== null ? '置信度 ' + job.route.confidence.toFixed(2) : '手动指定' }}</span>
            </dd>
            <template v-if="job.route.reason"><dt>判断理由</dt><dd>{{ job.route.reason }}</dd></template>
            <dt>接下来</dt>
            <dd>用「{{ nextTemplate }}」生成主图，素材比例 {{ job.route.ratio }}</dd>
            <dt>印刷面</dt>
            <dd>
              <template v-if="job.face">
                <div class="face">
                  <img :src="jobs.fileUrl(job, 'source', false)" alt="竞品图" />
                  <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <polygon :points="job.face.ai.map((p) => p.join(',')).join(' ')" class="ai" />
                    <polygon :points="job.face.corners.map((p) => p.join(',')).join(' ')" class="fix" />
                  </svg>
                </div>
                <div class="muted tiny">
                  实线是用来提取的区域（约 {{ job.face.size.width }}×{{ job.face.size.height }} 像素），虚线是 AI 给的位置；上、右、下、左四条边分别往外校正了 {{ job.face.moved.join('、') }} 像素，再多留一点余量。第 ② 步只把这块拉正后发给生图模型；框得不对可以在第 ② 步重做时改按整张图提取。
                </div>
              </template>
              <span v-else-if="job.deformed" class="muted small">AI 判断竞品图里的商品放在场景里有变形（搭着、折叠、起褶或被遮住），不框选：第 ② 步把整张竞品图交给生图模型，让它自己提取并矫正成平面设计图</span>
              <span v-else class="muted small">AI 没给出印刷面的位置，第 ② 步按整张竞品图提取</span>
            </dd>
          </dl>
          <div v-else-if="rec!.state === 'pending'" class="none">排队等待识别</div>
        </template>

        <!-- ⑥ 匹配父体（完整的候选切换、复制、搜索在第四段） -->
        <template v-else-if="step === 5">
          <div v-if="rec!.state === 'skipped'" class="none">{{ rec!.note || '这张图没有匹配父体' }}</div>
          <div v-else-if="rec!.state === 'running'" class="none">正在读飞书父体表、查店铺…</div>
          <div v-else-if="rec!.state === 'pending'" class="none">
            {{ rec!.error || (jobs.queue?.parentPaused && job.steps[4]!.state !== 'pending' ? `匹配父体暂停：${jobs.queue.parentPaused}` : '等待前面的步骤完成') }}
          </div>
          <div v-else-if="job.parent" class="pres">
            <!-- 结论：父体、下一个变体名（2026-11-04 用户要求精简：依据都收进「为什么是这个」） -->
            <div class="line">
              <span class="pill" :class="{ ac: job.parent.status === 'matched', am: job.parent.status === 'unsure', bl: job.parent.status === 'new' }">{{ PARENT_STATUS[job.parent.status] }}</span>
              <template v-if="job.parent.sku">
                <b class="name">{{ job.parent.sku }}</b><button type="button" class="cp" aria-label="复制父体 SKU" @click="copy(job.parent.sku)"><Copy aria-hidden="true" /></button>
                <span class="muted small">{{ [job.parent.theme, job.parent.asin || (job.parent.status === 'new' ? '店里还没有，要手动创建' : '')].filter(Boolean).join(' · ') }}</span>
              </template>
            </div>
            <div v-if="job.parent.message" class="muted small">{{ job.parent.message }}</div>
            <div v-if="job.parent.naming" class="line">
              <span class="muted small">下一个变体名</span>
              <b class="name">{{ job.parent.naming.next ?? '需要手动起名' }}</b>
              <button v-if="job.parent.naming.next" type="button" class="cp" aria-label="复制推荐变体名" @click="copy(job.parent.naming.next)"><Copy aria-hidden="true" /></button>
              <template v-if="job.parent.naming.number !== null">
                <button type="button" class="btn txt sm" aria-label="变体名往后调一格" title="往后调一格（跳过占着的号）" @click="shift(1)">▲</button>
                <button type="button" class="btn txt sm" aria-label="变体名往前调一格" title="往前调一格（跳过占着的号）" @click="shift(-1)">▼</button>
              </template>
              <span v-if="job.parent.confidence !== null" class="pill" :class="{ ac: job.parent.confidence >= 0.7, am: job.parent.confidence < 0.7 }">把握 {{ job.parent.confidence.toFixed(2) }}</span>
            </div>
            <div v-if="job.parent.candidates.length > 1" class="cands">
              <span class="muted small">其他候选</span>
              <button v-for="candidate in job.parent.candidates.filter((c) => c.sku !== job!.parent!.sku)" :key="candidate.sku" type="button" class="chip" :disabled="parentPickBusy" :title="`改成 ${candidate.sku}`" @click="pickParent(candidate.sku)">{{ candidate.theme || candidate.sku }}<span class="rt">{{ candidate.sku }}</span></button>
            </div>
            <details class="why">
              <summary class="small">为什么是这个</summary>
              <div class="why-b small">
                <div v-if="job.parent.reason"><span class="muted">AI：</span>{{ job.parent.reason }}</div>
                <div v-if="job.parent.naming?.existing.length">
                  <span class="muted">父体现有 {{ job.parent.naming.existing.length }} 个子体（{{ job.parent.naming.attribute }}）：</span>
                  <span class="kids"><span v-for="kid in job.parent.naming.existing" :key="kid" class="pill">{{ kid }}</span></span>
                </div>
                <template v-if="job.parent.proposal">
                  <div><span class="muted">建议新建：</span>前缀 {{ job.parent.proposal.prefix }} + 主题 {{ job.parent.proposal.theme }}（试过 {{ job.parent.proposal.themeCandidates.join('、') || '—' }}）</div>
                  <div><span class="muted">前缀参照：</span>{{ job.parent.proposal.basedOn.join('、') || '店里这类父体的 SKU 都看不出主题，按「店铺缩写-材质缩写」起' }}</div>
                </template>
                <div v-if="job.parent.naming?.note"><span class="muted">变体名：</span>{{ job.parent.naming.note.replace(/^这是建议新建的父体，店铺里还没有，需要你手动创建。/, '') }}</div>
                <div v-if="job.skuNote"><span class="muted">子体 SKU：</span>{{ job.skuNote }}</div>
                <div class="muted">候选来自「{{ job.parent.tab }}」 · {{ new Date(job.parent.readAt).toLocaleTimeString() }} 读取</div>
              </div>
            </details>
          </div>
          <div v-else-if="rec!.state === 'done'" class="none">没有父体结果，可以搜索并手动选择</div>
          <div v-if="rec!.state === 'done'" class="parent-search">
            <div class="row"><button type="button" class="btn sm" @click="parentSearchOpen = !parentSearchOpen"><Search aria-hidden="true" />搜索别的父体</button><select v-if="parentSearchOpen" v-model="parentTab" aria-label="搜索父体标签页"><option value="">{{ settings.currentStore?.parentSource === 'store' ? '所有商品类型' : '所有标签页' }}</option><option v-for="tab in parentTabs" :key="tab" :value="tab">{{ tab }}</option></select><button v-if="parentSearchOpen" type="button" class="btn sm" :disabled="parentSearchBusy" @click="searchParents">{{ parentSearchBusy ? '搜索中…' : '搜索' }}</button></div>
            <div v-if="parentSearch" class="search-results">
              <div v-if="parentSearch.failed.length" class="warn">读不了的标签页：{{ parentSearch.failed.map((f) => `${f.tab}（${f.message}）`).join('；') }}</div>
              <button v-for="row in parentSearch.rows" :key="row.tab + row.sku" type="button" class="cand" :disabled="parentPickBusy" @click="pickParent(row.sku)"><span class="s"><b>{{ row.theme || row.sku }}</b> · {{ row.sku }} · {{ row.asin }}</span><span class="muted small">{{ row.tab }}</span></button>
              <div v-if="!parentSearch.rows.length && !parentSearch.failed.length" class="muted small">没有找到父体</div>
            </div>
          </div>
          <details v-if="rec!.snapshot" style="margin-top: 8px">
            <summary class="small">实际发给分析模型的内容</summary>
            <pre class="raw">{{ rec!.snapshot.prompt }}

{{ String(rec!.snapshot.params?.user ?? '') }}</pre>
          </details>
        </template>

        <!-- ④ 信息识别 -->
        <template v-else-if="step === 3">
          <dl v-if="job.info && rec!.state === 'done'" class="kv">
            <dt>场景</dt><dd>{{ job.info.scene }}</dd>
            <dt>关键词</dt>
            <dd><div class="kw"><span v-for="k in job.info.keywords" :key="k" class="pill">{{ k }}</span></div></dd>
            <dt>可定制项</dt><dd>{{ job.info.customizable.join('、') || '无' }}</dd>
            <dt>需要留空</dt><dd>{{ job.info.blankItems.join('、') || '无（不生成空白图）' }}</dd>
          </dl>
          <div v-else-if="rec!.state === 'running'" class="none">处理中…</div>
          <div v-else-if="rec!.state === 'pending'" class="none">等待前面的步骤完成</div>
        </template>

        <!-- ② ③ ⑤ -->
        <template v-else>
          <template v-if="recipe">
            <div class="muted small">以下就是这张图实际发出的内容，开始{{ STEP_NAMES[step] }}时已记录，之后修改模版库不会影响它。</div>
            <RecipeCard
              :slots="recipe.slots"
              :prefix="recipe.prefix"
              :prompt="recipe.prompt"
              :scope="recipe.local ? '本地合成，没有发送任何请求' : '这一张实际发送的内容'"
              :out="recipe.out"
              :prefix-label="recipe.local ? '贴图方式：' : '前置句（系统自动加）：'"
            />
            <div v-if="rec!.attempts > 1" class="muted tiny">共尝试 {{ rec!.attempts }} 次</div>
          </template>
          <div v-else-if="rec!.state === 'skipped'" class="none">这张图没有需要留空的个人信息，不需要空白图</div>
          <div v-else-if="rec!.state === 'running'" class="none">处理中…</div>
          <div v-else class="none">等待前面的步骤完成</div>
          <div v-if="qc" class="qcbox">
            <div class="row">
              <b style="font-weight: 500">{{ isMain ? '主图验收' : '素材图验收' }}</b>
              <span v-if="isMain && qc.mode === 'local'" class="muted small">本地合成，在本地核对，没有发请求</span>
              <span class="pill" :class="{ ac: qc.state === 'pass', rd: qc.state === 'fail', am: qc.state === 'bypassed' }">{{ QC_STATE[qc.state] }}</span>
              <span v-if="qc.score !== null" class="muted small">图案相似分 {{ qc.score.toFixed(2) }}（阈值 {{ (qc.threshold ?? 0.9).toFixed(2) }}）</span>
            </div>
            <ul v-if="qc.reasons.length" class="small reasons">
              <li v-for="r in qc.reasons" :key="r">{{ r }}</li>
            </ul>
            <dl v-if="qc.state !== 'pending' && isMain && qc.mode === 'local'" class="kv">
              <dt>核对</dt>
              <dd>{{ colorText(qc) }}</dd>
            </dl>
            <dl v-else-if="qc.state !== 'pending'" class="kv">
              <dt>{{ isMain ? '素材图文字' : '竞品图文字' }}</dt>
              <dd>{{ qc.sourceTexts.join(' / ') || '（没有文字）' }}</dd>
              <dt>{{ isMain ? '主图文字' : '素材图文字' }}</dt>
              <dd>{{ qc.patternTexts.join(' / ') || '（没有文字）' }}</dd>
              <dt>元素问题</dt>
              <dd>{{ qc.elementIssues.join('；') || '无' }}</dd>
              <template v-if="isMain">
                <dt>贴图</dt>
                <dd>{{ qc.fillIssues.join('；') || '铺满印刷面，没有露出底材' }}</dd>
              </template>
              <template v-else>
                <dt>四边</dt>
                <dd>{{ [...qc.edgeMissing.map((x) => '少了：' + x), ...qc.edgeExtra.map((x) => '多了：' + x)].join('；') || '和竞品图一致' }}</dd>
                <template v-if="qc.border">
                  <dt>边框外延</dt>
                  <dd>{{ borderText(qc.border) }}</dd>
                </template>
              </template>
              <dt>颜色</dt>
              <dd>{{ colorText(qc) }}</dd>
              <template v-if="!isMain">
                <dt>版面</dt>
                <dd>{{ qc.layout ? (qc.layout.issues.join('；') || '四边铺满，没有白边、圆角') + (qc.layout.note ? `（${qc.layout.note}）` : qc.layout.ratioChecked ? '，比例一致' : '') : '—' }}</dd>
              </template>
            </dl>
            <details v-if="qc.snapshot">
              <summary class="small">实际发送的验收请求和模型原始回复</summary>
              <RecipeCard :slots="qcSlots" prefix="" :prompt="qc.snapshot.prompt" :scope="`分析模型 ${qc.snapshot.model}`" prefix-label="一次分析请求，两张图都缩小后发送" />
              <pre v-if="qc.raw" class="raw">{{ qc.raw }}</pre>
            </details>
          </div>
        </template>

        <div v-if="canRedo" class="redo">
          <div v-if="!redoOpen" class="row">
            <span class="muted small fill">对结果不满意？</span>
            <button type="button" class="btn sm" @click="openRedo"><RotateCcw aria-hidden="true" />{{ isParent ? '重新匹配' : '重做这一步' }}</button>
          </div>
          <template v-else>
            <b style="font-weight: 500">重做「{{ STEP_NAMES[step] }}」</b>
            <div v-if="step === 0" class="row">
              <span class="muted small">直接指定品类：</span>
              <select v-model="redoPick" aria-label="指定品类">
                <option value="">不指定，让 AI 重新识别</option>
                <template v-for="c in lib.categories" :key="c.id">
                  <option v-for="s in c.styles" :key="s.id" :value="`${c.id}|${s.id}`">{{ c.name }}{{ s.name ? ' · ' + s.name : '' }}</option>
                </template>
              </select>
            </div>
            <div v-else-if="recipe?.local" class="muted small">本地合成没有提示词可改，重做就是重新合成；想要 AI 版本，请在模版库的配方卡把贴图方式改成「AI 贴图」。</div>
            <div v-else-if="isParent" class="muted small">重新读飞书父体表、重新让 AI 挑父体、重新查店铺推算变体名；原来分到的号会释放。</div>
            <textarea v-else v-model="redoText" rows="6" aria-label="本次使用的提示词" placeholder="留空则按原来的提示词重做"></textarea>
            <label v-if="step === 1 && job.face" class="sw small">
              <input v-model="redoWhole" type="checkbox" />不用第 ① 步找的印刷面，按整张竞品图提取（区域框错了、切掉了图案时用）
            </label>
            <div class="row">
              <span class="muted small fill">只改这一张，不会改模版库{{ downstream ? '；之后的 ' + downstream + ' 会自动重跑' : '' }}</span>
              <button type="button" class="btn sm" @click="redoOpen = false">取消</button>
              <button type="button" class="btn sm pri" :disabled="busy" @click="confirmRedo">{{ recipe?.local ? '重新合成' : step === 1 ? '重新提取' : isParent ? '重新匹配' : '确认重做' }}</button>
            </div>
          </template>
        </div>

        <div class="row" style="display: flex">
          <button v-if="job.route" type="button" class="btn sm" @click="openFolder"><FolderOpen aria-hidden="true" />打开所在文件夹</button>
        </div>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.pres { display: grid; gap: 8px; }
.pres .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pres .cands { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.why summary { color: var(--sub); cursor: pointer; }
.why-b { display: grid; gap: 4px; padding: 6px 0 0 12px; line-height: 1.6; }
.why-b .kids { display: inline-flex; gap: 4px; flex-wrap: wrap; }

.face { position: relative; display: inline-block; max-width: 100%; }
.face img { display: block; max-width: 100%; max-height: 260px; border-radius: 6px; }
.face svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.face polygon { fill: none; vector-effect: non-scaling-stroke; }
.face .fix { stroke: #00b8d4; stroke-width: 2; }
.face .ai { stroke: #ffb300; stroke-width: 1.5; stroke-dasharray: 4 3; }
.qcbox { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--hair); border-radius: 8px; }
.qcbox .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.qcbox .reasons { margin: 6px 0; padding-left: 18px; color: var(--rd); }
.qcbox .raw { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--sf); padding: 8px; border-radius: 6px; max-height: 240px; overflow: auto; }
</style>
