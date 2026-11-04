<script setup lang="ts">
import { reactive } from 'vue'
import AutoText from './AutoText.vue'
import Help from './Help.vue'
import StoreCard from './StoreCard.vue'
import { api } from '../api'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { Settings } from '../types'

/** 设置「店铺」页签：店铺列表（一行概况，点开看全部）、新增店铺、SKU 命名 */
const st = useSettings()
const ui = useUi()

const adding = reactive({ open: false, name: '', abbr: '' })
async function addStore() {
  const r = await ui.act(() => api.post<{ id: string; settings: Settings }>('/stores', { name: adding.name.trim(), abbr: adding.abbr.trim() }))
  if (!r) return
  st.settings = r.settings
  adding.open = false
  adding.name = ''
  adding.abbr = ''
}

async function saveGroup(v: string) {
  try {
    await st.save({ sku: { group: v.trim() } })
  } catch (e) {
    ui.toast((e as Error).message, 'error')
    throw e
  }
}
</script>

<template>
  <div class="grp">
    <h4>
      店铺
      <Help label="店铺">每个店铺的凭证、父体表各存各的，导入凭证只写进那个店铺。新加的图用顶上「店铺」下拉选的店铺；队列里有图时不能换。</Help>
    </h4>
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
      <button v-if="!adding.open" type="button" class="btn sm" @click="adding.open = true">+ 新增店铺</button>
      <template v-else>
        <button type="button" class="btn sm pri" :disabled="!adding.name.trim() || !adding.abbr.trim()" @click="addStore">添加</button>
        <button type="button" class="btn sm" @click="adding.open = false">取消</button>
      </template>
    </div>
  </div>

  <div class="grp">
    <h4>
      SKU 命名
      <Help label="SKU 命名">
        子体 SKU = 店铺缩写-横竖版标记 + 材质缩写 + 年份末位 + 组别 + 月日 + 专属号 + 当天序号，如 HJ-mtfl671104001、HJ-HBxkfb671104001。
        材质缩写和横竖版标记（横版 HB、竖版 SB）在模版库里按品类、款式填；每个品类每天从 01 起，输出的图也用 SKU 命名。
      </Help>
    </h4>
    <div class="fld">
      <label>组别（7 = 深圳团队）</label>
      <AutoText :value="st.settings!.sku.group" :save="saveGroup" label="组别" />
    </div>
    <div class="muted tiny">专属号每一批默认 0，图生完后在「识别信息」上方点「改专属号」，一次改掉这一批所有 SKU。</div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
