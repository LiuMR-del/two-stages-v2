import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import type { Checks, ExtractRecipe, Library, Recipe } from '../types'

type Payload = { library: Library; checks: Checks }

export const useLibrary = defineStore('library', () => {
  const library = ref<Library | null>(null)
  const checks = ref<Checks>({})
  /** 每次模版库变化加一，配方预览据此重新拉取 */
  const version = ref(0)
  const recipes = new Map<string, Promise<Recipe>>()
  const extracts = new Map<string, Promise<ExtractRecipe>>()

  function apply(p: Payload) {
    library.value = p.library
    checks.value = p.checks
    recipes.clear()
    extracts.clear()
    version.value++
  }

  async function load() {
    apply(await api.get<Payload>('/library'))
  }

  function recipe(cid: string, sid: string, tid: string): Promise<Recipe> {
    const key = `${cid}|${sid}|${tid}`
    let p = recipes.get(key)
    if (!p) {
      p = api.get<Recipe>(`/library/recipe?cid=${encodeURIComponent(cid)}&sid=${encodeURIComponent(sid)}&tid=${encodeURIComponent(tid)}`)
      p.catch(() => recipes.delete(key))
      recipes.set(key, p)
    }
    return p
  }

  function extractRecipe(cid: string, sid: string): Promise<ExtractRecipe> {
    const key = `${cid}|${sid}`
    let p = extracts.get(key)
    if (!p) {
      p = api.get<ExtractRecipe>(`/library/extract-recipe?cid=${encodeURIComponent(cid)}&sid=${encodeURIComponent(sid)}`)
      p.catch(() => extracts.delete(key))
      extracts.set(key, p)
    }
    return p
  }

  const categories = computed(() => library.value?.categories ?? [])
  const category = (id: string | null | undefined) => categories.value.find((c) => c.id === id)

  /** 写接口统一返回最新的 { library, checks } */
  async function mutate<T extends Partial<Payload>>(fn: () => Promise<T>): Promise<T> {
    const r = await fn()
    if (r && r.library && r.checks) apply({ library: r.library, checks: r.checks })
    return r
  }

  return { library, checks, version, apply, load, recipe, extractRecipe, categories, category, mutate }
})
