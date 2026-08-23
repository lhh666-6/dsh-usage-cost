/**
 * Pure presentation of usage/cost figures: compact token and CNY formatters.
 * Product copy is Chinese (repo convention); these helpers format numbers only.
 *
 * @module dsh-usage-cost/client/format
 */

/** Format a token count with thousands separators, or a compact k/M form. */
export function formatTokens(tokens: number): string {
  const rounded = Math.round(tokens)
  if (!Number.isFinite(rounded)) return '—'
  return rounded.toLocaleString('en-US')
}

/** Compact token count for the capsule: 1234 → 1.2k, 1234567 → 1.23M. */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/** Format a CNY cost, keeping enough precision for sub-cent token pricing. */
export function formatCost(yuan: number): string {
  if (!Number.isFinite(yuan)) return '—'
  if (yuan === 0) return '¥0'
  if (yuan >= 1) return `¥${yuan.toFixed(2)}`
  if (yuan >= 0.01) return `¥${yuan.toFixed(4)}`
  return `¥${yuan.toFixed(6)}`
}

/** Format a millisecond duration as human-readable seconds/minutes. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** Format a per-1M price rate with exactly two decimals (e.g. ¥0.50). */
export function formatPrice(yuan: number): string {
  if (!Number.isFinite(yuan)) return '—'
  return `¥${yuan.toFixed(2)}`
}

/** Integer percentage of value over total, clamped to [0, 100]; 0 when total ≤ 0. */
export function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return Math.round(Math.min(100, Math.max(0, (value / total) * 100)))
}
