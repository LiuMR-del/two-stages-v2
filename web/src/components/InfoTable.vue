<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Copy, Download } from '@lucide/vue'
import ImageSlot from './ImageSlot.vue'
import { PARENT_STEP, useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'
import type { Job, MarkPlan } from '../types'

const jobs = useJobs()
const ui = useUi()

function viewMain(j: Job) {
  const items = jobs.viewItems(j)
  ui.view(items, items.findIndex((i) => i.kind === 'main'), { title: j.source.originalName, jobId: j.id })
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const day = ref(today())
const showParent = computed(() => jobs.withInfo.some((j) => j.parent !== null))
const showSku = computed(() => jobs.withInfo.some((j) => !!j.sku))
const cols = computed(() => 4 + (showSku.value ? 1 : 0) + (showParent.value ? 2 : 0))
const parentLabel: Record<string, string> = { matched: '已匹配', unsure: '待确认', none: '没有合适的父体', new: '建议新建' }

/** 改专属号：先预览（列出旧 → 新、冲突），确认后才改 */
const mk = reactive<{ open: boolean; value: string; busy: boolean; plan: MarkPlan | null }>({ open: false, value: '', busy: false, plan: null })
const hasConflict = computed(() => !!mk.plan?.items.some((x) => x.conflict))
async function previewMark() {
  mk.busy = true
  mk.plan = (await ui.act(() => jobs.changeMark(mk.value.trim(), false))) ?? null
  mk.busy = false
}
async function applyMark() {
  mk.busy = true
  const r = await ui.act(() => jobs.changeMark(mk.value.trim(), true))
  mk.busy = false
  if (!r) return
  if (r.applied) {
    ui.toast(`专属号改成 ${r.to}，${r.items.length} 个 SKU 和文件都改好了`)
    mk.open = false
    mk.plan = null
    mk.value = ''
  } else mk.plan = r
}

async function shiftParent(j: Job, delta: 1 | -1) {
  await ui.act(() => jobs.shiftParent(j.id, delta))
}

function openParent(j: Job) {
  ui.sheet = { jobId: j.id, step: PARENT_STEP }
}

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
</script>

<template>
  <div class="box">
    <div style="display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 10px 14px 0; flex-wrap: wrap">
      <span v-if="jobs.batch" class="small">店铺：{{ jobs.batch.storeName }} · 专属号：{{ jobs.batch.mark }}</span>
      <button v-if="jobs.batch?.folder && (showSku || !jobs.all.length)" type="button" class="btn sm" @click="mk.open = !mk.open">改专属号</button>
      <span style="flex: 1"></span>
      <span class="muted small">按天导出</span>
      <input v-model="day" type="date" aria-label="导出日期" />
      <a class="btn sm" :href="`/api/info.csv?day=${day}`" download><Download aria-hidden="true" />导出 CSV</a>
    </div>
    <div v-if="mk.open" class="mark">
      <div class="row">
        <span class="small">把这一批所有 SKU 的专属号从 {{ jobs.batch?.mark }} 改成</span>
        <input v-model="mk.value" aria-label="新专属号" style="width: 72px" placeholder="如 1" @input="mk.plan = null" />
        <button type="button" class="btn sm" :disabled="mk.busy || !mk.value.trim()" @click="previewMark">{{ mk.busy && !mk.plan ? '检查中…' : '预览' }}</button>
        <button v-if="mk.plan && !hasConflict && mk.plan.items.length && mk.plan.storeCheck !== 'truncated'" type="button" class="btn sm pri" :disabled="mk.busy" @click="applyMark">{{ mk.busy ? '改名中…' : `确认修改 ${mk.plan.items.length} 个` }}</button>
        <button type="button" class="btn sm" @click="(mk.open = false), (mk.plan = null)">取消</button>
      </div>
      <div class="muted tiny">主图、素材图、空白图会跟着改名，识别信息 CSV 重写，已经「清除已完成」的图也一起改；这一批之后再加的图也用新号。先查店铺里和输出文件夹里有没有重名，有就不改。</div>
      <template v-if="mk.plan">
        <div v-if="mk.plan.storeCheck === 'noCredentials'" class="warn" style="margin: 0">{{ mk.plan.storeName ? `「${mk.plan.storeName}」` : '这个店铺' }}没填 SP-API 凭证，没查店铺里有没有重名，只查了输出文件夹、队列和今天发过的号</div>
        <div v-else-if="mk.plan.storeCheck === 'truncated'" class="warn rd" style="margin: 0">「{{ mk.plan.storeName }}」店铺商品没扫全，没法确认在店里有没有重名，先不能改</div>
        <div v-if="hasConflict" class="warn rd" style="margin: 0">有 {{ mk.plan.items.filter((x) => x.conflict).length }} 个会重名，换一个专属号再试</div>
        <div v-if="!mk.plan.items.length" class="muted small">这一批没有能改的 SKU</div>
        <ul class="plan">
          <li v-for="x in mk.plan.items" :key="x.old" :class="{ bad: x.conflict }">
            <span class="mono">{{ x.old }}</span> → <span class="mono">{{ x.next }}</span>
            <span class="muted tiny">{{ x.name }}{{ x.inQueue ? '' : '（已移出队列）' }}</span>
            <span v-if="x.conflict" class="tiny" style="color: var(--rd)">{{ x.conflict }}</span>
          </li>
          <li v-for="x in mk.plan.skipped" :key="'s' + x.sku" class="muted"><span class="mono">{{ x.sku }}</span> 不改：{{ x.reason }}</li>
        </ul>
      </template>
    </div>
    <div style="overflow-x: auto">
      <table class="tbl">
        <thead>
          <tr><th>主图</th><th v-if="showSku">SKU</th><th>场景</th><th>搜索关键词</th><th>可定制项</th><th v-if="showParent">父体</th><th v-if="showParent">下一个变体名</th></tr>
        </thead>
        <tbody>
          <tr v-if="!jobs.withInfo.length"><td :colspan="cols" class="none">主图生成后，这里汇总每张图的场景、关键词和可定制项</td></tr>
          <tr v-for="j in jobs.withInfo" :key="j.id">
            <td>
              <button type="button" class="tile" :aria-label="'查看 ' + j.source.originalName + ' 的主图大图'" title="点击看大图" @click="viewMain(j)">
                <ImageSlot state="image" :img="jobs.fileUrl(j, 'main')" :size="44" white />
              </button>
            </td>
            <td v-if="showSku">
              <template v-if="j.sku"><b class="name">{{ j.sku }}</b><button type="button" class="cp" aria-label="复制 SKU" @click="copy(j.sku)"><Copy aria-hidden="true" /></button></template>
              <span v-else class="muted small" :title="`去模版库给「${j.route?.categoryName}」填 SKU 材质缩写`">—</span>
            </td>
            <td>{{ j.info!.scene }}<button type="button" class="cp" aria-label="复制场景" @click="copy(j.info!.scene)"><Copy aria-hidden="true" /></button></td>
            <td>
              <div class="kw">
                <span v-for="k in j.info!.keywords" :key="k" class="pill">{{ k }}</span>
                <button type="button" class="cp" aria-label="复制关键词" @click="copy(j.info!.keywords.join(', '))"><Copy aria-hidden="true" /></button>
              </div>
            </td>
            <td>
              {{ j.info!.customizable.length ? j.info!.customizable.join('，') : '无' }}
              <button v-if="j.info!.customizable.length" type="button" class="cp" aria-label="复制可定制项" @click="copy(j.info!.customizable.join('，'))"><Copy aria-hidden="true" /></button>
            </td>
            <td v-if="showParent">
              <template v-if="j.parent">
                <div v-if="j.parent.sku" class="parent-main">
                  <span class="sku">{{ j.parent.sku }}</span>
                  <button type="button" class="cp" aria-label="复制父体 SKU" @click="copy(j.parent.sku)"><Copy aria-hidden="true" /></button>
                </div>
                <div class="muted small">{{ j.parent.theme || j.parent.message || '—' }}<template v-if="j.parent.asin"> · {{ j.parent.asin }}</template><template v-else-if="j.parent.status === 'new'"> · 需手动创建</template></div>
                <div class="row"><span class="pill" :class="{ ac: j.parent.status === 'matched', am: j.parent.status === 'unsure', bl: j.parent.status === 'new' }">{{ parentLabel[j.parent.status] }}</span><button v-if="j.parent.status === 'none'" type="button" class="btn txt sm" @click="openParent(j)">手动选 ›</button><button v-else type="button" class="btn txt sm" @click="openParent(j)">详情 ›</button></div>
              </template>
              <span v-else class="muted small">尚未匹配</span>
            </td>
            <td v-if="showParent">
              <template v-if="j.parent?.naming?.next">
                <div class="parent-main"><b class="name">{{ j.parent.naming.next }}</b><button type="button" class="cp" aria-label="复制推荐变体名" @click="copy(j.parent.naming.next)"><Copy aria-hidden="true" /></button></div>
                <div class="row"><span v-if="j.parent.confidence !== null" class="pill" :class="{ ac: j.parent.confidence >= 0.7, am: j.parent.confidence < 0.7 }">{{ j.parent.confidence >= 0.7 ? '把握' : '待确认' }} · {{ j.parent.confidence.toFixed(2) }}</span><template v-if="j.parent.naming.number !== null"><button type="button" class="btn txt sm" aria-label="变体名往后调一格" @click="shiftParent(j, 1)">▲</button><button type="button" class="btn txt sm" aria-label="变体名往前调一格" @click="shiftParent(j, -1)">▼</button></template></div>
              </template>
              <template v-else><span class="muted small">{{ j.parent?.message || '待确认' }}</span><button v-if="j.parent" type="button" class="btn txt sm" @click="openParent(j)">去确认 ›</button></template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.mark { margin: 10px 14px 0; padding: 10px 12px; border: 1px solid var(--hair); border-radius: var(--r-sm); display: grid; gap: 6px; }
.mark .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.plan { margin: 0; padding-left: 18px; max-height: 220px; overflow-y: auto; display: grid; gap: 2px; font-size: 12px; }
.plan .bad .mono { color: var(--rd); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
