/**
 * Pure types of the dsh-usage-cost domain: pricing, the per-session usage/cost
 * projection value, and the cross-session aggregate totals. The projection key
 * is merge-declared here on the session-projection table exactly as the domain
 * packages do; the client imports the same shape through the projection store.
 *
 * @module dsh-usage-cost/types
 */

import type { UsageCostState } from './projection.ts'

/** One configurable model pricing row. Prices are CNY per 1,000,000 (1M) tokens. */
export interface ModelPricingEntry {
  /** Model id prefix to match, e.g. `deepseek-chat`. */
  id: string
  /** CNY per 1M cache-hit (cached prompt) tokens (off-peak when peak fields are present). */
  cacheHit: number
  /** CNY per 1M cache-miss (uncached prompt) tokens (off-peak when peak fields are present). */
  cacheMiss: number
  /** CNY per 1M completion (output) tokens (off-peak when peak fields are present). */
  output: number
  /** Optional peak cache-hit price; presence enables peak/off-peak pricing. */
  peakCacheHit?: number
  /** Optional peak cache-miss price. */
  peakCacheMiss?: number
  /** Optional peak output price. */
  peakOutput?: number
}

/** One peak window in Beijing time (UTC+8), expressed in minutes since midnight. */
export interface PeakWindow {
  /** Start minute-of-day, inclusive. */
  start: number
  /** End minute-of-day, exclusive. */
  end: number
}

/** DeepSeek account-balance snapshot, fetched from the balance endpoint. */
export interface AccountBalance {
  /** Total balance in CNY, or null while unknown/unavailable. */
  balanceYuan: number | null
  /** Human-readable fetch error, or null on success/never-fetched. */
  error: string | null
  /** Unix epoch ms of the last successful fetch, or null. */
  fetchedAt: number | null
}

/** Plugin configuration resolved from the composition entry plus the settings section. */
export interface UsageCostConfig {
  /** Fuzzy-matched pricing table; later entries do not override earlier ones on collision. */
  models: ModelPricingEntry[]
  /** Total budget in CNY; 0 means "not set" and hides the remaining figures. */
  budgetYuan: number
  /** Peak windows in Beijing time (UTC+8); an empty list disables peak pricing. */
  peakWindows: PeakWindow[]
  /** Re-estimate streaming output tokens every N chunks (whichever comes first with the time window). */
  chunkInterval: number
  /** Re-estimate streaming output tokens after at least this many milliseconds. */
  timeIntervalMs: number
}

/** Lifecycle state of the session's usage accounting. */
export type UsageCostStatus = 'idle' | 'estimating' | 'calibrated' | 'incomplete'

/** One bucket of token/cost totals, used for today, this month, and per-model rolls. */
export interface UsageTotalsBucket {
  costYuan: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  requests: number
}

/** Cross-session aggregate totals, snapshotted at view time. */
export interface UsageTotals {
  today: UsageTotalsBucket
  month: UsageTotalsBucket
  /** All-time cumulative consumption (never resets). */
  total: UsageTotalsBucket
  /** Consumption attributed to top-level (main) sessions. */
  main: UsageTotalsBucket
  /** Consumption attributed to subagent (child) sessions. */
  subagent: UsageTotalsBucket
  /** Cumulative per-model buckets keyed by the matched pricing id. */
  models: Record<string, UsageTotalsBucket>
}

/**
 * Whole-session usage and cost value served through the `usageCost` session
 * projection. Token fields are totals across every completed step plus the
 * in-flight estimate; `costYuan` is null when no pricing row matches the model.
 */
export interface UsageCostProjection {
  /** Matched model id (the pricing row), or the raw model id when unmatched. */
  model: string | null
  status: UsageCostStatus
  /** Estimated or calibrated total prompt tokens (cached + uncached). */
  inputTokens: number
  /** Estimated or calibrated total completion tokens. */
  outputTokens: number
  /** Cache-hit (cached prompt) tokens. */
  cacheHitTokens: number
  /** Cache-miss (uncached prompt) tokens. */
  cacheMissTokens: number
  /** inputTokens + outputTokens. */
  totalTokens: number
  /** Session cost in CNY; null when the model has no configured price. */
  costYuan: number | null
  /** Summed model wall time across message-assembling steps, ms. */
  durationMs: number
  /** outputTokens / (durationMs / 1000); null while no step has assembled a message. */
  tokensPerSecond: number | null
  /** True when the last assembled message carried authoritative provider usage. */
  calibrated: boolean
  /** The matched pricing row for the session model, or null when unmatched. */
  pricing: ModelPricingEntry | null
  /** Total budget in CNY (0 = not set). */
  budgetYuan: number
  /** budget − month.costYuan, or null when budget is not set. */
  remainingMonth: number | null
  /** budget − total.costYuan, or null when budget is not set. */
  remainingTotal: number | null
  /** DeepSeek account-balance snapshot (fetched live). */
  balance: AccountBalance
  /** Cross-session today/month/model totals, snapshotted at view time. */
  totals: UsageTotals
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-session token usage, cost, timing, and aggregate totals; see {@link UsageCostProjection}. */
    usageCost: UsageCostProjection
  }
  interface SessionProjectionStateMap {
    /** Fold state of the `usageCost` unit; see {@link UsageCostState}. */
    usageCost: UsageCostState
  }
}
