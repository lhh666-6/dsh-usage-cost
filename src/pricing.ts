/**
 * Cost model: the DeepSeek price table (configurable) plus fuzzy model matching,
 * peak/off-peak time windows, and the per-token cost formula. Prices are CNY per
 * 1M tokens. The table is user-configurable because the official prices change
 * and deployments may add models.
 *
 * @module dsh-usage-cost/pricing
 */

import type { ModelPricingEntry, PeakWindow, UsageCostConfig } from './types.ts'

/**
 * Default DeepSeek pricing in CNY per 1M tokens.
 *
 * Fixed-price rows (no peak fields): deepseek-chat / deepseek-reasoner.
 * Peak/off-peak rows (effective 2026-08-17, Beijing time):
 *   deepseek-v4-flash: off-peak ¥0.05/1.5/4.5, peak ¥0.10/3.0/9.0.
 *   deepseek-v4-pro:   off-peak ¥0.15/4.5/13.5, peak ¥0.30/9.0/27.0.
 */
export const DEFAULT_MODEL_PRICING: ModelPricingEntry[] = [
  { id: 'deepseek-chat', cacheHit: 0.5, cacheMiss: 2, output: 8 },
  { id: 'deepseek-reasoner', cacheHit: 1, cacheMiss: 4, output: 16 },
  {
    id: 'deepseek-v4-flash',
    cacheHit: 0.05, cacheMiss: 1.5, output: 4.5,
    peakCacheHit: 0.10, peakCacheMiss: 3.0, peakOutput: 9.0,
  },
  {
    id: 'deepseek-v4-pro',
    cacheHit: 0.15, cacheMiss: 4.5, output: 13.5,
    peakCacheHit: 0.30, peakCacheMiss: 9.0, peakOutput: 27.0,
  },
]

/** Default peak windows in Beijing time (UTC+8): 09:00–12:00 and 14:00–18:00. */
export const DEFAULT_PEAK_WINDOWS: PeakWindow[] = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 14 * 60, end: 18 * 60 },
]

/** Validation bound: a price must be a finite non-negative number. */
function validPrice(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/**
 * Validate one pricing entry. A malformed entry fails loud at load/settings
 * resolution so a typo in cordis.yml or settings.yaml never silently zeroes cost.
 * Peak fields are all-or-nothing: presence enables peak/off-peak pricing.
 * @param entry - raw pricing row.
 * @throws when any field is not a finite non-negative number, the id is empty,
 *   or only some peak fields are present.
 */
function validateEntry(entry: ModelPricingEntry): void {
  if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
    throw new Error('usage-cost: a pricing entry must declare a non-empty model id')
  }
  for (const field of ['cacheHit', 'cacheMiss', 'output'] as const) {
    if (!validPrice(entry[field])) {
      throw new Error(`usage-cost: pricing entry "${entry.id}" ${field} must be a finite non-negative number`)
    }
  }
  const peakFields = ['peakCacheHit', 'peakCacheMiss', 'peakOutput'] as const
  const presentCount = peakFields.filter((field) => entry[field] !== undefined).length
  if (presentCount > 0 && presentCount < peakFields.length) {
    throw new Error(`usage-cost: pricing entry "${entry.id}" must declare peakCacheHit/peakCacheMiss/peakOutput together`)
  }
  for (const field of peakFields) {
    const value = entry[field]
    if (value !== undefined && !validPrice(value)) {
      throw new Error(`usage-cost: pricing entry "${entry.id}" ${field} must be a finite non-negative number`)
    }
  }
}

/**
 * Resolve the configured pricing table into a validated, collision-checked list
 * keyed by the normalized model id (first occurrence wins).
 * @param models - raw configured pricing rows.
 * @returns an ordered list of validated rows in configuration order.
 */
export function resolvePricing(models: readonly ModelPricingEntry[]): ModelPricingEntry[] {
  const seen = new Set<string>()
  const resolved: ModelPricingEntry[] = []
  for (const raw of models) {
    validateEntry(raw)
    const id = normalizeModel(raw.id)
    if (seen.has(id)) continue
    seen.add(id)
    resolved.push({
      id,
      cacheHit: raw.cacheHit,
      cacheMiss: raw.cacheMiss,
      output: raw.output,
      peakCacheHit: raw.peakCacheHit,
      peakCacheMiss: raw.peakCacheMiss,
      peakOutput: raw.peakOutput,
    })
  }
  return resolved
}

/** Lower-case and trim a model id for prefix matching. */
function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

/**
 * Fuzzy-match a provider model id to a configured pricing row.
 * Matching order: exact normalized id, then the longest configured id that is a
 * prefix of the model id (`deepseek-v4-pro-0813` matches `deepseek-v4-pro`).
 * @param model - the provider model id from the request header.
 * @param pricing - validated pricing rows in configuration order.
 * @returns the matched row, or undefined when no row matches.
 */
export function matchModelPricing(
  model: string,
  pricing: readonly ModelPricingEntry[],
): ModelPricingEntry | undefined {
  const key = normalizeModel(model)
  let best: ModelPricingEntry | undefined
  for (const entry of pricing) {
    if (key === entry.id) return entry
    if (key.startsWith(entry.id) && (best === undefined || entry.id.length > best.id.length)) {
      best = entry
    }
  }
  return best
}

/**
 * Whether an epoch-millisecond instant falls inside a configured peak window.
 * Windows are expressed in Beijing time (UTC+8), matching DeepSeek's published
 * schedule regardless of the machine's local timezone.
 * @param epochMs - Unix epoch milliseconds.
 * @param windows - configured peak windows; an empty list means never peak.
 * @returns true when the instant is inside any peak window.
 */
export function isPeakTime(epochMs: number, windows: readonly PeakWindow[]): boolean {
  if (windows.length === 0) return false
  const date = new Date(epochMs)
  const minutes = ((date.getUTCHours() + 8) % 24) * 60 + date.getUTCMinutes()
  return windows.some((window) => minutes >= window.start && minutes < window.end)
}

/** Disjoint token counts attributed to one pricing tier (peak or off-peak). */
export interface TokenSplit {
  cacheHit: number
  cacheMiss: number
  output: number
}

/**
 * Compute cost in CNY from peak and off-peak token splits.
 * A fixed-price row prices both splits with its base rates; a peak/off-peak row
 * prices the peak split with peak rates and the off-peak split with base rates.
 * @param pricing - the matched pricing row.
 * @param peak - peak-window token counts.
 * @param offPeak - off-peak-window token counts.
 * @returns the cost in CNY.
 */
export function computeCost(
  pricing: ModelPricingEntry,
  peak: TokenSplit,
  offPeak: TokenSplit,
): number {
  const peakPrice = pricing.peakCacheHit !== undefined
    ? { cacheHit: pricing.peakCacheHit, cacheMiss: pricing.peakCacheMiss ?? 0, output: pricing.peakOutput ?? 0 }
    : { cacheHit: pricing.cacheHit, cacheMiss: pricing.cacheMiss, output: pricing.output }
  const offPrice = { cacheHit: pricing.cacheHit, cacheMiss: pricing.cacheMiss, output: pricing.output }
  return (peak.cacheHit * peakPrice.cacheHit + peak.cacheMiss * peakPrice.cacheMiss + peak.output * peakPrice.output
    + offPeak.cacheHit * offPrice.cacheHit + offPeak.cacheMiss * offPrice.cacheMiss + offPeak.output * offPrice.output) / 1e6
}

/** Default resolved configuration for a composition entry that omits every tunable. */
export const DEFAULT_CONFIG: UsageCostConfig = {
  models: DEFAULT_MODEL_PRICING,
  budgetYuan: 0,
  peakWindows: DEFAULT_PEAK_WINDOWS,
  chunkInterval: 50,
  timeIntervalMs: 100,
}
