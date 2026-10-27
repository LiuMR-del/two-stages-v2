<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import AutoText from './AutoText.vue'
import { api } from '../api'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { Settings } from '../types'

const st = useSettings()
const ui = useUi()
const p = computed(() => st.settings!.parent)

const MARKETS: Record<string, string> = { ATVPDKIKX0DER: '美国', A2EUQ1WTGCTBG2: '加拿大', A1AM78C64UM0Y8: '墨西哥' }

/** 打开开关后还缺什么 */
const missing = computed(() => {
  const out: string[] = []
  if (!p.value.sheetUrl) out.push('父体表链接')
  if (!p.value.feishu.appId || !p.value.feishu.appSecret) out.push('飞书 App ID / App Secret')
  const sp = p.value.spapi
  if (!sp.sellerId || !sp.clientId || !sp.clientSecret || !sp.refreshToken) out.push('SP-API 凭证')
  return out
})

function saver(build: (v: string) => Record<string, unknown>) {
  return async (v: string) => {
    try {
      await st.save({ parent: build(v) })
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

async function toggle(enabled: boolean) {
  await ui.act(() => st.save({ parent: { enabled } }))
}

const reading = ref(false)
const sheet = ref<null | { ok: boolean; message?: string; title?: string; tabs?: { title: string; count: number; header: boolean; error?: string }[] }>(null)
async function readSheet(url?: string) {
  reading.value = true
  sheet.value = null
  const r = await ui.act(() => api.post<NonNullable<typeof sheet.value>>('/settings/parent/test', url ? { url } : {}))
  reading.value = false
  sheet.value = r ?? null
  await ui.act(() => st.load())
}

async function useRecent(url: string) {
  await ui.act(() => st.save({ parent: { sheetUrl: url } }))
  await readSheet(url)
}

const picker = ref<HTMLInputElement | null>(null)
const paste = reactive({ open: false, text: '' })
async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  report(await ui.act(() => api.upload<{ found: Record<string, boolean>; settings: Settings }>('POST', '/settings/spapi/import', 'file', f)))
}
async function importText() {
  report(await ui.act(() => api.post<{ found: Record<string, boolean>; settings: Settings }>('/settings/spapi/import', { text: paste.text })))
}
const LABEL: Record<string, string> = { sellerId: '店铺 ID', clientId: 'Client ID', clientSecret: 'Client Secret', refreshToken: 'Refresh Token' }
function report(r: { found: Record<string, boolean>; settings: Settings } | undefined) {
  if (!r) return
  st.settings = r.settings
  paste.open = false
  paste.text = ''
  const got = Object.entries(r.found).filter(([, v]) => v).map(([k]) => LABEL[k])
  const lack = Object.entries(r.found).filter(([, v]) => !v).map(([k]) => LABEL[k])
  ui.toast(`已导入 ${got.join('、')}${lack.length ? `；没找到 ${lack.join('、')}` : ''}`, lack.length ? 'warn' : 'info')
}

const spTest = ref<{ ok: boolean; message: string } | 'running' | null>(null)
async function testSpapi() {
  spTest.value = 'running'
  spTest.value = (await ui.act(() => api.post<{ ok: boolean; message: string }>('/settings/spapi/test'))) ?? null
}
</script>

<template>
  <div class="grp">
    <h4>父体匹配</h4>
    <label class="sw">
      <input type="checkbox" :checked="p.enabled" @change="toggle(($event.target as HTMLInputElement).checked)" />
      识别父体（每张图跑完后从飞书父体表里挑父体，推算下一个变体名）
    </label>
    <div v-if="!p.enabled" class="muted tiny">关着时不读飞书、不调店铺接口，识别信息表和 CSV 里也不出现父体。</div>
    <template v-else>
      <div v-if="missing.length" class="warn" style="margin: 0">还缺：{{ missing.join('、') }}，补齐前第 6 步会跳过</div>
      <div class="muted tiny">打开后只对之后跑到第 6 步的图生效；已经完成的图要在详情里对第 6 步点「重新匹配」。</div>

      <h4>飞书</h4>
      <div class="two">
        <div class="fld">
          <label>App ID</label>
          <AutoText :value="p.feishu.appId" :save="saver((v) => ({ feishu: { appId: v.trim() } }))" label="飞书 App ID" placeholder="cli_..." />
        </div>
        <div class="fld">
          <label>App Secret</label>
          <AutoText :value="p.feishu.appSecret" :save="saver((v) => ({ feishu: { appSecret: v.trim() } }))" label="飞书 App Secret" secret />
        </div>
      </div>
      <div class="muted tiny">
        工具用这个飞书应用的身份读表，不用登录。父体表要给这个应用阅读权限：在飞书里打开那张表，点右上角「…」→「更多」→「添加文档应用」，选这个应用。换新表时也要加一次。
      </div>
      <div class="fld">
        <label>父体表链接</label>
        <AutoText :value="p.sheetUrl" :save="saver((v) => ({ sheetUrl: v.trim() }))" label="父体表链接" placeholder="https://….feishu.cn/wiki/… 或 /sheets/…" />
      </div>
      <div v-if="p.recentUrls.length" class="fld">
        <label>用过的链接</label>
        <div class="chips">
          <button v-for="r in p.recentUrls" :key="r.url" type="button" class="chip" :aria-pressed="r.url === p.sheetUrl" :title="r.url" @click="useRecent(r.url)">
            {{ r.title }}{{ r.url === p.sheetUrl ? '（当前）' : '' }}
          </button>
        </div>
      </div>
      <div class="row">
        <button type="button" class="btn sm" :disabled="reading || !p.sheetUrl" @click="readSheet()">{{ reading ? '读取中…' : '读一下试试' }}</button>
        <span class="muted tiny">平时不同步，每次跑到第 6 步时现读</span>
      </div>
      <div v-if="sheet && !sheet.ok" class="warn rd" style="margin: 0">{{ sheet.message }}</div>
      <div v-else-if="sheet" class="fld">
        <label>「{{ sheet.title }}」读到的标签页</label>
        <div class="chips">
          <span v-for="t in sheet.tabs" :key="t.title" class="chip" :title="t.error">{{ t.title }}<span class="rt">{{ t.error ? '这一页读不了' : t.header ? `${t.count} 个父体` : '没有「父体SKU」表头' }}</span></span>
        </div>
      </div>

      <h4>店铺 SP-API</h4>
      <div class="two">
        <div class="fld">
          <label>店铺 ID</label>
          <AutoText :value="p.spapi.sellerId" :save="saver((v) => ({ spapi: { sellerId: v.trim() } }))" label="店铺 ID" secret />
        </div>
        <div class="fld">
          <label>站点</label>
          <select :value="p.spapi.marketplaceId" aria-label="站点" @change="ui.act(() => st.save({ parent: { spapi: { marketplaceId: ($event.target as HTMLSelectElement).value } } }))">
            <option v-for="(name, id) in MARKETS" :key="id" :value="id">{{ name }}</option>
          </select>
        </div>
      </div>
      <div class="fld">
        <label>凭证</label>
        <div class="small">
          Client ID {{ p.spapi.clientId || '未填' }}　Secret {{ p.spapi.clientSecret || '未填' }}　Refresh Token {{ p.spapi.refreshToken || '未填' }}
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
        <textarea v-model="paste.text" rows="4" aria-label="粘贴凭证" placeholder="把包含店铺 ID、Client ID、Client Secret、Refresh Token 的文字粘贴进来"></textarea>
        <div><button type="button" class="btn sm pri" :disabled="!paste.text.trim()" @click="importText">导入</button></div>
      </div>
      <input ref="picker" type="file" accept=".rtf,.txt,text/plain,application/rtf" hidden @change="importFile" />
      <div class="muted tiny">只读取店铺商品信息，不会修改任何商品。凭证只存在本机的 data 文件夹里。</div>

      <div class="two">
        <div class="fld">
          <label>父体把握低于多少标「待确认」（0～1）</label>
          <AutoText :value="p.threshold.toFixed(2)" :save="saver((v) => ({ threshold: num(v, '把握阈值') }))" label="父体把握阈值" />
        </div>
        <div class="fld">
          <label>建议新建父体时的创建人标识</label>
          <AutoText :value="p.creatorMark" :save="saver((v) => ({ creatorMark: v.trim() }))" label="创建人标识" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
