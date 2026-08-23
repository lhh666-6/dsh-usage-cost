/**
 * Local token estimation backed by gpt-tokenizer (a pure-JS BPE tokenizer
 * approximating the DeepSeek tokenizer closely enough for streaming estimates).
 * Every estimate is tagged `~` in the UI and replaced by the provider `usage`
 * when the response ends, so the exact approximation error never surfaces as a
 * hard number after calibration.
 *
 * @module dsh-usage-cost/estimator
 */

import { countTokens } from 'gpt-tokenizer'

/** Characters per token fallback when the tokenizer throws on exotic input. */
const CHARS_PER_TOKEN_FALLBACK = 4

/**
 * Estimate the token count of one plain string.
 * @param text - the text to price.
 * @returns a non-negative token estimate; the empty string is zero.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0
  try {
    return Math.max(0, countTokens(text))
  } catch {
    return Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK)
  }
}

/**
 * Estimate the token count of several strings joined together, avoiding a
 * single large concatenation when callers already hold the parts.
 * @param parts - text pieces that would be concatenated model-side.
 * @returns a non-negative token estimate.
 */
export function estimateTextPartsTokens(parts: readonly string[]): number {
  let total = 0
  for (const part of parts) {
    if (part.length > 0) total += estimateTextTokens(part)
  }
  return total
}
