<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import AutoText from './AutoText.vue'
import { api } from '../api'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { useConfirmTwice } from '../confirmTwice'
import type { Settings, Store } from '../types'

/** 一个店铺的档案：名称、缩写、父体来源、SP-API 凭证（只写进这个店铺）、飞书父体表 */
const props = defineProps<{ store: Store }>()
const st = useSettings()
const ui = useUi()
const s = computed(() => props.store)
const path = computed(() => `/stores/${encodeURIComponent(s.value.id)}`)
const isCurrent = computed(() => st.settings?.currentStoreId === s.value.id)

const MARKETS: Record<string, string> = { ATVPDKIKX0DER: '美国', A2EUQ1WTGCTBG2: '加拿大', A1AM78C64UM0Y8: '墨西哥' }

function saver(build: (v: string) => Record<string, unknown>) {
  return async (v: string) => {
    try {
      await st.saveStore(s.value.id, build(v))
    } catch (e) {
      ui.toast((e as Error).message, 'error')
      throw e
    }
  }
}

/** 下拉保存失败时恢复成实际保存的值（:value 绑定不会自己回去） */
async function saveSelect(e: Event, build: (v: string) => Record<string, unknown>, saved: () => string) {
  const el = e.target as HTMLSelectElement
  const ok = await ui.act(() => st.saveStore(s.value.id, build(el.value)).then(() => true))
  if (!ok) {
    await ui.act(() => st.load())
    el.value = saved()
  }
}

const reading = ref(false)
const sheet = ref<null | { ok: boolean; message?: string; title?: string; tabs?: { title: string; count: number; header: boolean; error?: string }[] }>(null)
async function readSheet(url?: string) {
  reading.value = true
  sheet.value = null
  const r = await ui.act(() => api.post<NonNullable<typeof sheet.value>>(`${path.value}/feishu/test`, url ? { url } : {}))
  reading.value = false
  sheet.value = r ?? null
  await ui.act(() => st.load())
}
async function useRecent(url: string) {
  await ui.act(() => st.saveStore(s.value.id, { feishu: { sheetUrl: url } }))
  await readSheet(url)
}

const picker = ref<HTMLInputElement | null>(null)
const paste = reactive({ open: false, text: '' })
async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  report(await ui.act(() => api.upload<{ found: Record<string, boolean>; settings: Settings }>('POST', `${path.value}/spapi/import`, 'file', f)))
}
async function importText() {
  report(await ui.act(() => api.post<{ found: Record<string, boolean>; settings: Settings }>(`${path.value}/spapi/import`, { text: paste.text })))
}
const LABEL: Record<string, string> = { sellerId: '店铺 ID', clientId: 'Client ID', clientSecret: 'Client Secret', refreshToken: 'Refresh Token' }
function report(r: { found: Record<string, boolean>; settings: Settings } | undefined) {
  if (!r) return
  st.settings = r.settings
  paste.open = false
  paste.text = ''
  spTest.value = null
  const got = Object.entries(r.found).filter(([, v]) => v).map(([k]) => LABEL[k])
  const lack = Object.entries(r.found).filter(([, v]) => !v).map(([k]) => LABEL[k])
  ui.toast(`「${s.value.name}」已导入 ${got.join('、')}${lack.length ? `；没找到 ${lack.join('、')}` : ''}`, lack.length ? 'warn' : 'info')
}

const spTest = ref<{ ok: boolean; message: string } | 'running' | null>(null)
async function testSpapi() {
  spTest.value = 'running'
  spTest.value = (await ui.act(() => api.post<{ ok: boolean; message: string }>(`${path.value}/spapi/test`))) ?? null
}

type ScanSummary = { scannedAt: string; items: number; parents: number; themed: number; truncated: boolean; productTypes: { type: string; count: number }[] }
const scan = reactive<{ busy: boolean; snapshot: ScanSummary | null; error: string | null }>({ busy: false, snapshot: null, error: null })
let poll: ReturnType<typeof setTimeout> | undefined
async function loadScan() {
  clearTimeout(poll)
  const r = await api.get<{ scanning: boolean; snapshot: ScanSummary | null }>(`${path.value}/scan`).catch(() => null)
  if (!r) return
  scan.snapshot = r.snapshot
  scan.busy = r.scanning
  // 后台正在扫（启动时预先扫）：隔几秒再看一次，扫完按钮才能点
  if (r.scanning) poll = setTimeout(loadScan, 3000)
}
onMounted(loadScan)
onUnmounted(() => clearTimeout(poll))
async function rescan() {
  scan.busy = true
  scan.error = null
  const r = await ui.act(() => api.post<{ ok: boolean; message?: string; snapshot?: ScanSummary }>(`${path.value}/scan`))
  scan.busy = false
  if (!r) return
  if (r.ok) scan.snapshot = r.snapshot ?? null
  else scan.error = r.message ?? '扫描失败'
}
const scannedAt = computed(() => {
  const t = scan.snapshot?.scannedAt
  if (!t) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

const { armed: confirmDel, click: remove } = useConfirmTwice(async () => {
  const r = await ui.act(() => api.del<Settings>(path.value))
  if (r) st.settings = r
})
</script>

<template>
  <div class="card">
    <div class="head">
      <strong>{{ s.name }}</strong>
      <span class="muted small">{{ s.abbr }}</span>
      <span v-if="isCurrent" class="chip">当前店铺</span>
      <span class="sp"></span>
      <button v-if="!isCurrent" type="button" class="btn sm" :class="{ del: confirmDel }" @click="remove()">{{ confirmDel ? '再点一次删除' : '删除店铺' }}</button>
    </div>
    <div class="two">
      <div class="fld">
        <label>店铺名称</label>
        <AutoText :value="s.name" :save="saver((v) => ({ name: v.trim() }))" label="店铺名称" />
      </div>
      <div class="fld">
        <label>店铺缩写（SKU 开头）</label>
        <AutoText :value="s.abbr" :save="saver((v) => ({ abbr: v.trim() }))" label="店铺缩写" />
      </div>
    </div>
    <div class="fld">
      <label>父体从哪里找</label>
      <select :value="s.parentSource" aria-label="父体从哪里找" @change="saveSelect($event, (v) => ({ parentSource: v }), () => s.parentSource)">
        <option value="feishu">飞书父体表</option>
        <option value="store">店铺里扫描（没有飞书父体表）</option>
      </select>
    </div>

    <template v-if="s.parentSource === 'feishu'">
      <div class="fld">
        <label>父体表链接</label>
        <AutoText :value="s.feishu.sheetUrl" :save="saver((v) => ({ feishu: { sheetUrl: v.trim() } }))" label="父体表链接" placeholder="https://….feishu.cn/wiki/… 或 /sheets/…" />
      </div>
      <div v-if="s.feishu.recentUrls.length" class="fld">
        <label>用过的链接</label>
        <div class="chips">
          <button v-for="r in s.feishu.recentUrls" :key="r.url" type="button" class="chip" :aria-pressed="r.url === s.feishu.sheetUrl" :title="r.url" @click="useRecent(r.url)">
            {{ r.title }}{{ r.url === s.feishu.sheetUrl ? '（当前）' : '' }}
          </button>
        </div>
      </div>
      <div class="row">
        <button type="button" class="btn sm" :disabled="reading || !s.feishu.sheetUrl" @click="readSheet()">{{ reading ? '读取中…' : '读一下试试' }}</button>
        <span class="muted tiny">平时不同步，每次跑到第 6 步时现读</span>
      </div>
      <div v-if="sheet && !sheet.ok" class="warn rd" style="margin: 0">{{ sheet.message }}</div>
      <div v-else-if="sheet" class="fld">
        <label>「{{ sheet.title }}」读到的标签页</label>
        <div class="chips">
          <span v-for="t in sheet.tabs" :key="t.title" class="chip" :title="t.error">{{ t.title }}<span class="rt">{{ t.error ? '这一页读不了' : t.header ? `${t.count} 个父体` : '没有「父体SKU」表头' }}</span></span>
        </div>
      </div>
    </template>
    <div v-else class="muted tiny">这个店铺没有飞书父体表，第 6 步从店铺里扫描父体来挑。</div>

    <div class="two">
      <div class="fld">
        <label>店铺 ID</label>
        <AutoText :value="s.spapi.sellerId" :save="saver((v) => ({ spapi: { sellerId: v.trim() } }))" label="店铺 ID" secret />
      </div>
      <div class="fld">
        <label>站点</label>
        <select :value="s.spapi.marketplaceId" aria-label="站点" @change="saveSelect($event, (v) => ({ spapi: { marketplaceId: v } }), () => s.spapi.marketplaceId)">
          <option v-for="(name, id) in MARKETS" :key="id" :value="id">{{ name }}</option>
        </select>
      </div>
    </div>
    <div class="fld">
      <label>SP-API 凭证</label>
      <div class="small">
        Client ID {{ s.spapi.clientId || '未填' }}　Secret {{ s.spapi.clientSecret || '未填' }}　Refresh Token {{ s.spapi.refreshToken || '未填' }}
      </div>
    </div>
    <div class="row">
      <span v-if="spTest && spTest !== 'running'" class="dot" :class="spTest.ok ? '' : 'rd'"></span>
      <span v-if="spTest && spTest !== 'running'" class="small">{{ spTest.message }}</span>
      <button type="button" class="btn sm" @click="picker?.click()">从文件导入</button>
      <button type="button" class="btn sm" @click="paste.open = !paste.open">粘贴文字</button>
      <button type="button" class="btn sm" :disabled="spTest === 'running'" @click="testSpapi">{{ spTest === 'running' ? '测试中…' : '测试连接' }}</button>
    </div>
    <div v-if="paste.open" class="fld">
      <textarea v-model="paste.text" rows="4" :aria-label="`粘贴「${s.name}」的凭证`" placeholder="把包含店铺 ID、Client ID、Client Secret、Refresh Token 的文字粘贴进来"></textarea>
      <div><button type="button" class="btn sm pri" :disabled="!paste.text.trim()" @click="importText">导入到「{{ s.name }}」</button></div>
    </div>
    <input ref="picker" type="file" accept=".rtf,.txt,text/plain,application/rtf" hidden @change="importFile" />

    <div class="fld">
      <label>店铺商品</label>
      <div class="row">
        <span v-if="scan.snapshot" class="small">
          {{ scannedAt }} 扫描，共 {{ scan.snapshot.items }} 个商品，父体 {{ scan.snapshot.parents }} 个（SKU 里带主题的 {{ scan.snapshot.themed }} 个）{{ scan.snapshot.truncated ? '；有一段超过 1000 条没扫全' : '' }}
        </span>
        <span v-else class="muted small">{{ scan.busy ? '正在扫描…' : '还没扫描过' }}</span>
        <button type="button" class="btn sm" :disabled="scan.busy" @click="rescan">{{ scan.busy ? '扫描中…（几十秒）' : '重新扫描' }}</button>
      </div>
      <div v-if="scan.error" class="warn rd" style="margin: 0">{{ scan.error }}</div>
      <div class="muted tiny">第 6 步挑父体、查重要用。平时自动扫，10 分钟内的结果直接用；刚在店铺里建了父体想马上用，就点「重新扫描」。</div>
    </div>
  </div>
</template>

<style scoped>
.card { border: 1px solid var(--hair); border-radius: var(--r-sm); padding: 10px 12px; display: grid; gap: 8px; }
.head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sp { flex: 1; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn.del { color: var(--rd); border-color: var(--rd); }
</style>
