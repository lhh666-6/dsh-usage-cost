import { describe, expect, it } from 'vitest'
import { computeCost, DEFAULT_PEAK_WINDOWS, isPeakTime } from '../src/pricing.ts'
import type { ModelPricingEntry } from '../src/types.ts'

const v4pro: ModelPricingEntry = {
  id: 'deepseek-v4-pro',
  cacheHit: 0.15, cacheMiss: 4.5, output: 13.5,
  peakCacheHit: 0.30, peakCacheMiss: 9.0, peakOutput: 27.0,
}

const fixed: ModelPricingEntry = { id: 'deepseek-chat', cacheHit: 0.5, cacheMiss: 2, output: 8 }

// Beijing 10:00 = UTC 02:00 (peak)
const peakMs = Date.UTC(2026, 7, 17, 2, 0, 0)
// Beijing 22:00 = UTC 14:00 (off-peak)
const offMs = Date.UTC(2026, 7, 17, 14, 0, 0)

describe('isPeakTime', () => {
  it('classifies Beijing peak and off-peak instants', () => {
    expect(isPeakTime(peakMs, DEFAULT_PEAK_WINDOWS)).toBe(true)
    expect(isPeakTime(offMs, DEFAULT_PEAK_WINDOWS)).toBe(false)
    // 09:00 Beijing = UTC 01:00 (inclusive start)
    expect(isPeakTime(Date.UTC(2026, 7, 17, 1, 0, 0), DEFAULT_PEAK_WINDOWS)).toBe(true)
    // 12:00 Beijing = UTC 04:00 (exclusive end)
    expect(isPeakTime(Date.UTC(2026, 7, 17, 4, 0, 0), DEFAULT_PEAK_WINDOWS)).toBe(false)
    // 14:00 Beijing = UTC 06:00 (second window inclusive start)
    expect(isPeakTime(Date.UTC(2026, 7, 17, 6, 0, 0), DEFAULT_PEAK_WINDOWS)).toBe(true)
  })

  it('returns false for an empty window list', () => {
    expect(isPeakTime(peakMs, [])).toBe(false)
  })
})

describe('computeCost', () => {
  it('prices peak and off-peak splits with v4-pro rates', () => {
    const cost = computeCost(
      v4pro,
      { cacheHit: 1e6, cacheMiss: 1e6, output: 1e6 },
      { cacheHit: 1e6, cacheMiss: 1e6, output: 1e6 },
    )
    // peak: 0.30 + 9.0 + 27.0 = 36.30; off-peak: 0.15 + 4.5 + 13.5 = 18.15
    expect(cost).toBeCloseTo(36.30 + 18.15, 6)
  })

  it('prices a fixed-price model identically for both splits', () => {
    const cost = computeCost(
      fixed,
      { cacheHit: 1e6, cacheMiss: 0, output: 0 },
      { cacheHit: 1e6, cacheMiss: 0, output: 0 },
    )
    // 2M cache-hit tokens at ¥0.5 per 1M
    expect(cost).toBeCloseTo(1.0, 6)
  })
})
