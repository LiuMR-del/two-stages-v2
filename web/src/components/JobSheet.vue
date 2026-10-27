<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderOpen, RotateCcw, TriangleAlert, X } from '@lucide/vue'
import ImageSlot, { type SlotState } from './ImageSlot.vue'
import RecipeCard, { type RecipeSlot } from './RecipeCard.vue'
import { useJobs, STEP_NAMES, type FileKind } from '../stores/jobs'
import { activeTemplateName, useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import { imageUrl } from '../api'
import type { Job } from '../types'

const jobs = useJobs()
const lib = useLibrary()
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
    sub: im.role === '素材图' ? '第 ② 步的结果' : im.role === '主图' ? '第 ③ 步的结果' : im.role === '竞品图' ? j.source.originalName : '开始生成时记录',
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
  redoOpen.value = true
}

const canRedo = computed(() => !!rec.value && ['done', 'skipped', 'failed'].includes(rec.value.state))
const downstream = computed(() => STEP_NAMES.slice(step.value + 1).join('、'))

async function confirmRedo() {
  const j = job.value!
  const body: { step: number; prompt?: string; categoryId?: string; styleId?: string } = { step: step.value }
  if (step.value === 0) {
    if (redoPick.value) {
      const [cid, sid] = redoPick.value.split('|')
      body.categoryId = cid
      body.styleId = sid
    }
  } else if (recipe.value?.local) {
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
    ui.toast(`已重做「${STEP_NAMES[step.value]}」${step.value < 4 ? '，后面的步骤会自动跟上' : ''}`)
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
          </dl>
          <div v-else-if="rec!.state === 'pending'" class="none">排队等待识别</div>
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
            <button type="button" class="btn sm" @click="openRedo"><RotateCcw aria-hidden="true" />重做这一步</button>
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
            <textarea v-else v-model="redoText" rows="6" aria-label="本次使用的提示词" placeholder="留空则按原来的提示词重做"></textarea>
            <div class="row">
              <span class="muted small fill">只改这一张，不会改模版库{{ step < 4 ? '；之后的 ' + downstream + ' 会自动重跑' : '' }}</span>
              <button type="button" class="btn sm" @click="redoOpen = false">取消</button>
              <button type="button" class="btn sm pri" :disabled="busy" @click="confirmRedo">{{ recipe?.local ? '重新合成' : step === 1 ? '重新提取' : '确认重做' }}</button>
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
.qcbox { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--hair); border-radius: 8px; }
.qcbox .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.qcbox .reasons { margin: 6px 0; padding-left: 18px; color: var(--rd); }
.qcbox .raw { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--sf); padding: 8px; border-radius: 6px; max-height: 240px; overflow: auto; }
</style>
