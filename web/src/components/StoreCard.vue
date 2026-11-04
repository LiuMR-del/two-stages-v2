<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ChevronRight } from '@lucide/vue'
import AutoText from './AutoText.vue'
import Help from './Help.vue'
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
const hasCreds = computed(() => !!(s.value.spapi.sellerId && s.value.spapi.clientId && s.value.spapi.clientSecret && s.value.spapi.refreshToken))
/** 默认收起，只显示一行概况；凭证没填全的默认展开（要填东西） */
const open = ref(!hasCreds.value)

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
  <div class="card" :class="{ open }">
    <button type="button" class="head" :aria-expanded="open" @click="open = !open">
      <span class="dot" :class="hasCreds ? '' : 'am'" aria-hidden="true"></span>
      <strong>{{ s.name }}</strong>
      <span class="muted small">{{ s.abbr }}</span>
      <span v-if="isCurrent" class="pill ac">当前</span>
      <span class="sp"></span>
      <span class="muted small">{{ s.parentSource === 'feishu' ? '飞书父体表' : '店铺扫描' }}</span>
      <span class="small" :style="hasCreds ? '' : 'color: var(--am)'">{{ hasCreds ? (scan.snapshot ? `${scan.snapshot.items} 个商品` : '凭证已填') : '缺凭证' }}</span>
      <ChevronRight class="chev" aria-hidden="true" />
    </button>

    <template v-if="open">
      <section>
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
      </section>

      <section v-if="s.parentSource === 'feishu'">
        <h5>飞书父体表</h5>
        <div class="fld">
          <AutoText :value="s.feishu.sheetUrl" :save="saver((v) => ({ feishu: { sheetUrl: v.trim() } }))" label="父体表链接" placeholder="https://….feishu.cn/wiki/… 或 /sheets/…" />
        </div>
        <div v-if="s.feishu.recentUrls.length" class="chips">
          <button v-for="r in s.feishu.recentUrls" :key="r.url" type="button" class="chip" :aria-pressed="r.url === s.feishu.sheetUrl" :title="r.url" @click="useRecent(r.url)">
            {{ r.title }}{{ r.url === s.feishu.sheetUrl ? '（当前）' : '' }}
          </button>
        </div>
        <div class="row">
          <button type="button" class="btn sm" :disabled="reading || !s.feishu.sheetUrl" @click="readSheet()">{{ reading ? '读取中…' : '读一下试试' }}</button>
          <Help label="父体表">平时不同步，每次跑到第 6 步时现读。表要给飞书应用阅读权限：在飞书里打开那张表，点右上角「…」→「更多」→「添加文档应用」。</Help>
        </div>
        <div v-if="sheet && !sheet.ok" class="warn rd" style="margin: 0">{{ sheet.message }}</div>
        <div v-else-if="sheet" class="chips">
          <span v-for="t in sheet.tabs" :key="t.title" class="chip" :title="t.error">{{ t.title }}<span class="rt">{{ t.error ? '读不了' : t.header ? `${t.count} 个父体` : '没有表头' }}</span></span>
        </div>
      </section>

      <section>
        <h5>SP-API 凭证</h5>
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
        <div class="kv small">
          <span class="muted">Client ID</span><span>{{ s.spapi.clientId || '未填' }}</span>
          <span class="muted">Secret</span><span>{{ s.spapi.clientSecret || '未填' }}</span>
          <span class="muted">Refresh Token</span><span>{{ s.spapi.refreshToken || '未填' }}</span>
        </div>
        <div class="row">
          <button type="button" class="btn sm" @click="picker?.click()">从文件导入</button>
          <button type="button" class="btn sm" @click="paste.open = !paste.open">粘贴文字</button>
          <button type="button" class="btn sm" :disabled="spTest === 'running'" @click="testSpapi">{{ spTest === 'running' ? '测试中…' : '测试连接' }}</button>
          <Help label="凭证">只写进「{{ s.name }}」，导入后只显示末 4 位。只读取店铺商品信息，不会修改任何商品；凭证只存在本机的 data 文件夹里。</Help>
        </div>
        <div v-if="spTest && spTest !== 'running'" class="row small"><span class="dot" :class="spTest.ok ? '' : 'rd'"></span>{{ spTest.message }}</div>
        <div v-if="paste.open" class="fld">
          <textarea v-model="paste.text" rows="4" :aria-label="`粘贴「${s.name}」的凭证`" placeholder="把包含店铺 ID、Client ID、Client Secret、Refresh Token 的文字粘贴进来"></textarea>
          <div><button type="button" class="btn sm pri" :disabled="!paste.text.trim()" @click="importText">导入到「{{ s.name }}」</button></div>
        </div>
        <input ref="picker" type="file" accept=".rtf,.txt,text/plain,application/rtf" hidden @change="importFile" />
      </section>

      <section>
        <h5>店铺商品</h5>
        <div class="row">
          <span v-if="scan.snapshot" class="small">{{ scannedAt }} 扫描 · {{ scan.snapshot.items }} 个商品 · 父体 {{ scan.snapshot.parents }} 个{{ scan.snapshot.truncated ? ' · 没扫全' : '' }}</span>
          <span v-else class="muted small">{{ scan.busy ? '正在扫描…' : '还没扫描过' }}</span>
          <button type="button" class="btn sm" :disabled="scan.busy" @click="rescan">{{ scan.busy ? '扫描中…' : '重新扫描' }}</button>
          <Help label="店铺商品">第 6 步挑父体、查重要用。平时自动扫，10 分钟内的结果直接用；刚在店里建了父体想马上用，就点「重新扫描」（要几十秒）。</Help>
        </div>
        <div v-if="scan.error" class="warn rd" style="margin: 0">{{ scan.error }}</div>
      </section>

      <div v-if="!isCurrent" class="foot">
        <button type="button" class="btn sm" :class="{ del: confirmDel }" @click="remove()">{{ confirmDel ? '再点一次删除' : '删除店铺' }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.card { border: 1px solid var(--hair); border-radius: var(--r-sm); background: var(--sf); }
.head { width: 100%; display: flex; gap: 8px; align-items: center; padding: 10px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; color: inherit; }
.chev { width: 14px; height: 14px; color: var(--faint); transition: transform 0.15s; }
.card.open .chev { transform: rotate(90deg); }
section { display: grid; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--hair); }
h5 { margin: 0; font-size: 12px; font-weight: 500; color: var(--sub); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
.sp { flex: 1; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.foot { padding: 8px 12px 12px; border-top: 1px solid var(--hair); display: flex; justify-content: flex-end; }
.btn.del { color: var(--rd); border-color: var(--rd); }
</style>
