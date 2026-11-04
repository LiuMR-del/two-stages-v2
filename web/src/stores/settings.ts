import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import type { Settings, Store } from '../types'

export const useSettings = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)

  async function load() {
    settings.value = await api.get<Settings>('/settings')
  }

  async function save(patch: Record<string, unknown>) {
    settings.value = await api.put<Settings>('/settings', patch)
  }

  async function test(kind: 'image' | 'analysis') {
    return api.post<{ ok: boolean; message: string }>('/settings/test', { kind })
  }

  /** 新的一批用的店铺 */
  const currentStore = computed<Store | null>(() => {
    const s = settings.value
    return s ? (s.stores.find((x) => x.id === s.currentStoreId) ?? s.stores[0] ?? null) : null
  })

  async function saveStore(id: string, patch: Record<string, unknown>) {
    settings.value = await api.patch<Settings>(`/stores/${encodeURIComponent(id)}`, patch)
  }

  return { settings, load, save, test, currentStore, saveStore }
})
