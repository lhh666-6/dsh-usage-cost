import { describe, expect, it } from 'vitest'
import { createUsageCostProjection } from '../src/projection.ts'
import type { ModelPricingEntry, UsageTotals, UsageTotalsBucket } from '../src/types.ts'
import type { TokenSplit } from '../src/pricing.ts'

const bucket = (over: Partial<UsageTotalsBucket> = {}): UsageTotalsBucket => ({
  costYuan: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, requests: 0,
  ...over,
})

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  today: bucket(),
  month: bucket({ costYuan: 10 }),
  total: bucket({ costYuan: 30 }),
  main: bucket({ costYuan: 20 }),
  subagent: bucket({ costYuan: 10 }),
  models: {},
  ...over,
})

const pricing: ModelPricingEntry = {
  id: 'deepseek-v4-pro',
  cacheHit: 0.15, cacheMiss: 4.5, output: 13.5,
  peakCacheHit: 0.30, peakCacheMiss: 9.0, peakOutput: 27.0,
}

// Beijing 10:00 = UTC 02:00 (peak); Beijing 22:00 = UTC 14:00 (off-peak)
const PEAK_MS = Date.UTC(2026, 7, 17, 2, 0, 0)
const OFF_MS = Date.UTC(2026, 7, 17, 14, 0, 0)

const makeDef = (budget: number) =>
  createUsageCostProjection({
    resolveCost: (m, peak: TokenSplit, offPeak: TokenSplit) => (m === 'deepseek-v4-pro'
      ? (peak.cacheHit * 0.30 + peak.cacheMiss * 9.0 + peak.output * 27.0
        + offPeak.cacheHit * 0.15 + offPeak.cacheMiss * 4.5 + offPeak.output * 13.5) / 1e6
      : null),
    isPeakTime: (ms) => ms === PEAK_MS,
    resolvePricingEntry: (m) => (m === 'deepseek-v4-pro' ? pricing : null),
    getBudget: () => budget,
    getBalance: () => ({ balanceYuan: 0, error: null, fetchedAt: null }),
    getTotals: () => totals(),
    chunkInterval: 50,
    timeIntervalMs: 100,
  })

const headerEvent = (model: string): any => ({
  type: 'request/header', seq: 0, time: 0,
  data: { header: { config: { model } }, reason: 'initial' },
})

const stepStart = (time: number, turn: number, step: number): any => ({
  type: 'step/start', seq: 0, time,
  data: { turn, step },
})

const msgEvent = (time: number, turn: number, step: number, usage: any): any => ({
  type: 'assistant/message', seq: 0, time,
  data: { turn, step, message: { role: 'assistant', content: [] }, usage },
})

describe('createUsageCostProjection view', () => {
  it('exposes pricing for the matched model', () => {
    const def = makeDef(100)
    let state = def.init()
    state = def.apply(state, headerEvent('deepseek-v4-pro'))
    expect(def.view(state).pricing).toEqual(pricing)
  })

  it('computes remaining from budget and totals', () => {
    const def = makeDef(100)
    const value = def.view(def.init())
    expect(value.budgetYuan).toBe(100)
    expect(value.remainingMonth).toBeCloseTo(90, 6) // 100 - 10
    expect(value.remainingTotal).toBeCloseTo(70, 6) // 100 - 30
  })

  it('nulls remaining when budget is unset (0)', () => {
    const def = makeDef(0)
    const value = def.view(def.init())
    expect(value.budgetYuan).toBe(0)
    expect(value.remainingMonth).toBeNull()
    expect(value.remainingTotal).toBeNull()
  })

  it('nulls pricing for an unmatched model', () => {
    const def = makeDef(100)
    let state = def.init()
    state = def.apply(state, headerEvent('unknown-model'))
    expect(def.view(state).pricing).toBeNull()
  })

  it('prices peak and off-peak authoritative usage with their own rates', () => {
    const def = makeDef(100)
    let state = def.init()
    state = def.apply(state, headerEvent('deepseek-v4-pro'))
    state = def.apply(state, stepStart(PEAK_MS, 0, 0))
    state = def.apply(state, msgEvent(PEAK_MS, 0, 0, { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 1e6 }))
    state = def.apply(state, stepStart(OFF_MS, 0, 1))
    state = def.apply(state, msgEvent(OFF_MS, 0, 1, { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 1e6 }))
    const value = def.view(state)
    // peak: 9.0 + 27.0 = 36.0; off-peak: 4.5 + 13.5 = 18.0
    expect(value.costYuan).toBeCloseTo(54.0, 6)
  })
})
