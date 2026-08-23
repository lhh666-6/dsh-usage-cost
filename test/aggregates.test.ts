import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageTotalsStore } from '../src/aggregates.ts'
import { DEFAULT_MODEL_PRICING, DEFAULT_PEAK_WINDOWS } from '../src/pricing.ts'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  ...over,
})

// Beijing 10:00 = UTC 02:00 (peak)
const PEAK_MS = Date.UTC(2026, 7, 17, 2, 0, 0)
// Beijing 22:00 = UTC 14:00 (off-peak)
const OFF_MS = Date.UTC(2026, 7, 17, 14, 0, 0)

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-cost-'))
  file = join(dir, 'aggregates.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const makeStore = () => new UsageTotalsStore(file, () => DEFAULT_MODEL_PRICING, () => DEFAULT_PEAK_WINDOWS)

describe('UsageTotalsStore', () => {
  it('accumulates into total and main/subagent by category', async () => {
    const store = makeStore()
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage({ cacheReadTokens: 100, outputTokens: 100 }), 'main', PEAK_MS)
    store.record('s2', 1, 'deepseek-chat', usage({ inputTokens: 500, cacheReadTokens: 50, outputTokens: 50 }), 'subagent', OFF_MS)

    const snap = store.snapshot()
    expect(snap.total.requests).toBe(2)
    expect(snap.main.requests).toBe(1)
    expect(snap.subagent.requests).toBe(1)
    expect(snap.total.costYuan).toBeCloseTo(snap.main.costYuan + snap.subagent.costYuan, 6)
    await store.dispose()
  })

  it('is idempotent per session sequence watermark', async () => {
    const store = makeStore()
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage(), 'main', PEAK_MS)
    store.record('s1', 1, 'deepseek-chat', usage(), 'main', PEAK_MS) // replay of same seq
    store.record('s1', 2, 'deepseek-chat', usage(), 'main', PEAK_MS)

    const snap = store.snapshot()
    expect(snap.total.requests).toBe(2)
    expect(snap.main.requests).toBe(2)
    await store.dispose()
  })

  it('prices a v4-pro request differently at peak vs off-peak', async () => {
    const store = makeStore()
    await store.start()
    const u = { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 1e6 }
    store.record('s1', 1, 'deepseek-v4-pro', usage(u), 'main', PEAK_MS)
    store.record('s2', 1, 'deepseek-v4-pro', usage(u), 'main', OFF_MS)

    const snap = store.snapshot()
    // peak: 9.0 (miss) + 27.0 (output) = 36.0; off-peak: 4.5 + 13.5 = 18.0
    expect(snap.total.costYuan).toBeCloseTo(36.0 + 18.0, 6)
    await store.dispose()
  })

  it('persists new buckets and loads a legacy doc without them', async () => {
    const store = makeStore()
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage({ outputTokens: 100 }), 'main', PEAK_MS)
    await store.dispose()

    // Strip new fields to simulate a legacy v1 document.
    const raw = JSON.parse(await readFile(file, 'utf8'))
    delete raw.total
    delete raw.main
    delete raw.subagent
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const store2 = makeStore()
    await store2.start()
    const snap = store2.snapshot()
    expect(snap.today.requests).toBe(1)   // legacy data preserved
    expect(snap.total.requests).toBe(0)   // new buckets default empty
    expect(snap.main.requests).toBe(0)
    expect(snap.subagent.requests).toBe(0)
    await store2.dispose()
  })
})
