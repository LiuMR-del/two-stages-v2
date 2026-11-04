<script setup lang="ts">
import { computed, reactive } from 'vue'
import AutoText from './AutoText.vue'
import StoreCard from './StoreCard.vue'
import { api } from '../api'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { Settings } from '../types'

const st = useSettings()
const ui = useUi()
const p = computed(() => st.settings!.parent)
const cur = computed(() => st.currentStore)

/** 打开开关后当前店铺还缺什么 */
const missing = computed(() => {
  const out: string[] = []
  const s = cur.value
  if (!s) return out
  if (s.parentSource === 'feishu') {
    if (!s.feishu.sheetUrl) out.push('父体表链接')
    if (!p.value.feishu.appId || !p.value.feishu.appSecret) out.push('飞书 App ID / App Secret')
  }
  const sp = s.spapi
  if (!sp.sellerId || !sp.clientId || !sp.clientSecret || !sp.refreshToken) out.push('SP-API 凭证')
  return out
})
const needFeishu = computed(() => st.settings!.stores.some((s) => s.parentSource === 'feishu'))

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

const adding = reactive({ open: false, name: '', abbr: '' })
async function addStore() {
  const r = await ui.act(() => api.post<{ id: string; settings: Settings }>('/stores', { name: adding.name.trim(), abbr: adding.abbr.trim() }))
  if (!r) return
  st.settings = r.settings
  adding.open = false
  adding.name = ''
  adding.abbr = ''
}
</script>

<template>
  <div class="grp">
    <h4>父体匹配</h4>
    <label class="sw">
      <input type="checkbox" :checked="p.enabled" @change="toggle(($event.target as HTMLInputElement).checked)" />
      识别父体（每张图跑完后挑一个父体，推算下一个变体名）
    </label>
    <div v-if="!p.enabled" class="muted tiny">关着时不读飞书、不调店铺接口，识别信息表和 CSV 里也不出现父体。</div>
    <template v-else>
      <div v-if="missing.length" class="warn" style="margin: 0">「{{ cur?.name }}」还缺：{{ missing.join('、') }}，补齐前第 6 步会跳过</div>
      <div v-else-if="cur?.parentSource === 'store'" class="warn" style="margin: 0">「{{ cur.name }}」从店铺扫描父体还没做好，做好前第 6 步会先跳过</div>
      <div class="muted tiny">打开后只对之后跑到第 6 步的图生效；已经完成的图要在详情里对第 6 步点「重新匹配」。</div>
      <div class="two">
        <div class="fld">
          <label>父体把握低于多少标「待确认」（0～1）</label>
          <AutoText :value="p.threshold.toFixed(2)" :save="saver((v) => ({ threshold: num(v, '把握阈值') }))" label="父体把握阈值" />
        </div>
        <div class="fld">
          <label>建议新建的父体</label>
          <div class="muted small">不加专属号，如 HJ-cn-yklgj-Snowman</div>
        </div>
      </div>
    </template>

    <template v-if="needFeishu">
      <h4>飞书应用（所有店铺共用）</h4>
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
    </template>

    <h4>店铺</h4>
    <div class="muted tiny">每个店铺的凭证、父体表各存各的，导入凭证只写进那个店铺。只读取店铺商品信息，不会修改任何商品；凭证只存在本机的 data 文件夹里。</div>
    <StoreCard v-for="s in st.settings!.stores" :key="s.id" :store="s" />
    <div v-if="adding.open" class="two">
      <div class="fld">
        <label>店铺名称</label>
        <input v-model="adding.name" aria-label="新店铺名称" placeholder="如 熵玖铄" />
      </div>
      <div class="fld">
        <label>店铺缩写</label>
        <input v-model="adding.abbr" aria-label="新店铺缩写" placeholder="如 SJS" />
      </div>
    </div>
    <div class="row">
      <button v-if="!adding.open" type="button" class="btn sm" @click="adding.open = true">新增店铺</button>
      <template v-else>
        <button type="button" class="btn sm pri" :disabled="!adding.name.trim() || !adding.abbr.trim()" @click="addStore">添加</button>
        <button type="button" class="btn sm" @click="adding.open = false">取消</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
