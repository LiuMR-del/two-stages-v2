import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import type { Settings } from '../types'

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

  return { settings, load, save, test }
})
