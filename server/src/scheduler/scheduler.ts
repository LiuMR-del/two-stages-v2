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
  type ParentResult,
} from '../store/jobs'
import type { JobPatch, StepCtx, StepEnv, StepHandler, StepResult } from '../pipeline/types'
import { step0Route } from '../pipeline/step0Route'
import { step1Extract } from '../pipeline/step1Extract'
import { step2Main } from '../pipeline/step2Main'
import { step3Info } from '../pipeline/step3Info'
import { step4Blank } from '../pipeline/step4Blank'
import { step5Parent } from '../pipeline/step5Parent'
import { bindExisting, depsFor, guard, ParentPauseError, parentSkipReason, shiftNumber, storeForJob } from '../parent/match'
import type { FeishuSheets } from '../parent/feishu'
import type { SpapiPool } from '../parent/spapi'
import type { StoreIndex, StoreSnapshot } from '../parent/storeIndex'
import { candidateParents, decideChildCode, seedInfo, withOwnMark } from '../parent/storeParents'
import type { Reservations } from '../parent/reservations'
import { resolvePlan } from '../pipeline/plan'
import { assignOutputBase, categoryDir, DEFAULT_MARK, LEGACY_STORE_ID, OUTPUT_FOLDER, outputRel, safeName, writeOutput, type BatchFolders } from '../pipeline/output'
import { SkuCounter, withStyleMark, type IssuedSku } from '../pipeline/sku'
import { JOB_FILES } from '../pipeline/files'
import fsp from 'node:fs/promises'
import { readSavedRows, SAVED_CATEGORY_COL, SAVED_MAIN_COL, SAVED_SKU_COL, writeBatchCsv, writeSavedRows } from '../pipeline/csv'
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
  parent?: { sheets: FeishuSheets; spapis: SpapiPool; reservations?: Reservations; index?: StoreIndex }
  /** 每批的店铺和专属号；不给时按焕捷、专属号 0（单元测试） */
  batch?: BatchFolders
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
  /** 正在改专属号的批次文件夹：这一批的图先不派发 */
  private renaming = new Set<string>()
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
      syncChildCode: (jobId, o) => this.syncChildCode(jobId, o),
      parent: {
        sheets: d.parent?.sheets ?? (null as unknown as FeishuSheets),
        spapis: d.parent?.spapis ?? (null as unknown as SpapiPool),
        mutex: this.parentLock,
        jobs: () => d.jobs.list(),
        reservations: d.parent?.reservations,
        index: d.parent?.index,
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
    if (job.attention || job.paused || this.holds.has(job.id) || this.renaming.has(job.outputFolder)) return -1
    const i = currentStep(job)
    if (i < 0 || job.steps[i]!.state !== 'pending') return -1
    // 识别父体关着 / 缺设置：doTick 里直接跳过，不受分析接口暂停影响
    if (i === PARENT_STEP && this.parentSkip(job)) return i
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
        const why = this.parentSkip(job)
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
      if (newCat) {
        const issued = this.allocSku(j)
        j.sku = issued?.sku ?? null
        j.skuMeta = issued ? { head: issued.head, mark: issued.mark, seq: issued.seq, was: [], code: issued.code } : null
        j.skuNote = null
      }
      if (newCat || j.route.categoryName !== prev) {
        j.outputBase = j.sku ?? assignOutputBase(j, this.d.jobs.list(), this.env.outputDir(), j.route.categoryName)
      }
    })
  }

  /**
   * 品类没填材质缩写就不发 SKU，文件名照旧用原图名。
   * SKU = 这张图店铺的缩写 - 款式标记（横版 HB）+ 材质缩写 + 年份末位 + 组别 + 月日 + 这一批的专属号（默认 0）+ 当天序号。
   * 跳过：队列里别的图已经用的、输出文件夹里已经有的、店铺里已经有的（只看已经扫好的快照，不为发号去等扫描）。
   */
  private allocSku(j: Job): IssuedSku | null {
    const cat = this.d.library.get().categories.find((c) => c.id === j.route!.categoryId)
    const code = cat?.skuCode?.trim()
    if (!code) return null
    const style = cat!.styles.find((x) => x.id === j.route!.styleId)
    const s = this.d.settings.get()
    const mark = this.d.batch?.meta(j.outputFolder).mark ?? DEFAULT_MARK
    return this.sku.issue({ store: storeForJob(s, j).abbr, code: withStyleMark(code, style?.skuMark), region: s.sku.group, mark }, this.skuTaken(j))
  }

  /** 发号时跳过：队列里别的图已经用的、店铺里已有的（只看已扫好的快照）、这张图品类文件夹里已有的 */
  private skuTaken(j: Job): (sku: string) => boolean {
    const others = this.d.jobs.list().filter((o) => o.id !== j.id)
    const dir = path.join(this.env.outputDir(), j.outputFolder, safeName(j.route!.categoryName))
    const inStore = new Set((this.d.parent?.index?.peek(j.storeId)?.items ?? []).map((x) => x.sku.toLowerCase()))
    return (sku: string) =>
      others.some((o) => o.sku?.toLowerCase() === sku.toLowerCase()) ||
      inStore.has(sku.toLowerCase()) ||
      fs.existsSync(path.join(dir, outputRel('main', sku))) ||
      fs.existsSync(path.join(dir, outputRel('pattern', sku)))
  }

  /**
   * 第 6 步定下父体后（含手动指定），子体 SKU 的材质编码跟着父体走（多店铺方案第六节，2026-11-04 审查后）：
   * - 已匹配、建议新建、手动指定：按 decideChildCode 定编码，横竖版标记按 withOwnMark 取舍；没有可参照的用模版库的编码。
   * - 待确认、没有合适的父体：不按这个父体改；SKU 退回模版库的编码（之前按别的父体改过的改回来），待确认时写一句「确认后会改成 X」。
   */
  async syncChildCode(jobId: string, o: { result: ParentResult; kids: string[]; snap: StoreSnapshot | null; productTypes: string[] }): Promise<void> {
    const job = this.d.jobs.get(jobId)
    if (!job?.sku || !job.skuMeta || !job.route) return
    const cat = this.d.library.get().categories.find((c) => c.id === job.route!.categoryId)
    const libBase = cat?.skuCode?.trim()
    if (!libBase) return
    const style = cat!.styles.find((x) => x.id === job.route!.styleId)
    const libCode = withStyleMark(libBase, style?.skuMark)
    const store = storeForJob(this.d.settings.get(), job)
    const r = o.result
    const sure = r.status === 'matched' || r.status === 'new' || r.manual
    const d =
      r.sku && r.status !== 'none'
        ? decideChildCode({
            abbr: store.abbr,
            parentSku: r.status === 'new' ? null : r.sku,
            kids: o.kids,
            newPrefix: r.status === 'new' ? (r.proposal?.prefix ?? null) : null,
            snap: o.snap,
            productTypes: o.productTypes,
            libraryCode: libBase,
          })
        : null
    const want = d ? withOwnMark(d, style?.skuMark) : null
    if (sure) {
      const keep = want && want.toLowerCase() !== libCode.toLowerCase() ? `${d!.why}，子体编码用 ${want}` : null
      await this.followCode(jobId, want ?? libCode, want ? d!.why : '父体下没有可参照的子体，用模版库的编码，', null, keep)
    } else {
      const hint = want && want.toLowerCase() !== libCode.toLowerCase() ? `确认父体后，子体编码会${d!.why}改成 ${want}` : null
      await this.followCode(jobId, libCode, '父体还没定下来，退回模版库的编码，', hint, null)
    }
  }

  /**
   * 把这张图的 SKU 换成 code 这个材质编码：一样就只更新说明；不一样就按新编码重新发号（新前缀下取当天序号，旧号不收回）、三个输出文件改名。
   * 改名失败就把已经改的改回去、保持原 SKU，在 skuNote 里写明没改成。返回改后的 SKU，没改返回 null。
   */
  async followCode(jobId: string, code: string, why: string, hint: string | null = null, keepNote: string | null = null): Promise<string | null> {
    const job = this.d.jobs.get(jobId)
    if (!job?.sku || !job.skuMeta || !job.route || job.outputBase !== job.sku) return null
    if (this.renaming.has(job.outputFolder)) return null
    const s = this.d.settings.get()
    const abbr = storeForJob(s, job).abbr
    const cur = job.skuMeta.code || codeFromHead(job.skuMeta.head, abbr)
    const setNote = (note: string | null) => {
      if (this.d.jobs.get(jobId)) this.d.jobs.update(jobId, (j) => (j.skuNote = note))
    }
    if (!cur || cur.toLowerCase() === code.toLowerCase()) {
      // 编码不用改：说明换成这次的（待确认的提示、或者「按父体 X 下的子体，编码用 Y」；和模版库一样时清空）
      setNote(hint ?? keepNote)
      return null
    }
    const issued = this.sku.issue({ store: abbr, code, region: s.sku.group, mark: job.skuMeta.mark }, this.skuTaken(job))
    const dir = categoryDir(this.env.outputDir(), job)
    const moved: { from: string; to: string }[] = []
    try {
      for (const kind of ['main', 'pattern', 'blank'] as const) {
        const from = path.join(dir, outputRel(kind, job.sku))
        if (!fs.existsSync(from)) continue
        const to = path.join(dir, outputRel(kind, issued.sku))
        await renameSafe(from, to)
        moved.push({ from, to })
      }
    } catch (e) {
      for (const m of moved.reverse()) {
        await renameSafe(m.to, m.from).catch((e2) => log.warn(`「${job.source.originalName}」改回原文件名失败，文件现在叫 ${path.basename(m.to)}：${(e2 as Error).message}`))
      }
      log.warn(`「${job.source.originalName}」SKU 要改成 ${issued.sku}，但文件改名失败，保持 ${job.sku}：${(e as Error).message}`)
      setNote(`没能把 SKU 改成 ${issued.sku}（文件改不了名，可能正被别的程序打开），还是 ${job.sku}；关掉占用的程序后在详情里对第 6 步点「重新匹配」`)
      return null
    }
    const old = job.sku
    const note = `${why}改成 ${code}（原 ${cur}）：${old} → ${issued.sku}`
    if (!this.d.jobs.get(jobId)) {
      // 改名期间这张图被删了：文件改回去，免得留下没人管的文件
      for (const m of moved.reverse()) await renameSafe(m.to, m.from).catch(() => {})
      return null
    }
    this.d.jobs.update(jobId, (j) => {
      j.sku = issued.sku
      j.outputBase = issued.sku
      j.skuMeta = { head: issued.head, mark: issued.mark, seq: issued.seq, was: [...new Set([...(j.skuMeta?.was ?? []), old])], code: issued.code }
      j.skuNote = hint ? `${note}。${hint}` : note
    })
    log.info(`「${job.source.originalName}」${note}`)
    return issued.sku
  }

  private parentSkip(job: Job): string | null {
    const s = this.d.settings.get()
    return parentSkipReason(s, storeForJob(s, job))
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
  rewriteCsv(folder: string, drop: string[] = []): Promise<void> {
    return this.csvLock
      .run(folder, () => writeBatchCsv(this.env.outputDir(), this.d.jobs.list(), folder, this.d.csvRowsDir && path.join(this.d.csvRowsDir, `${folder}.json`), drop))
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
    if (this.holds.has(jobId) || this.settingParent.has(jobId)) throw new HttpError(409, '这张图正在处理上一个操作，请稍等')
    if (this.renaming.has(job.outputFolder)) throw new HttpError(409, '正在改这一批的专属号，请稍等')
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
    const why = this.parentSkip(job)
    if (why) throw new HttpError(400, why)
    if (!job.route) throw new HttpError(400, '这张图还没有确定品类')
    const st = job.steps[PARENT_STEP]!.state
    if (st === 'pending' || st === 'running') throw new HttpError(400, '「匹配父体」还没跑完，等它跑完再改')
    if (this.settingParent.has(jobId) || this.holds.has(jobId)) throw new HttpError(409, '这张图正在处理上一个操作，请稍等')
    if (this.renaming.has(job.outputFolder)) throw new HttpError(409, '正在改这一批的专属号，请稍等')
    this.settingParent.add(jobId)
    try {
      const settings = this.d.settings.get()
      const p = settings.parent
      const store = storeForJob(settings, job)
      const deps = depsFor(this.env.parent, store.id)
      const cat = this.d.library.get().categories.find((c) => c.id === job.route!.categoryId)
      const productTypes = cat?.productTypes ?? []
      const call = <T,>(fn: () => Promise<T>) =>
        fn().catch((e) => {
          if (e instanceof ParentPauseError) throw new HttpError(409, e.message)
          if (e instanceof AiError) throw new HttpError(502, e.message)
          throw e
        })
      const want = sku.trim().toLowerCase()
      let tab: string
      let readAt: string
      let row: { sku: string; asin: string; theme: string; row: number }
      let sameCategory: string[]
      let snap: StoreSnapshot | null = null
      let fallbackTheme: string | null = null
      if (store.parentSource === 'store') {
        // 店铺来源：从店铺商品快照里找这个父体（找不到也照样去店铺里查，可能是刚建的）
        snap = this.d.parent?.index ? await call(() => guard(() => this.d.parent!.index!.get(store.id))) : null
        const cands = snap ? candidateParents(snap, productTypes) : []
        const hit = cands.find((r) => r.sku.toLowerCase() === want) ?? snap?.items.find((x) => x.kind === 'parent' && x.sku.toLowerCase() === want)
        tab = productTypes.length ? productTypes.join(' / ') : job.route.categoryName
        readAt = snap?.scannedAt ?? new Date().toISOString()
        row = { sku: hit?.sku ?? sku.trim(), asin: hit?.asin ?? '', theme: hit?.theme ?? '', row: 0 }
        fallbackTheme = hit && 'title' in hit ? hit.title || null : null
        sameCategory = cands.map((r) => r.sku)
      } else {
        tab = cat?.parentTab?.trim() || job.route.categoryName
        const read = await call(() => guard(() => deps.sheets.rows(store.feishu.sheetUrl, tab)))
        row = read?.rows?.find((r) => r.sku.trim().toLowerCase() === want) ?? { sku: sku.trim(), asin: '', theme: '', row: 0 }
        readAt = read?.readAt ?? new Date().toISOString()
        sameCategory = (read?.rows ?? []).map((r) => r.sku)
        snap = this.d.parent?.index ? await this.d.parent.index.get(store.id).catch(() => null) : null
      }
      const base = {
        tab,
        readAt,
        candidates: job.parent?.candidates ?? [],
        confidence: null,
        reason: '手动指定',
        manual: true,
      }
      let applied = false
      let kids: string[] = []
      const result = await bindExisting({
        deps,
        job,
        row,
        base,
        seed: seedInfo(snap, sameCategory),
        onKids: (k) => (kids = k),
        fallbackTheme,
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
      // 子体材质编码跟着新父体走（店里查不到这个父体时退回模版库的编码）
      await this.syncChildCode(jobId, { result, kids, snap, productTypes })
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
        await shiftNumber(depsFor(this.env.parent, storeForJob(this.d.settings.get(), job).id), job, delta, (r) => this.d.jobs.update(jobId, (j) => (j.parent = r)))
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

  /**
   * 移出队列。deleteOutputs（队列里单张「删除」，用户 2026-10-29 要求）：
   * 连同已经存到输出文件夹的素材图、主图、空白图和 CSV 里这一行一起删；SKU 不收回。
   * 「清除已完成」「清空队列」不删输出文件。
   */
  async remove(jobId: string, opts: { deleteOutputs?: boolean } = {}): Promise<void> {
    await this.hold(jobId, async () => {
      await this.abortRunning(jobId)
      const job = this.d.jobs.get(jobId)!
      await this.d.jobs.remove(jobId)
      this.d.bus.emit('job-removed', { id: jobId })
      if (opts.deleteOutputs && job.route) {
        const dir = categoryDir(this.env.outputDir(), job)
        const gone: string[] = []
        for (const kind of ['pattern', 'main', 'blank'] as const) {
          const file = path.join(dir, outputRel(kind, job.outputBase))
          try {
            await fsp.unlink(file)
            gone.push(OUTPUT_FOLDER[kind])
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`删除输出文件失败：${file}：${(e as Error).message}`)
          }
        }
        if (job.info) await this.rewriteCsv(job.outputFolder, [jobId])
        log.info(`删除「${job.source.originalName}」${gone.length ? `，连同输出文件夹里的${gone.join('、')}` : ''}`)
      }
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

  /**
   * 「改专属号」（多店铺方案第五节）：这一批所有 SKU 只换专属号那一截，序号不变；三个输出文件改名、CSV 重写，
   * 这一批之后再发的 SKU 也用新号。范围是队列里这一批的图，加上已经移出队列、CSV 里还有的行。
   * apply = false 只出预览。新 SKU 在店铺里（storeSkus，调用方先强制重扫）、队列里别的图、输出文件夹里已经有了，算冲突，有冲突不改。
   * 有图正在生成时不改；改名时这一批的图都不派发；任何一个文件改名失败，已经改的改回去。
   */
  async changeBatchMark(folder: string, mark: string, opts: { apply: boolean; storeSkus: Set<string> }): Promise<MarkPlan> {
    if (this.renaming.has(folder)) throw new HttpError(409, '正在改这一批的专属号，请稍等')
    const all = this.d.jobs.list()
    const inFolder = all.filter((j) => j.outputFolder === folder)
    if (inFolder.some((j) => this.running.has(j.id))) throw new HttpError(409, '这一批还有图正在生成，等跑完（或先「暂停队列」等它停下）再改专属号')
    // 删除、重做、仍然使用、手动换父体这些单张图的操作没做完时也不改（它们会写输出文件或改 SKU）
    if (inFolder.some((j) => this.holds.has(j.id) || this.settingParent.has(j.id))) throw new HttpError(409, '这一批有图正在处理别的操作，请稍等再改专属号')
    const outDir = this.env.outputDir()
    const rowsFile = this.d.csvRowsDir ? path.join(this.d.csvRowsDir, `${folder}.json`) : null
    const saved = rowsFile ? readSavedRows(rowsFile) : []
    const inQueue = new Set(inFolder.map((j) => j.id))
    type Target = MarkPlanItem & { category: string; head: string; seq: string; was: string[]; jobId: string | null; rowId: string }
    const targets: Target[] = []
    const skipped: { name: string; sku: string; reason: string }[] = []
    const consider = (o: { id: string; name: string; sku: string | null; meta: { head: string; mark: string; seq: string; was?: string[] } | null; category: string; jobId: string | null }) => {
      if (!o.sku) return
      if (!o.meta || o.meta.head + o.meta.mark + o.meta.seq !== o.sku) {
        skipped.push({ name: o.name, sku: o.sku, reason: o.meta ? 'SKU 改过，和发号时对不上' : '改版前发的 SKU，没记专属号在哪一位' })
        return
      }
      const next = o.meta.head + mark + o.meta.seq
      targets.push({ name: o.name, old: o.sku, next, conflict: null, inQueue: o.jobId !== null, category: o.category, head: o.meta.head, seq: o.meta.seq, was: o.meta.was ?? [], jobId: o.jobId, rowId: o.id })
    }
    for (const j of inFolder) if (j.route) consider({ id: j.id, name: j.source.originalName, sku: j.sku, meta: j.skuMeta, category: j.route.categoryName, jobId: j.id })
    for (const r of saved) {
      if (inQueue.has(r.id)) continue
      consider({ id: r.id, name: r.row[0] ?? '', sku: r.row[SAVED_SKU_COL] || null, meta: r.skuMeta ?? null, category: r.row[SAVED_CATEGORY_COL] ?? '', jobId: null })
    }
    const mine = new Set(targets.map((t) => t.old.toLowerCase()))
    const others = new Set(all.filter((j) => j.sku && !mine.has(j.sku.toLowerCase())).map((j) => j.sku!.toLowerCase()))
    const seen = new Map<string, number>()
    for (const t of targets) seen.set(t.next.toLowerCase(), (seen.get(t.next.toLowerCase()) ?? 0) + 1)
    for (const t of targets) {
      if (t.next === t.old) continue
      const k = t.next.toLowerCase()
      const dir = path.join(outDir, folder, safeName(t.category))
      if (opts.storeSkus.has(k)) t.conflict = '店铺里已经有这个 SKU'
      else if (others.has(k)) t.conflict = '队列里别的图已经用了'
      else if (k !== t.old.toLowerCase() && !t.was.some((x) => x.toLowerCase() === k) && this.sku.issued(t.next)) t.conflict = '这个号已经发过了（别的批次或之前改过）'
      else if ((seen.get(k) ?? 0) > 1) t.conflict = '这一批里会重名'
      else if (k !== t.old.toLowerCase() && (['main', 'pattern', 'blank'] as const).some((kind) => fs.existsSync(path.join(dir, outputRel(kind, t.next))))) t.conflict = '输出文件夹里已经有这个名字的图'
    }
    const plan: MarkPlan = {
      folder,
      from: this.d.batch?.meta(folder).mark ?? DEFAULT_MARK,
      to: mark,
      items: targets.map(({ name, old, next, conflict, inQueue: q }) => ({ name, old, next, conflict, inQueue: q })).sort((x, y) => (x.old < y.old ? -1 : 1)),
      skipped,
      applied: false,
    }
    if (!opts.apply || targets.some((t) => t.conflict)) return plan

    this.renaming.add(folder)
    const moved: { from: string; to: string }[] = []
    const undoFiles = async () => {
      for (const m of moved.reverse()) await renameSafe(m.to, m.from).catch((e2) => log.warn(`改专属号回滚失败：${m.to}：${(e2 as Error).message}`))
    }
    try {
      for (const t of targets) {
        if (t.next === t.old) continue
        const dir = path.join(outDir, folder, safeName(t.category))
        for (const kind of ['main', 'pattern', 'blank'] as const) {
          const from = path.join(dir, outputRel(kind, t.old))
          const to = path.join(dir, outputRel(kind, t.next))
          if (!fs.existsSync(from)) continue
          await renameSafe(from, to)
          moved.push({ from, to })
        }
      }
    } catch (e) {
      await undoFiles()
      this.renaming.delete(folder)
      this.tick()
      log.warn(`改专属号时改文件名失败：${(e as Error).message}`)
      throw new HttpError(500, `有文件改不了名（可能正被别的程序打开），已经全部改回原样，再试一次：${(e as Error).message}`)
    }
    // 第二步：队列里的任务、CSV 保存行、批次专属号、CSV，在 CSV 锁里做；失败就连文件一起改回去
    const before = new Map(targets.filter((t) => t.jobId).map((t) => [t.jobId!, structuredClone(this.d.jobs.get(t.jobId!)!)]))
    const metaBefore = this.d.batch?.meta(folder)
    try {
      await this.csvLock.run(folder, async () => {
        const byId = new Map(targets.map((t) => [t.rowId, t]))
        for (const t of targets) {
          if (!t.jobId) continue
          this.d.jobs.update(t.jobId, (j) => {
            j.sku = t.next
            j.outputBase = t.next
            j.skuMeta = { head: t.head, mark, seq: t.seq, was: [...new Set([...t.was, t.old])], code: j.skuMeta?.code ?? '' }
          })
        }
        if (rowsFile) {
          // 现读：预览之后可能又有图写进了 CSV
          const fresh = readSavedRows(rowsFile)
          if (fresh.length) {
            await writeSavedRows(
              rowsFile,
              fresh.map((r) => {
                const t = byId.get(r.id)
                if (!t || t.jobId) return r
                const row = [...r.row]
                row[SAVED_SKU_COL] = t.next
                row[SAVED_MAIN_COL] = path.join(safeName(t.category), outputRel('main', t.next))
                return { ...r, row, skuMeta: { head: t.head, mark, seq: t.seq, was: [...new Set([...t.was, t.old])] } }
              }),
            )
          }
        }
        this.d.batch?.setMeta(folder, { storeId: metaBefore?.storeId ?? LEGACY_STORE_ID, mark })
        await writeBatchCsv(this.env.outputDir(), this.d.jobs.list(), folder, rowsFile ?? undefined)
      })
      this.sku.record(targets.map((t) => t.next))
    } catch (e) {
      for (const [id, j] of before) {
        if (this.d.jobs.get(id)) this.d.jobs.update(id, (cur) => Object.assign(cur, { sku: j.sku, outputBase: j.outputBase, skuMeta: j.skuMeta }))
      }
      if (rowsFile) await writeSavedRows(rowsFile, saved).catch(() => {})
      if (metaBefore) this.d.batch?.setMeta(folder, metaBefore)
      await undoFiles()
      await this.rewriteCsv(folder).catch(() => {})
      log.warn(`改专属号失败，已经改回原样：${(e as Error).message}`)
      throw new HttpError(500, `改专属号没成功，已经全部改回原样，再试一次：${(e as Error).message}`)
    } finally {
      this.renaming.delete(folder)
      this.tick()
    }
    log.info(`「${folder}」专属号 ${plan.from} → ${mark}，改了 ${targets.length} 个 SKU`)
    return { ...plan, applied: true }
  }
}

/** 第 3 段的 skuMeta 没记编码：head = 店铺缩写-编码 + 年份末位 + 组别 + 月日 */
function codeFromHead(head: string, abbr: string): string {
  // 编码一定以字母结尾，后面是年份、组别、月日这些数字；不依赖现在设置里组别有几位
  return head.toLowerCase().startsWith(`${abbr.toLowerCase()}-`) ? head.slice(abbr.length + 1).replace(/\d+$/, '') : ''
}

/** 改名：目标已经有文件就报错（不覆盖）；只差大小写时（macOS 默认不分大小写）先改成临时名再改过去 */
async function renameSafe(from: string, to: string): Promise<void> {
  if (from.toLowerCase() === to.toLowerCase()) {
    const tmp = `${from}.renaming-${process.pid}`
    await fsp.rename(from, tmp)
    await fsp.rename(tmp, to)
    return
  }
  if (fs.existsSync(to)) throw new Error(`${path.basename(to)} 已经存在`)
  await fsp.rename(from, to)
}

export type MarkPlanItem = { name: string; old: string; next: string; conflict: string | null; inQueue: boolean }
export type MarkPlan = { folder: string; from: string; to: string; items: MarkPlanItem[]; skipped: { name: string; sku: string; reason: string }[]; applied: boolean }
