<script setup lang="ts">
import { computed } from 'vue'
import AutoText from './AutoText.vue'
import Help from './Help.vue'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

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

</script>

<template>
  <div class="grp">
    <h4>识别父体</h4>
    <label class="sw">
      <input type="checkbox" :checked="p.enabled" @change="toggle(($event.target as HTMLInputElement).checked)" />
      每张图跑完后挑一个父体，推算下一个变体名
    </label>
    <div v-if="!p.enabled" class="muted tiny">关着时不读飞书、不调店铺接口，识别信息表和 CSV 里也不出现父体。</div>
    <template v-else>
      <div v-if="missing.length" class="warn" style="margin: 0">「{{ cur?.name }}」还缺：{{ missing.join('、') }}，补齐前第 6 步会跳过（去「店铺」页签填）</div>
      <div class="fld">
        <label class="lbl">把握低于多少标「待确认」（0～1）<Help label="把握阈值">待确认的不进「需处理」、不挡队列，子体 SKU 也先不按这个父体改；在详情第 6 步点候选或「搜索别的父体」确认。</Help></label>
        <AutoText :value="p.threshold.toFixed(2)" :save="saver((v) => ({ threshold: num(v, '把握阈值') }))" label="父体把握阈值" />
      </div>
      <div class="muted tiny row">
        当前店铺「{{ cur?.name }}」：{{ cur?.parentSource === 'feishu' ? '从飞书父体表里挑' : '从店铺里扫描的父体里挑' }}
        <Help label="父体怎么挑">
          焕捷这类有飞书父体表的店铺，按模版库品类的「父体表标签页」读表；爱睿特这类没有父体表的，按品类的「店铺商品类型」从店铺扫描结果里挑。
          都不合适时建议新建父体（不加专属号，如 HJ-cn-yklgj-Snowman），第一个变体名照同品类最近父体的写法。
          打开开关只对之后跑到第 6 步的图生效；已经完成的图要在详情里对第 6 步点「重新匹配」。
        </Help>
      </div>
    </template>
  </div>

  <div v-if="needFeishu" class="grp">
    <h4>飞书应用<span class="muted small" style="font-weight: 400">所有店铺共用</span></h4>
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
    <div class="muted tiny row">
      用这个应用的身份读父体表，不用登录
      <Help label="飞书应用">父体表要给这个应用阅读权限：在飞书里打开那张表，点右上角「…」→「更多」→「添加文档应用」，选这个应用。换新表时也要加一次。</Help>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.lbl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
