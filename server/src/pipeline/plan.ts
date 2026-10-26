import fs from 'node:fs'
import path from 'node:path'
import type { Library } from '../library/schema'
import type { ImageStore } from '../library/images'
import type { Attention, Job, Plan } from '../store/jobs'
import { mainPlanFor, type PlanMain } from '../prompts/main'
import { extractPromptFor } from '../prompts/extract'
import { labelOf } from '../prompts/placeholders'
import { writeFileAtomic } from '../store/atomic'

export type PlanResult =
  | { ok: true; plan: Plan; names: { categoryName: string; styleName: string; ratio: string } }
  | { ok: false; attention: Omit<Attention, 'at'> }

/** 进入 ② 时把白底图或参考图复制进任务目录，之后改模版库不影响这张图 */
export function planImageFile(jobDir: string, hash: string): string | null {
  for (const ext of ['png', 'jpg', 'webp']) {
    const f = path.join(jobDir, `plan_${hash}.${ext}`)
    if (fs.existsSync(f)) return f
  }
  return null
}

async function copyPlanImage(images: ImageStore, jobDir: string, main: PlanMain): Promise<void> {
  if (!main.image) return
  if (planImageFile(jobDir, main.image.hash)) return
  const { buffer, ext } = await images.read(main.image.hash)
  await writeFileAtomic(path.join(jobDir, `plan_${main.image.hash}.${ext}`), buffer)
}

/**
 * scope 为 'main' 时只重新解析 ③ 的模版部分（从 ③ 重做），提取提示词沿用原来的。
 */
export async function resolvePlan(job: Job, lib: Library, images: ImageStore, jobDir: string, scope: 'all' | 'main' = 'all'): Promise<PlanResult> {
  const route = job.route
  const cat = route && lib.categories.find((c) => c.id === route.categoryId)
  const style = cat?.styles.find((s) => s.id === route!.styleId)
  if (!route || !cat || !style) {
    return { ok: false, attention: { kind: 'nomatch', step: scope === 'main' ? 2 : 1, message: '品类或款式已被删除', guess: route?.categoryName } }
  }
  const { main, missingWhite } = mainPlanFor(lib, cat, style)
  if (missingWhite) {
    return {
      ok: false,
      attention: {
        kind: 'nowhite',
        step: scope === 'main' ? 2 : 1,
        message: `「${labelOf(cat.name, style.name)}」还没有白底图，上传后这张图会自动继续`,
      },
    }
  }
  await copyPlanImage(images, jobDir, main)
  const extractPrompt = scope === 'main' && job.plan ? job.plan.extractPrompt : extractPromptFor(lib, cat, style)
  return { ok: true, plan: { extractPrompt, main }, names: { categoryName: cat.name, styleName: style.name, ratio: style.ratio } }
}
