<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Lock, ScanSearch, Trash2 } from '@lucide/vue'
import { api, imageUrl } from '../api'
import { activeTemplateName, useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import AutoText from './AutoText.vue'
import RecipeCard, { type RecipeSlot } from './RecipeCard.vue'
import type { Category, ExtractRecipe, Recipe, Style } from '../types'

const lib = useLibrary()
const ui = useUi()

const cat = computed(() => lib.category(ui.libSel) as Category)
const style = computed<Style>(() => cat.value.styles.find((s) => s.id === ui.libStyle) ?? cat.value.styles[0]!)
/** 主图模版属于款式：每个款式有自己的一套，切换款式就看那个款式的 */
const tplId = computed(() => (ui.libTpl === 'default' || style.value.templates.some((t) => t.id === ui.libTpl) ? ui.libTpl : style.value.activeTemplate))
const tpl = computed(() => style.value.templates.find((t) => t.id === tplId.value) ?? null)
const singleUnnamed = computed(() => cat.value.styles.length === 1 && !cat.value.styles[0]!.name)
const styleLabel = (s: Style) => s.name || '单款式'
const styleTitle = computed(() => (singleUnnamed.value ? cat.value.name : `${cat.value.name} · ${style.value.name}`))

const editingName = ref(false)
const editingHint = ref(false)
const confirmDelete = ref(false)
const confirmDeleteTpl = ref(false)
const addingStyle = ref(false)
const newStyle = ref({ name: '', ratio: '1:1' })

watch(
  () => ui.libSel,
  () => {
    editingName.value = false
    editingHint.value = false
    confirmDelete.value = false
    addingStyle.value = false
  },
)

watch(
  () => style.value?.id,
  () => {
    ui.libTpl = style.value.activeTemplate
    confirmDeleteTpl.value = false
  },
)

const base = computed(() => `/library/categories/${cat.value.id}`)
const sbase = computed(() => `${base.value}/styles/${style.value.id}`)
const tplPath = (tid: string) => `${sbase.value}/templates/${tid}`

/** 保存失败时弹提示并让输入框显示「没保存上」 */
function saver<T>(fn: (v: string) => Promise<T>) {
  return async (v: string) => {
    try {
      return await lib.mutate(() => fn(v) as Promise<any>)
    } catch (e) {
      ui.toast((e as Error).message, 'error')
      throw e
    }
  }
}

const saveName = saver((v) => api.patch(base.value, { name: v }))
const saveHint = saver((v) => api.patch(base.value, { hint: v }))
const saveStyleName = (sid: string) => saver((v) => api.patch(`${base.value}/styles/${sid}`, { name: v }))
const saveStyleRatio = (sid: string) => saver((v) => api.patch(`${base.value}/styles/${sid}`, { ratio: v }))
const saveTplName = (tid: string) => saver((v) => api.patch(tplPath(tid), { name: v }))
const saveTplCanvas = (tid: string) => saver((v) => api.patch(tplPath(tid), { canvasRatio: v.trim() || null }))
const saveExtract = saver((v) => api.patch(base.value, { extractPrompt: v }))

async function deleteCategory() {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    setTimeout(() => (confirmDelete.value = false), 4000)
    return
  }
  const name = cat.value.name
  const r = await ui.act(() => lib.mutate(() => api.del(base.value)))
  if (r) {
    ui.libSel = '__global'
    ui.toast(`已删除品类「${name}」`)
  }
}

async function addStyle() {
  const r = await ui.act(() => lib.mutate(() => api.post<any>(`${base.value}/styles`, newStyle.value)))
  if (r) {
    ui.libStyle = r.style.id
    addingStyle.value = false
    newStyle.value = { name: '', ratio: '1:1' }
  }
}

async function deleteStyle(s: Style) {
  const r = await ui.act(() => lib.mutate(() => api.del(`${base.value}/styles/${s.id}`)))
  if (r) ui.libStyle = cat.value.styles[0]!.id
}

async function addTemplate() {
  const r = await ui.act(() => lib.mutate(() => api.post<any>(`${sbase.value}/templates`, { name: '', prompt: '' })))
  if (r) ui.libTpl = r.template.id
}

async function deleteTemplate() {
  if (!tpl.value) return
  if (!confirmDeleteTpl.value) {
    confirmDeleteTpl.value = true
    setTimeout(() => (confirmDeleteTpl.value = false), 4000)
    return
  }
  const id = tpl.value.id
  const r = await ui.act(() => lib.mutate(() => api.del(tplPath(id))))
  confirmDeleteTpl.value = false
  if (r) ui.libTpl = style.value.activeTemplate
}

async function activate() {
  const r = await ui.act(() => lib.mutate(() => api.patch(sbase.value, { activeTemplate: tplId.value })))
  if (r) ui.toast(`之后识别为「${styleTitle.value}」的图，都用「${recipe.value?.templateName ?? ''}」生成主图`)
}

// ---- AI 估算比例 ----
type Estimate = { styleId: string; ratio: string; value: number; shape: string; surface: string; reason: string; source: string }
const estimating = ref(false)
const estimated = ref<Estimate | null>(null)

async function estimate() {
  const sid = style.value.id
  estimating.value = true
  const r = await ui.act(() => api.post<Omit<Estimate, 'styleId'>>(`${base.value}/styles/${sid}/estimate-ratio`, { templateId: tplId.value === 'default' ? undefined : tplId.value }))
  estimating.value = false
  if (r) estimated.value = { ...r, styleId: sid }
}
async function applyEstimate() {
  const e = estimated.value
  if (!e) return
  const r = await ui.act(() => lib.mutate(() => api.patch(`${base.value}/styles/${e.styleId}`, { ratio: e.ratio })))
  if (r) {
    ui.toast(`比例已改成 ${e.ratio}`)
    estimated.value = null
  }
}

async function toggleExtract() {
  const next = cat.value.extractPrompt === null ? lib.library!.defaults.extractPrompt : null
  await ui.act(() => lib.mutate(() => api.patch(base.value, { extractPrompt: next })))
}

// ---- 配方预览 ----
const recipe = ref<Recipe | null>(null)
const extract = ref<ExtractRecipe | null>(null)
const coverage = ref<Record<string, Recipe>>({})

watch(
  () => [cat.value?.id, style.value?.id, tplId.value, lib.version] as const,
  async ([cid, sid, tid]) => {
    if (!cid || !sid) return
    const [r, x] = await Promise.all([
      ui.act(() => lib.recipe(cid, sid, tid)),
      ui.act(() => lib.extractRecipe(cid, sid)),
    ])
    if (cid !== cat.value?.id || sid !== style.value?.id || tid !== tplId.value) return
    recipe.value = r ?? null
    extract.value = x ?? null
    const cov: Record<string, Recipe> = {}
    await Promise.all(
      cat.value.styles.map(async (s) => {
        const rr = await lib.recipe(cid, s.id, s.activeTemplate).catch(() => null)
        if (rr) cov[s.id] = rr
      }),
    )
    coverage.value = cov
  },
  { immediate: true },
)

const slots = computed<RecipeSlot[]>(() => {
  const r = recipe.value
  if (!r) return []
  return r.images.map((im) => {
    if (im.auto) {
      return { key: 'pattern', no: im.no, role: im.role, sub: `运行时自动填入 · ${style.value.ratio}`, state: 'auto', text: '素材图\n自动填入' }
    }
    const owner = style.value.name ? `${style.value.name}专用` : '本品类'
    return {
      key: 'first',
      no: im.no,
      role: im.role,
      sub: `${owner} · ${im.required ? '必需' : '可选'}`,
      state: im.hash ? 'image' : 'empty',
      img: im.hash ? imageUrl(im.hash) : null,
      full: im.hash ? imageUrl(im.hash, false) : null,
      text: im.required ? '缺白底图\n点击上传' : '点击上传',
      white: im.role === '白底图',
      editable: true,
    }
  })
})

const promptEdit = computed(() => {
  if (tplId.value === 'default') {
    return {
      raw: lib.library!.defaults.pastePrompt,
      save: saver((v) => api.put('/library/defaults', { pastePrompt: v })),
      hint: '这是默认模版「贴图」的提示词，所有用默认模版的品类共用。{品类}、{款式}、{比例} 会自动替换',
    }
  }
  const t = tpl.value!
  return {
    raw: t.prompt,
    save: saver((v) => api.patch(tplPath(t.id), { prompt: v })),
    hint: `只给「${styleTitle.value}」用，改了不影响其他款式。{品类}、{款式}、{比例} 会自动替换`,
  }
})

async function upload(_key: string, file: File) {
  const path = tplId.value === 'default' ? `${sbase.value}/white` : `${tplPath(tplId.value)}/image`
  const r = await ui.act(() => lib.mutate(() => api.upload<any>('PUT', path, 'file', file)))
  if (r && tplId.value === 'default') ui.toast('白底图已上传')
}
async function remove() {
  const path = tplId.value === 'default' ? `${sbase.value}/white` : `${tplPath(tplId.value)}/image`
  await ui.act(() => lib.mutate(() => api.del(path)))
}

function coverageOf(s: Style): { dot: string; text: string } {
  const r = coverage.value[s.id]
  if (!r) return { dot: 'gr', text: '检查中' }
  const first = r.images.find((i) => !i.auto)
  if (first?.required && !first.hash) return { dot: 'rd', text: '缺白底图' }
  if (!r.prompt.trim()) return { dot: 'rd', text: '提示词为空' }
  if (r.warnings.some((w) => w.startsWith('提示词里提到'))) return { dot: 'am', text: '图片数量与提示词不符' }
  const name = activeTemplateName(s)
  if (s.activeTemplate === 'default') return { dot: '', text: `${name} · 白底图已配` }
  return { dot: '', text: `${name} · ${first?.hash ? '有参考图' : '不发参考图'}` }
}
</script>

<template>
  <div v-if="cat" class="box">
    <div class="cd">
      <div class="cd-h">
        <div style="flex: 1; min-width: 240px">
          <h2 v-if="!editingName"><button type="button" title="点击修改名称" @click="editingName = true">{{ cat.name }}</button></h2>
          <div v-else class="edit-row">
            <AutoText :key="cat.id" :value="cat.name" :save="saveName" label="品类名称" />
            <button type="button" class="btn sm" @click="editingName = false">完成</button>
          </div>
          <div v-if="!editingHint" class="hint">
            <ScanSearch aria-hidden="true" />AI 识别说明：{{ cat.hint || '（还没写，写一句话帮 AI 认出它，比如「挂墙帆布画，图案印在矩形画面上」）' }}
            <button type="button" class="btn txt sm" @click="editingHint = true">修改</button>
          </div>
          <div v-else class="fold" style="margin-top: 8px">
            <div class="t">
              <AutoText :key="cat.id" :value="cat.hint" :save="saveHint" multiline :rows="2" label="AI 识别说明" placeholder="例如：挂墙帆布画/相框，图案印在矩形画面上" />
            </div>
            <button type="button" class="btn sm" @click="editingHint = false">完成</button>
          </div>
        </div>
        <button type="button" class="btn txt sm rd r" @click="deleteCategory">{{ confirmDelete ? '再点一次确认删除' : '删除品类' }}</button>
      </div>

      <div class="ctl">
        <span class="k">款式</span>
        <div class="v">
          <template v-if="singleUnnamed">
            <span class="pill">单款式</span>
            <span class="edit-row">素材比例 <AutoText :key="style.id + 'r'" :value="style.ratio" :save="saveStyleRatio(style.id)" label="素材比例" /></span>
          </template>
          <div v-else class="chips">
            <button v-for="s in cat.styles" :key="s.id" type="button" class="chip" :aria-pressed="style.id === s.id" @click="ui.libStyle = s.id">
              {{ styleLabel(s) }}<span class="rt">{{ s.ratio }}</span>
            </button>
          </div>
          <button v-if="!addingStyle" type="button" class="chip add" @click="addingStyle = true">+ 款式</button>
          <span v-else class="edit-row">
            <input v-model="newStyle.name" type="text" placeholder="款式名，如 竖版" aria-label="新款式名称" @keydown.enter="addStyle" />
            <input v-model="newStyle.ratio" type="text" placeholder="比例，如 2:3" aria-label="新款式比例" style="width: 80px" @keydown.enter="addStyle" />
            <button type="button" class="btn sm pri" @click="addStyle">添加</button>
            <button type="button" class="btn sm" @click="addingStyle = false">取消</button>
          </span>
        </div>
        <template v-if="!singleUnnamed">
          <span class="k"></span>
          <div class="v edit-row">
            名称 <AutoText :key="style.id + 'n'" :value="style.name" :save="saveStyleName(style.id)" label="款式名称" />
            比例 <AutoText :key="style.id + 'r'" :value="style.ratio" :save="saveStyleRatio(style.id)" label="款式比例" />
            <button type="button" class="btn txt sm rd" @click="deleteStyle(style)"><Trash2 aria-hidden="true" />删除这个款式</button>
          </div>
        </template>

        <span class="k"></span>
        <div class="v edit-row">
          <span class="muted tiny">比例是图案本身的宽:高，也就是商品上印图案那一块表面的形状，不是整张图的比例</span>
          <button type="button" class="btn txt sm" :disabled="estimating" @click="estimate">{{ estimating ? 'AI 正在看图…' : 'AI 帮我估算' }}</button>
        </div>
        <template v-if="estimated && estimated.styleId === style.id">
          <span class="k"></span>
          <div class="v edit-row est">
            <span>建议{{ singleUnnamed ? '' : '「' + styleLabel(style) + '」的' }}比例用 <b>{{ estimated.ratio }}</b></span>
            <span class="muted small">看的是{{ estimated.source }}：{{ estimated.surface }}{{ estimated.shape ? '，' + estimated.shape : '' }}，宽÷高约 {{ estimated.value.toFixed(2) }}。{{ estimated.reason }}</span>
            <button v-if="estimated.ratio !== style.ratio" type="button" class="btn sm pri" @click="applyEstimate">采用 {{ estimated.ratio }}</button>
            <span v-else class="muted small">和现在填的一样</span>
            <button type="button" class="btn sm" @click="estimated = null">关闭</button>
          </div>
        </template>

        <span class="k">{{ singleUnnamed ? '主图模版' : styleLabel(style) + ' 的主图模版' }}</span>
        <div class="v">
          <div class="chips">
            <button type="button" class="chip" :aria-pressed="tplId === 'default'" @click="ui.libTpl = 'default'">
              默认 · 贴图<span v-if="style.activeTemplate === 'default'" class="star">使用中</span>
            </button>
            <button v-for="t in style.templates" :key="t.id" type="button" class="chip" :aria-pressed="tplId === t.id" @click="ui.libTpl = t.id">
              {{ t.name }}<span v-if="style.activeTemplate === t.id" class="star">使用中</span>
            </button>
          </div>
          <button type="button" class="chip add" @click="addTemplate">+ 自定义模版</button>
        </div>
        <template v-if="tpl">
          <span class="k"></span>
          <div class="v edit-row">
            模版名称 <AutoText :key="tpl.id" :value="tpl.name" :save="saveTplName(tpl.id)" label="模版名称" />
            主图比例 <AutoText :key="tpl.id + 'c'" :value="tpl.canvasRatio ?? ''" :save="saveTplCanvas(tpl.id)" label="主图比例" placeholder="跟款式比例" />
            <span class="muted tiny">没有参考图时，主图按这个比例生成，如 1:1</span>
            <button type="button" class="btn txt sm rd" @click="deleteTemplate"><Trash2 aria-hidden="true" />{{ confirmDeleteTpl ? '再点一次确认删除' : '删除这个模版' }}</button>
          </div>
        </template>
      </div>

      <div class="rc">
        <div class="rc-h">
          <b>发送给生图模型</b>
          <span class="muted small">{{ cat.name }}{{ style.name ? ' · ' + style.name : '' }} · {{ recipe?.templateName }}</span>
          <div class="r">
            <span v-if="style.activeTemplate === tplId" class="pill ac"><Check aria-hidden="true" />{{ singleUnnamed ? '本品类' : '「' + style.name + '」' }}正在使用</span>
            <button v-else type="button" class="btn sm pri" @click="activate">设为{{ singleUnnamed ? '本品类' : '「' + style.name + '」' }}使用</button>
          </div>
        </div>
        <RecipeCard
          v-if="recipe"
          :key="cat.id + style.id + tplId"
          :slots="slots"
          :prefix="recipe.prefix"
          :prompt="recipe.prompt"
          :scope="recipe.scope"
          :edit="promptEdit"
          :out="{ label: '主图', state: 'auto', text: '主图' }"
          :warnings="recipe.warnings"
          @upload="upload"
          @remove="remove"
        />
        <div class="cov">
          <span class="muted small">各款式检查：</span>
          <button v-for="s in cat.styles" :key="s.id" type="button" :aria-pressed="style.id === s.id" @click="ui.libStyle = s.id">
            <span class="dot" :class="coverageOf(s).dot"></span>{{ styleLabel(s) }} · {{ coverageOf(s).text }}
          </button>
        </div>
      </div>

      <div class="fold">
        <div class="t">
          <b style="font-weight: 500">② 提取素材图提示词</b>
          <div class="muted small">{{ cat.extractPrompt === null ? '使用全局默认' : '本品类单独设置' }}（{{ styleLabel(style) }} 实际发送如下）</div>
        </div>
        <button type="button" class="btn sm" @click="toggleExtract">{{ cat.extractPrompt === null ? '单独设置' : '恢复全局默认' }}</button>
        <div v-if="extract" style="flex-basis: 100%" class="pbox">
          <div class="body" style="background: var(--sf)">
            <div class="pre"><Lock aria-hidden="true" /><span>系统自动加在最前面：{{ extract.prefix }}</span></div>
            <AutoText
              v-if="cat.extractPrompt !== null"
              :key="cat.id + 'x'"
              :value="cat.extractPrompt"
              :save="saveExtract"
              multiline
              :rows="4"
              label="本品类的提取提示词"
            />
            <div class="txt">{{ cat.extractPrompt !== null ? '实际发送：' : '' }}{{ extract.prompt }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.est { background: var(--ac-soft); border-radius: 8px; padding: 8px 10px; color: var(--tx); }
</style>
