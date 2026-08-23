/**
 * Cross-session aggregate store: today, this-month, and per-model token/cost
 * totals accumulated from authoritative provider `usage`, persisted as one JSON
 * document under the DSH home. A per-session sequence watermark makes
 * accumulation idempotent across restarts and event replays. Local-only: no
 * data ever leaves the machine.
 *
 * @module dsh-usage-cost/aggregates
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ModelPricingEntry, PeakWindow, UsageTotals, UsageTotalsBucket } from './types.ts'
import { computeCost, isPeakTime, matchModelPricing } from './pricing.ts'

const PERSIST_VERSION = 1

/** Debounce interval before an aggregate change is written to disk. */
const FLUSH_DELAY_MS = 500

interface PersistedAggregates {
  version: number
  todayKey: string
  today: UsageTotalsBucket
  monthKey: string
  month: UsageTotalsBucket
  total: UsageTotalsBucket
  main: UsageTotalsBucket
  subagent: UsageTotalsBucket
  models: Record<string, UsageTotalsBucket>
  watermark: Record<string, number>
}

function emptyBucket(): UsageTotalsBucket {
  return { costYuan: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, requests: 0 }
}

function todayKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function monthKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function addBucket(target: UsageTotalsBucket, inc: UsageTotalsBucket): UsageTotalsBucket {
  return {
    costYuan: target.costYuan + inc.costYuan,
    inputTokens: target.inputTokens + inc.inputTokens,
    outputTokens: target.outputTokens + inc.outputTokens,
    cacheHitTokens: target.cacheHitTokens + inc.cacheHitTokens,
    cacheMissTokens: target.cacheMissTokens + inc.cacheMissTokens,
    requests: target.requests + inc.requests,
  }
}

function cloneBucket(bucket: UsageTotalsBucket): UsageTotalsBucket {
  return { ...bucket }
}

/** Parse a persisted document defensively; any malformed shape yields a fresh state. */
function parseDocument(raw: string): PersistedAggregates | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedAggregates>
    if (value === null || typeof value !== 'object') return null
    if (value.version !== PERSIST_VERSION) return null
    if (typeof value.todayKey !== 'string' || typeof value.monthKey !== 'string') return null
    return {
      version: PERSIST_VERSION,
      todayKey: value.todayKey,
      today: { ...emptyBucket(), ...(value.today ?? {}) },
      monthKey: value.monthKey,
      month: { ...emptyBucket(), ...(value.month ?? {}) },
      total: { ...emptyBucket(), ...(value.total ?? {}) },
      main: { ...emptyBucket(), ...(value.main ?? {}) },
      subagent: { ...emptyBucket(), ...(value.subagent ?? {}) },
      models: typeof value.models === 'object' && value.models !== null
        ? Object.fromEntries(Object.entries(value.models as Record<string, UsageTotalsBucket>).map(([k, v]) => [k, { ...emptyBucket(), ...v }]))
        : {},
      watermark: typeof value.watermark === 'object' && value.watermark !== null ? value.watermark as Record<string, number> : {},
    }
  } catch {
    return null
  }
}

/**
 * Owns the durable today/month/model totals. The plugin fiber starts it once,
 * records committed usage events, and disposes it (flushing) on unload.
 */
export class UsageTotalsStore {
  private readonly filePath: string
  private readonly pricing: () => ModelPricingEntry[]
  private readonly peakWindows: () => PeakWindow[]
  private state: PersistedAggregates
  private flushTimer: NodeJS.Timeout | undefined
  private dirty = false
  private disposed = false

  /**
   * @param filePath - absolute JSON document path under the DSH home.
   * @param pricing - thunk returning the current validated pricing table.
   * @param peakWindows - thunk returning the current peak windows.
   */
  constructor(filePath: string, pricing: () => ModelPricingEntry[], peakWindows: () => PeakWindow[]) {
    this.filePath = filePath
    this.pricing = pricing
    this.peakWindows = peakWindows
    this.state = {
      version: PERSIST_VERSION,
      todayKey: todayKey(new Date()),
      today: emptyBucket(),
      monthKey: monthKey(new Date()),
      month: emptyBucket(),
      total: emptyBucket(),
      main: emptyBucket(),
      subagent: emptyBucket(),
      models: {},
      watermark: {},
    }
  }

  /** Load the persisted document if present, else start from empty totals. */
  async start(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = parseDocument(raw)
      if (parsed !== null) this.state = parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // A corrupt or unreadable file must not crash the plugin: keep empty totals.
        // eslint-disable-next-line no-console
        console.warn('dsh-usage-cost: could not load aggregates; starting from empty totals', error)
      }
    }
    this.rollover()
  }

  /** Reset today/month buckets when the local calendar rolled past their keys. */
  private rollover(): void {
    const now = new Date()
    if (this.state.todayKey !== todayKey(now)) {
      this.state.todayKey = todayKey(now)
      this.state.today = emptyBucket()
    }
    if (this.state.monthKey !== monthKey(now)) {
      this.state.monthKey = monthKey(now)
      this.state.month = emptyBucket()
    }
  }

  /**
   * Fold one authoritative usage record into the totals, idempotently by session
   * sequence watermark. Unpriced models accumulate tokens with zero cost.
   * @param sessionId - owning session identity.
   * @param seq - the assistant/message event sequence.
   * @param model - the raw provider model id.
   * @param usage - the authoritative provider usage.
   * @param category - whether the session is a top-level (main) or subagent (child) session.
   * @param time - the assistant/message event epoch-millisecond timestamp.
   */
  record(
    sessionId: string,
    seq: number,
    model: string,
    usage: TokenUsage,
    category: 'main' | 'subagent',
    time: number,
  ): void {
    if (this.disposed) return
    const last = this.state.watermark[sessionId]
    if (last !== undefined && seq <= last) return
    this.rollover()

    const entry = matchModelPricing(model, this.pricing())
    const modelKey = entry?.id ?? (model.length > 0 ? model : 'unknown')
    const cacheHit = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    const cacheMiss = usage.inputTokens
    const output = usage.outputTokens
    const isPeak = isPeakTime(time, this.peakWindows())
    const peakSplit = isPeak
      ? { cacheHit, cacheMiss, output }
      : { cacheHit: 0, cacheMiss: 0, output: 0 }
    const offPeakSplit = isPeak
      ? { cacheHit: 0, cacheMiss: 0, output: 0 }
      : { cacheHit, cacheMiss, output }
    const inc: UsageTotalsBucket = {
      costYuan: entry === undefined ? 0 : computeCost(entry, peakSplit, offPeakSplit),
      inputTokens: cacheHit + cacheMiss + cacheWrite,
      outputTokens: output,
      cacheHitTokens: cacheHit,
      cacheMissTokens: cacheMiss,
      requests: 1,
    }

    this.state.today = addBucket(this.state.today, inc)
    this.state.month = addBucket(this.state.month, inc)
    this.state.total = addBucket(this.state.total, inc)
    if (category === 'subagent') {
      this.state.subagent = addBucket(this.state.subagent, inc)
    } else {
      this.state.main = addBucket(this.state.main, inc)
    }
    this.state.models[modelKey] = addBucket(this.state.models[modelKey] ?? emptyBucket(), inc)
    this.state.watermark[sessionId] = seq
    this.scheduleFlush()
  }

  /** Detached snapshot of today/month/model totals. */
  snapshot(): UsageTotals {
    this.rollover()
    return {
      today: cloneBucket(this.state.today),
      month: cloneBucket(this.state.month),
      total: cloneBucket(this.state.total),
      main: cloneBucket(this.state.main),
      subagent: cloneBucket(this.state.subagent),
      models: Object.fromEntries(Object.entries(this.state.models).map(([k, v]) => [k, cloneBucket(v)])),
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, FLUSH_DELAY_MS)
  }

  /** Write the current state to disk, creating the parent directory on demand. */
  async flush(): Promise<void> {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(this.state), 'utf8')
    } catch (error) {
      // A failed write keeps the in-memory totals; the next flush retries.
      this.dirty = true
      // eslint-disable-next-line no-console
      console.warn('dsh-usage-cost: could not persist aggregates', error)
    }
  }

  /** Cancel the debounce and flush pending totals (idempotent). */
  async dispose(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flush()
    this.disposed = true
  }
}
