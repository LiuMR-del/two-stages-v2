import fs from 'node:fs'
import path from 'node:path'
import type { Bus } from '../events/bus'
import type { Limiter } from '../ai/limiter'
import type { ApiKind, SettingsStore } from '../store/settings'
import { resolveOutputDir } from '../store/settings'
import type { LibraryStore } from '../library/store'
import {
  currentStep,
  isFinished,
  markDone,
  markSkipped,
  resetFrom,
  runningStep,
  STEP_NAMES,
  STEP_COUNT,
  PARENT_STEP,
  transition,
  type Attention,
  type Job,
  type JobStore,
} from '../store/jobs'
import type { JobPatch, StepCtx, StepEnv, StepHandler, StepResult } from '../pipeline/types'
import { step0Route } from '../pipeline/step0Route'
import { step1Extract } from '../pipeline/step1Extract'
import { step2Main } from '../pipeline/step2Main'
import { step3Info } from '../pipeline/step3Info'
import { step4Blank } from '../pipeline/step4Blank'
import { step5Parent } from '../pipeline/step5Parent'
import { bindExisting, guard, ParentPauseError, parentSkipReason, shiftNumber } from '../parent/match'
import type { FeishuSheets } from '../parent/feishu'
import type { SpapiClient } from '../parent/spapi'
import type { Reservations } from '../parent/reservations'
import { resolvePlan } from '../pipeline/plan'
import { assignOutputBase, outputRel, safeName, writeOutput } from '../pipeline/output'
import { SkuCounter } from '../pipeline/sku'
import { JOB_FILES } from '../pipeline/files'
import fsp from 'node:fs/promises'
import { writeBatchCsv } from '../pipeline/csv'
import { removeJobImage } from '../pipeline/files'
import { withRetry, MAX_ATTEMPTS } from '../ai/retry'
import { AiError, CancelledError, ERROR_LABEL, RETRYABLE } from '../ai/errors'
import { HttpError } from '../util/errors'
import { log } from '../util/log'
import { ops } from '../library/store'
import { KeyedMutex } from '../util/mutex'
import { readJsonSync, writeFileAtomicSync } from '../store/atomic'

/** 第②步提取完、第③步生成完，等验收时这一步占的是分析并发 */
export const kindOf = (step: number, job?: Pick<Job, 'qc' | 'mainQc'>): ApiKind =>
  step === 0 || step === 3 || step === PARENT_STEP || (step === 1 && job?.qc?.state === 'pending') || (step === 2 && job?.mainQc?.state === 'pending') ? 'analysis' : 'image'

/** 正在验收时，日志和提示里用验收的名字 */
const phaseName = (job: Job, i: number) =>
  i === 1 && job.qc?.state === 'pending' ? '素材图验收' : i === 2 && job.mainQc?.state === 'pending' ? '主图验收' : STEP_NAMES[i]

const DEFAULT_HANDLERS: StepHandler[] = [step0Route, step1Extract, step2Main, step3Info, step4Blank, step5Parent]

const AUTH_MESSAGE: Record<ApiKind, string> = { image: '生图接口 Key 无效或无权限', analysis: '分析接口 Key 无效或无权限' }

export type QueueState = {
  paused: null | { by: 'user' | 'auth'; kind?: ApiKind; message: string }
  /** 第 6 步单独暂停（飞书 / SP-API 凭证、权限问题），前 5 步照常 */
  parentPaused: string | null
  slots: Record<ApiKind, { busy: number; limit: number }>
}

type Running = { step: number; kind: ApiKind; ctrl: AbortController; done: Promise<void> }

export type SchedulerDeps = {
  jobs: JobStore
  library: LibraryStore
  settings: SettingsStore
  limiter: Limiter
  bus: Bus
  handlers?: StepHandler[]
  /** 记住「暂停队列」，重启后仍然暂停；不给就只记在内存里 */
  stateFile?: string
  /** 第 6 步用的飞书读表和 SP-API；单元测试不给时第 6 步一律当作凭证问题 */
  parent?: { sheets: FeishuSheets; spapi: SpapiClient; reservations?: Reservations }
  /** 每批识别信息 CSV 的行记在这里，移出队列的图的行不丢 */
  csvRowsDir?: string
  /** 子体 SKU 当天序号；不给就只记在内存里 */
  sku?: SkuCounter
}

export class Scheduler {
  private busy: Record<ApiKind, number> = { image: 0, analysis: 0 }
  private running = new Map<string, Running>()
  private userPaused = false
  private authPaused: Partial<Record<ApiKind, string>> = {}
  private parentPaused: string | null = null
  private parentLock = new KeyedMutex()
  private holds = new Set<string>()
  private tickQueued = false
  private stopped = false
  private handlers: StepHandler[]
  private releasing: Promise<void> = Promise.resolve()
  private csvLock = new KeyedMutex()
  readonly env: StepEnv

  private sku: SkuCounter

  constructor(private d: SchedulerDeps) {
    this.handlers = d.handlers ?? DEFAULT_HANDLERS
    this.sku = d.sku ?? new SkuCounter(null)
    if (d.stateFile) this.userPaused = readJsonSync<{ paused?: boolean }>(d.stateFile)?.paused === true
    this.env = {
      settings: () => d.settings.get(),
      library: d.library,
      outputDir: () => resolveOutputDir(d.settings.get()),
      onFidelityDowngrade: async (message) => {
        if (!d.settings.get().image.sendFidelity) return
        await d.settings.update({ image: { sendFidelity: false, fidelityAutoDisabled: true } })
        log.warn(`中转站不支持保真参数（${message}），已自动关闭，之后的请求不再带 quality / input_fidelity`)
        d.bus.toast('warn', '中转站不支持保真参数，已自动关闭')
      },
      parent: {
        sheets: d.parent?.sheets ?? (null as unknown as FeishuSheets),
        spapi: d.parent?.spapi ?? (null as unknown as SpapiClient),
        mutex: this.parentLock,
        jobs: () => d.jobs.list(),
        reservations: d.parent?.reservations,
      },
    }
  }

  // ---- 生命周期 ----

  /** 启动复位：running 一律改回 pending（attempts 不变） */
  recover(): void {
    for (const job of this.d.jobs.list()) {
      const r = runningStep(job)
      if (r >= 0) this.d.jobs.update(job.id, (j) => transition(j, r, 'pending'))
    }
  }

  stop(): void {
    this.stopped = true
    for (const r of this.running.values()) r.ctrl.abort()
  }

  queueState(): QueueState {
    let paused: QueueState['paused'] = null
    if (this.userPaused) paused = { by: 'user', message: '队列已暂停' }
    else {
      const k = (['image', 'analysis'] as const).find((x) => this.authPaused[x])
      if (k) paused = { by: 'auth', kind: k, message: this.authPaused[k]! }
    }
    return {
      paused,
      parentPaused: this.parentPaused,
      slots: {
        image: { busy: this.busy.image, limit: this.d.limiter.limit('image') },
        analysis: { busy: this.busy.analysis, limit: this.d.limiter.limit('analysis') },
      },
    }
  }

  private emitQueue(): void {
    this.d.bus.emit('queue', this.queueState())
  }

  private savePaused(): void {
    if (!this.d.stateFile) return
    try {
      writeFileAtomicSync(this.d.stateFile, JSON.stringify({ paused: this.userPaused }))
    } catch (e) {
      log.warn(`保存暂停状态失败：${(e as Error).message}`)
    }
  }

  pause(): void {
    this.userPaused = true
    this.savePaused()
    this.emitQueue()
  }

  resume(): void {
    this.userPaused = false
    this.savePaused()
    this.authPaused = {}
    this.emitQueue()
    this.tick()
  }

  /** 设置保存后：解除 401 暂停 */
  onSettingsSaved(): void {
    if (Object.keys(this.authPaused).length) {
      this.authPaused = {}
      log.info('设置已保存，解除接口暂停')
    }
    if (this.parentPaused) {
      this.parentPaused = null
      this.d.parent?.sheets.clear()
      log.info('设置已保存，第 6 步「匹配父体」继续')
    }
    this.emitQueue()
    this.tick()
  }

  isIdle(): boolean {
    if (this.running.size > 0) return false
    if (this.userPaused) return true
    return !this.d.jobs.list().some((j) => this.dispatchableStep(j) >= 0)
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId)
  }

  // ---- 调度 ----

  tick(): void {
    if (this.tickQueued) return
    this.tickQueued = true
    queueMicrotask(() => {
      this.tickQueued = false
      this.doTick()
    })
  }

  private dispatchableStep(job: Job): number {
    if (job.attention || job.paused || this.holds.has(job.id)) return -1
    const i = currentStep(job)
    if (i < 0 || job.steps[i]!.state !== 'pending') return -1
    // 识别父体关着 / 缺设置：doTick 里直接跳过，不受分析接口暂停影响
    if (i === PARENT_STEP && parentSkipReason(this.d.settings.get())) return i
    if (this.authPaused[kindOf(i, job)]) return -1
    if (i === PARENT_STEP && this.parentPaused) return -1
    return i
  }

  private doTick(): void {
    if (this.userPaused || this.stopped) return
    for (const job of this.d.jobs.list()) {
      const i = this.dispatchableStep(job)
      if (i < 0) continue
      // 识别父体关着或缺设置：第 6 步直接跳过，不占并发、不发任何请求
      if (i === PARENT_STEP) {
        const why = parentSkipReason(this.d.settings.get())
        if (why) {
          this.d.jobs.update(job.id, (j) => {
            markSkipped(j, PARENT_STEP)
            j.steps[PARENT_STEP]!.note = why
          })
          continue
        }
      }
      const k = kindOf(i, job)
      if (this.d.limiter.inCooldown(k)) continue
      if (this.busy[k] >= this.d.limiter.limit(k)) continue
      this.start(job, i)
    }
  }

  private start(job: Job, i: number): void {
    const k = kindOf(i, job)
    this.d.jobs.update(job.id, (j) => {
      transition(j, i, 'running')
      delete j.steps[i]!.error
    })
    this.busy[k]++
    const ctrl = new AbortController()
    const entry: Running = { step: i, kind: k, ctrl, done: Promise.resolve() }
    this.running.set(job.id, entry)
    this.emitQueue()
    entry.done = this.run(job.id, i, k, ctrl)
  }

  private async run(jobId: string, i: number, k: ApiKind, ctrl: AbortController): Promise<void> {
    const job = this.d.jobs.get(jobId)!
    const dir = this.d.jobs.dirOf(jobId)
    const update = (fn: (j: Job) => void) => {
      if (this.d.jobs.get(jobId)) this.d.jobs.update(jobId, fn)
    }
    const ctx: StepCtx = {
      env: this.env,
      job,
      dir,
      signal: ctrl.signal,
      retry: (fn) =>
        withRetry(fn, {
          // 第 6 步要串行发好几个请求（读表、问 AI、查父体、查子体），每个请求单独计重试次数
          attemptsSoFar: i === PARENT_STEP ? 0 : job.steps[i]!.attempts,
          signal: ctrl.signal,
          onAttempt: (n, err) =>
            update((j) => {
              j.steps[i]!.attempts = n
              if (err) j.steps[i]!.error = err.message
            }),
          onRetryWait: (n, ms, err) =>
            log.warn(`「${job.source.originalName}」${phaseName(job, i)}第 ${n} 次失败（${err.message}），${Math.round(ms / 1000)} 秒后重试`),
        }),
      setSnapshot: (s) => update((j) => (j.steps[i]!.snapshot = s)),
      commit: (patch) => {
        if (this.d.jobs.get(jobId)) this.applyPatch(jobId, patch)
      },
    }

    let result: StepResult | null = null
    let error: unknown = null
    try {
      result = await this.handlers[i]!(ctx)
    } catch (e) {
      error = e
    }

    this.running.delete(jobId)
    this.busy[k]--
    try {
      if (this.d.jobs.get(jobId) && this.d.jobs.get(jobId)!.steps[i]!.state === 'running') {
        if (result) this.applyResult(jobId, i, result)
        else this.applyError(jobId, i, k, error)
      }
    } catch (e) {
      log.error(`处理第 ${i + 1} 步结果时出错：${(e as Error).stack ?? e}`)
    }
    this.emitQueue()
    this.tick()
  }

  private applyPatch(jobId: string, patch: JobPatch): void {
    this.d.jobs.update(jobId, (j) => {
      const prevCat = j.route?.categoryId
      const prev = j.route?.categoryName
      patch(j)
      if (!j.route) return
      // 定下（或换了）品类才发 SKU；同一品类重做、品类改名都不换号
      const newCat = j.route.categoryId !== prevCat
      if (newCat) j.sku = this.allocSku(j)
      if (newCat || j.route.categoryName !== prev) {
        j.outputBase = j.sku ?? assignOutputBase(j, this.d.jobs.list(), this.env.outputDir(), j.route.categoryName)
      }
    })
  }

  /** 品类没填材质缩写就不发 SKU，文件名照旧用原图名 */
  private allocSku(j: Job): string | null {
    const code = this.d.library.get().categories.find((c) => c.id === j.route!.categoryId)?.skuCode?.trim()
    if (!code) return null
    const s = this.d.settings.get()
    const others = this.d.jobs.list().filter((o) => o.id !== j.id)
    const dir = path.join(this.env.outputDir(), j.outputFolder, safeName(j.route!.categoryName))
    const taken = (sku: string) =>
      others.some((o) => o.sku?.toLowerCase() === sku.toLowerCase()) ||
      fs.existsSync(path.join(dir, outputRel('main', sku))) ||
      fs.existsSync(path.join(dir, outputRel('pattern', sku)))
    return this.sku.allocate({ store: s.sku.store, code, region: s.sku.region, mark: s.parent.creatorMark }, taken)
  }

  private applyResult(jobId: string, i: number, r: StepResult): void {
    if (r.patch) this.applyPatch(jobId, r.patch)
    this.d.jobs.update(jobId, (j) => {
      const s = j.steps[i]!
      if (r.kind === 'done') {
        transition(j, i, 'done')
        delete s.error
        if (r.output) s.output = r.output
        if (r.skipNext && i + 1 < j.steps.length) markSkipped(j, i + 1)
      } else if (r.kind === 'skipped') {
        transition(j, i, 'skipped')
        delete s.error
      } else if (r.kind === 'requeue') {
        transition(j, i, 'pending')
        delete s.error
      } else {
        transition(j, i, r.state)
        if (r.state === 'failed') s.error = r.attention.message
        j.attention = { ...r.attention, at: new Date().toISOString() }
        log.warn(`「${j.source.originalName}」需处理：${r.attention.message}`)
      }
    })
    if (r.kind === 'done' && (i === 3 || i === PARENT_STEP)) void this.rewriteCsv(this.d.jobs.get(jobId)!.outputFolder)
  }

  /** 同一批的 CSV 串行重写，内容在真正写的时候才生成，后写的一定是最新的 */
  rewriteCsv(folder: string): Promise<void> {
    return this.csvLock
      .run(folder, () => writeBatchCsv(this.env.outputDir(), this.d.jobs.list(), folder, this.d.csvRowsDir && path.join(this.d.csvRowsDir, `${folder}.json`)))
      .catch((e) => log.error(`写识别信息 CSV 失败：${(e as Error).message}`))
  }

  private applyError(jobId: string, i: number, k: ApiKind, e: unknown): void {
    const name = STEP_NAMES[i]
    const job = this.d.jobs.get(jobId)!
    if (e instanceof CancelledError) {
      this.d.jobs.update(jobId, (j) => transition(j, i, 'pending'))
      return
    }
    if (e instanceof AiError && e.type === 'rateLimit') {
      const wait = this.d.limiter.on429(k, e.retryAfterSec)
      log.warn(`${k === 'image' ? '生图' : '分析'}接口限流，${Math.round(wait / 1000)} 秒后继续，并发临时降低`)
      this.d.jobs.update(jobId, (j) => {
        transition(j, i, 'pending')
        j.steps[i]!.error = '被限流，稍后自动继续'
      })
      return
    }
    if (e instanceof ParentPauseError) {
      const first = !this.parentPaused
      this.parentPaused = e.message
      if (first) {
        log.error(`第 6 步「匹配父体」暂停：${e.message}`)
        this.d.bus.toast('error', `匹配父体暂停：${e.message}。去设置里处理好后会自动继续，前面的步骤不受影响`)
      }
      this.d.jobs.update(jobId, (j) => {
        transition(j, i, 'pending')
        j.steps[i]!.error = e.message
      })
      return
    }
    if (e instanceof AiError && e.type === 'auth') {
      this.authPaused[k] = AUTH_MESSAGE[k]
      log.error(`${AUTH_MESSAGE[k]}，暂停这一类步骤：${e.message}`)
      this.d.bus.toast('error', `${AUTH_MESSAGE[k]}，相关步骤已暂停，请到设置里检查`)
      this.d.jobs.update(jobId, (j) => {
        transition(j, i, 'pending')
        j.steps[i]!.error = e.message
      })
      return
    }
    let attention: Omit<Attention, 'at'>
    if (e instanceof AiError && e.type === 'refused') {
      attention = { kind: 'refused', step: i, message: `内容被拒：${e.message}` }
    } else if (e instanceof AiError) {
      const attempts = job.steps[i]!.attempts
      const tail = RETRYABLE.has(e.type) && attempts >= MAX_ATTEMPTS ? `重试 ${MAX_ATTEMPTS - 1} 次仍失败（${e.message}）` : `${ERROR_LABEL[e.type]}：${e.message}`
      attention = { kind: 'failed', step: i, message: `${phaseName(job, i)}失败：${tail}` }
    } else {
      attention = { kind: 'failed', step: i, message: `${name}失败：${(e as Error)?.message ?? String(e)}` }
      log.error(`「${job.source.originalName}」${name}出错：${(e as Error)?.stack ?? e}`)
    }
    this.d.jobs.update(jobId, (j) => {
      transition(j, i, 'failed')
      j.steps[i]!.error = attention.message
      j.attention = { ...attention, at: new Date().toISOString() }
    })
    log.warn(`「${job.source.originalName}」需处理：${attention.message}`)
  }

  // ---- 模版库变化：等白底图的任务自动放行 ----

  onLibraryChanged(): void {
    this.releasing = this.releasing.then(() => this.releaseNowhite()).catch((e) => log.error(`检查等白底图的任务出错：${(e as Error).message}`))
  }

  private async releaseNowhite(): Promise<void> {
    let n = 0
    for (const job of this.d.jobs.list()) {
      if (job.attention?.kind !== 'nowhite' || this.holds.has(job.id)) continue
      const scope = job.attention.step === 2 ? 'main' : 'all'
      const r = await resolvePlan(job, this.d.library.get(), this.d.library.images, this.d.jobs.dirOf(job.id), scope)
      if (!r.ok || this.d.jobs.get(job.id)?.attention?.kind !== 'nowhite') continue
      this.applyPatch(job.id, (j) => {
        j.plan = r.plan
        Object.assign(j.route!, r.names)
        j.attention = null
        this.d.jobs.moveToEnd(j)
      })
      n++
    }
    if (n > 0) {
      this.d.bus.toast('info', `${n} 张等白底图的图已回到队列`)
      log.info(`${n} 张等白底图的图已回到队列`)
    }
    this.tick()
  }

  // ---- 用户操作 ----

  private async hold<T>(jobId: string, fn: (job: Job) => Promise<T>): Promise<T> {
    const job = this.d.jobs.get(jobId)
    if (!job) throw new HttpError(404, '这张图已经不在队列里了')
    if (this.holds.has(jobId)) throw new HttpError(409, '这张图正在处理上一个操作，请稍等')
    this.holds.add(jobId)
    try {
      return await fn(job)
    } finally {
      this.holds.delete(jobId)
      this.tick()
    }
  }

  private async abortRunning(jobId: string): Promise<void> {
    const r = this.running.get(jobId)
    if (!r) return
    r.ctrl.abort()
    await r.done
  }

  private routeFor(categoryId: string, styleId?: string) {
    const lib = this.d.library.get()
    const cat = lib.categories.find((c) => c.id === categoryId)
    if (!cat) throw new HttpError(400, '选择的品类不存在')
    const style = styleId ? cat.styles.find((s) => s.id === styleId) : cat.styles.length === 1 ? cat.styles[0] : undefined
    if (!style) throw new HttpError(400, cat.styles.length > 1 ? `「${cat.name}」有多个款式，请选一个` : '选择的款式不存在')
    return { categoryId: cat.id, styleId: style.id, categoryName: cat.name, styleName: style.name, ratio: style.ratio, confidence: null, reason: null, manual: true }
  }

  /** wholePhoto：第①步给的印刷面区域不对时，从第②步重做并改按整张竞品图提取 */
  async redo(jobId: string, p: { step: number; prompt?: string; categoryId?: string; styleId?: string; wholePhoto?: boolean }): Promise<Job> {
    return this.hold(jobId, async (job) => {
      const n = p.step
      if (!Number.isInteger(n) || n < 0 || n >= STEP_COUNT) throw new HttpError(400, '步骤编号不对')
      if (!['done', 'skipped', 'failed'].includes(job.steps[n]!.state)) throw new HttpError(400, `「${STEP_NAMES[n]}」还没跑完，不能重做`)
      const route = n === 0 && p.categoryId ? this.routeFor(p.categoryId, p.styleId) : null
      const r = runningStep(job)
      if (r >= n) await this.abortRunning(jobId)
      const dir = this.d.jobs.dirOf(jobId)
      const planR = n === 2 ? await resolvePlan(job, this.d.library.get(), this.d.library.images, dir, 'main') : null
      this.applyPatch(jobId, (j) => {
        resetFrom(j, n)
        j.attention = null
        j.paused = false
        j.override = p.prompt?.trim() ? { step: n, prompt: p.prompt } : null
        if (p.wholePhoto && n >= 1) j.face = null
        if (n <= 3) j.info = null
        if (n <= 1) j.plan = null
        if (planR?.ok) {
          j.plan = planR.plan
          Object.assign(j.route!, planR.names)
        } else if (planR) {
          j.attention = { ...planR.attention, at: new Date().toISOString() }
        }
        if (route) {
          j.route = route
          markDone(j, 0)
        }
      })
      const stepOfFile = { face: 1, pattern: 1, main: 2, blank: 4 } as const
      const kinds = (['face', 'pattern', 'main', 'blank'] as const).filter((k) => stepOfFile[k] >= n)
      await Promise.all(kinds.map((k) => removeJobImage(dir, k)))
      log.info(`「${job.source.originalName}」从「${STEP_NAMES[n]}」重做${p.prompt?.trim() ? '（这一次用修改过的提示词）' : ''}`)
      return this.d.jobs.get(jobId)!
    })
  }

  async resolve(jobId: string, categoryId: string, styleId?: string): Promise<Job> {
    return this.hold(jobId, async (job) => {
      if (job.attention?.kind !== 'nomatch') throw new HttpError(400, '这张图不需要指定品类')
      const route = this.routeFor(categoryId, styleId)
      await this.assignRoute(job, route)
      return this.d.jobs.get(jobId)!
    })
  }

  private async assignRoute(job: Job, route: NonNullable<Job['route']>): Promise<void> {
    await this.abortRunning(job.id)
    this.applyPatch(job.id, (j) => {
      resetFrom(j, 1)
      j.route = route
      markDone(j, 0)
      j.plan = null
      j.info = null
      j.override = null
      j.attention = null
      this.d.jobs.moveToEnd(j)
    })
    const dir = this.d.jobs.dirOf(job.id)
    await Promise.all((['face', 'pattern', 'main', 'blank'] as const).map((k) => removeJobImage(dir, k)))
  }

  async createCategory(jobId: string): Promise<Job> {
    return this.hold(jobId, async (job) => {
      if (job.attention?.kind !== 'nomatch') throw new HttpError(400, '这张图不需要新建品类')
      const name = job.attention.guess?.trim()
      if (!name) throw new HttpError(400, 'AI 没有给出品类名，请从下拉框里选择品类')
      let cat = this.d.library.get().categories.find((c) => c.name === name)
      if (!cat) cat = await this.d.library.mutate((d) => ops.addCategory(d, name.slice(0, 20)))
      await this.assignRoute(job, this.routeFor(cat.id, cat.styles[0]!.id))
      const fresh = this.d.jobs.get(jobId)!
      const r = await resolvePlan(fresh, this.d.library.get(), this.d.library.images, this.d.jobs.dirOf(jobId))
      this.applyPatch(jobId, (j) => {
        if (r.ok) {
          j.plan = r.plan
          Object.assign(j.route!, r.names)
        } else {
          j.attention = { ...r.attention, at: new Date().toISOString() }
        }
      })
      log.info(`按 AI 猜测新建品类「${cat.name}」并指定给「${job.source.originalName}」`)
      return this.d.jobs.get(jobId)!
    })
  }

  async retry(jobId: string): Promise<Job> {
    return this.hold(jobId, async (job) => {
      const a = job.attention
      if (!a || (a.kind !== 'failed' && a.kind !== 'refused')) throw new HttpError(400, '这张图不需要重试')
      this.d.jobs.update(jobId, (j) => {
        const s = j.steps[a.step]!
        if (s.state !== 'pending') transition(j, a.step, 'pending')
        s.attempts = 0
        delete s.error
        j.attention = null
        this.d.jobs.moveToEnd(j)
      })
      return this.d.jobs.get(jobId)!
    })
  }

  /** 素材图或主图没过验收，用户选「仍然使用」：跳过这次验收，后面的步骤接着跑 */
  async acceptQc(jobId: string): Promise<Job> {
    return this.hold(jobId, async (job) => {
      const step = job.attention?.kind === 'qc' ? job.attention.step : -1
      if (step !== 1 && step !== 2) throw new HttpError(400, '这张图不需要处理验收')
      const kind = step === 1 ? 'pattern' : 'main'
      const label = step === 1 ? '素材图' : '主图'
      const buf = await fsp.readFile(this.d.jobs.fileOf(jobId, JOB_FILES[kind])).catch(() => null)
      if (!buf) throw new HttpError(400, `${label}文件不在了，请重做这一步`)
      await writeOutput(this.env.outputDir(), job, kind, buf)
      const reasons = (step === 1 ? job.qc : job.mainQc)?.reasons.join('；') ?? ''
      this.d.jobs.update(jobId, (j) => {
        markDone(j, step)
        j.steps[step]!.output = JOB_FILES[kind]
        delete j.steps[step]!.error
        const q = step === 1 ? j.qc : j.mainQc
        if (q) q.state = 'bypassed'
        j.attention = null
      })
      log.info(`「${job.source.originalName}」${label}没过验收（${reasons}），按你的选择仍然使用`)
      return this.d.jobs.get(jobId)!
    })
  }

  private settingParent = new Set<string>()

  /**
   * 手动指定父体：只重算命名，标 manual。
   * 不先放掉原来的号（排号时本来就不算自己），失败就什么都不改；查店铺可能要好几秒，这期间不占着这张图，
   * 删除、清空队列照常；写入时这张图已经不在、或第 6 步正在重跑，就放弃这次结果。
   */
  async setParent(jobId: string, sku: string): Promise<Job> {
    const job = this.d.jobs.get(jobId)
    if (!job) throw new HttpError(404, '这张图已经不在队列里了')
    const why = parentSkipReason(this.d.settings.get())
    if (why) throw new HttpError(400, why)
    if (!job.route) throw new HttpError(400, '这张图还没有确定品类')
    const st = job.steps[PARENT_STEP]!.state
    if (st === 'pending' || st === 'running') throw new HttpError(400, '「匹配父体」还没跑完，等它跑完再改')
    if (this.settingParent.has(jobId) || this.holds.has(jobId)) throw new HttpError(409, '这张图正在处理上一个操作，请稍等')
    this.settingParent.add(jobId)
    try {
      const p = this.d.settings.get().parent
      const cat = this.d.library.get().categories.find((c) => c.id === job.route!.categoryId)
      const tab = cat?.parentTab?.trim() || job.route.categoryName
      const call = <T,>(fn: () => Promise<T>) =>
        fn().catch((e) => {
          if (e instanceof ParentPauseError) throw new HttpError(409, e.message)
          if (e instanceof AiError) throw new HttpError(502, e.message)
          throw e
        })
      const read = await call(() => guard(() => this.env.parent.sheets.rows(p.sheetUrl, tab)))
      const row = read?.rows?.find((r) => r.sku.trim().toLowerCase() === sku.trim().toLowerCase()) ?? { sku: sku.trim(), asin: '', theme: '', row: 0 }
      const base = {
        tab,
        readAt: read?.readAt ?? new Date().toISOString(),
        candidates: job.parent?.candidates ?? [],
        confidence: null,
        reason: '手动指定',
        manual: true,
      }
      let applied = false
      await bindExisting({
        deps: this.env.parent,
        job,
        row,
        base,
        threshold: p.threshold,
        commit: (r) => {
          const cur = this.d.jobs.get(jobId)
          const s5 = cur?.steps[PARENT_STEP]!.state
          if (!cur || s5 === 'pending' || s5 === 'running') return
          this.d.jobs.update(jobId, (j) => {
            j.parent = r
            if (j.steps[PARENT_STEP]!.state !== 'done') markDone(j, PARENT_STEP)
            if (j.attention?.step === PARENT_STEP) j.attention = null
          })
          applied = true
        },
        call,
      })
      if (!applied) throw new HttpError(409, '这张图已经删掉或正在重新匹配，这次手动指定没有保存')
      log.info(`「${job.source.originalName}」手动指定父体 ${row.sku}`)
      void this.rewriteCsv(job.outputFolder)
      return this.d.jobs.get(jobId)!
    } finally {
      this.settingParent.delete(jobId)
    }
  }

  /** 变体名上下调一格（跳过占着的号） */
  async shiftParentNumber(jobId: string, delta: 1 | -1): Promise<Job> {
    return this.hold(jobId, async (job) => {
      if (job.steps[PARENT_STEP]!.state === 'running') throw new HttpError(400, '「匹配父体」正在跑，等它跑完再调')
      try {
        await shiftNumber(this.env.parent, job, delta, (r) => this.d.jobs.update(jobId, (j) => (j.parent = r)))
      } catch (e) {
        throw new HttpError(400, (e as Error).message)
      }
      void this.rewriteCsv(job.outputFolder)
      return this.d.jobs.get(jobId)!
    })
  }

  /**
   * 单张图暂停 / 继续。暂停时正在跑的那一步立即中止（退回待运行，次数不变），
   * 继续后从这一步重新开始；已经完成的图不能暂停。
   */
  async setPaused(jobId: string, paused: boolean): Promise<Job> {
    return this.hold(jobId, async (job) => {
      if (paused && isFinished(job)) throw new HttpError(400, '这张图已经跑完了，不用暂停')
      if (paused) {
        this.d.jobs.update(jobId, (j) => (j.paused = true))
        await this.abortRunning(jobId)
        log.info(`「${job.source.originalName}」已暂停`)
      } else if (job.paused) {
        this.d.jobs.update(jobId, (j) => (j.paused = false))
        log.info(`「${job.source.originalName}」继续`)
      }
      return this.d.jobs.get(jobId)!
    })
  }

  async remove(jobId: string): Promise<void> {
    await this.hold(jobId, async () => {
      await this.abortRunning(jobId)
      await this.d.jobs.remove(jobId)
      this.d.bus.emit('job-removed', { id: jobId })
    })
  }

  async clearDone(): Promise<number> {
    const done = this.d.jobs.list().filter((j) => isFinished(j) && !this.running.has(j.id))
    for (const j of done) await this.remove(j.id)
    return done.length
  }

  /** 整个队列清空：正在生成的先中止；已经写到输出文件夹的图不删 */
  async clearAll(): Promise<number> {
    const all = this.d.jobs.list()
    for (const j of all) await this.remove(j.id)
    return all.length
  }

  jobDir(jobId: string): string {
    return path.join(this.d.jobs.dirOf(jobId))
  }
}
