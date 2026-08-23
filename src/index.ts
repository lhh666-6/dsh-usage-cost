/**
 * Host half of dsh-usage-cost: registers the `usageCost` session projection
 * (live per-session usage/cost), accumulates cross-session today/month/model
 * totals from authoritative usage, and installs a user-settings section for the
 * configurable DeepSeek pricing table. Everything stays local.
 *
 * @module dsh-usage-cost
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AccountBalance, ModelPricingEntry, UsageCostConfig } from './types.ts'
import { DEFAULT_CONFIG, computeCost, isPeakTime, matchModelPricing, resolvePricing } from './pricing.ts'
import type { TokenSplit } from './pricing.ts'
import { createUsageCostProjection } from './projection.ts'
import { UsageTotalsStore } from './aggregates.ts'
import { BalancePoller, EMPTY_BALANCE } from './balance.ts'

export type { UsageCostConfig, UsageCostProjection, UsageTotals, ModelPricingEntry } from './types.ts'

/** Cordis plugin name (also the row id in cordis.yml). */
export const name = 'usage-cost'

/** No hard dependencies: the projection and settings registrations are optional children. */
export const inject: string[] = []

/** Settings namespace for the pricing table and throttle tunables. */
const NS = settingsNamespace('usage-cost')

// Peak fields are optional and validated by resolvePricing (all-or-nothing,
// finite non-negative); schemastery has no optional-output object type, so the
// loose `any` keeps the schema assignable to `ModelPricingEntry`.
const pricingEntrySchema = z.object({
  id: z.string().required(),
  cacheHit: z.number().min(0),
  cacheMiss: z.number().min(0),
  output: z.number().min(0),
  peakCacheHit: z.any(),
  peakCacheMiss: z.any(),
  peakOutput: z.any(),
})

const peakWindowSchema = z.object({
  start: z.number().min(0).max(1439),
  end: z.number().min(0).max(1440),
})

/** Plugin config, also the settings-section shape (schema defaults fill omissions). */
export const Config: z<UsageCostConfig> = z.object({
  models: z.array(pricingEntrySchema).default(DEFAULT_CONFIG.models as any),
  budgetYuan: z.number().min(0).default(DEFAULT_CONFIG.budgetYuan),
  peakWindows: z.array(peakWindowSchema).default(DEFAULT_CONFIG.peakWindows),
  chunkInterval: z.number().step(1).min(1).default(DEFAULT_CONFIG.chunkInterval),
  timeIntervalMs: z.number().min(0).default(DEFAULT_CONFIG.timeIntervalMs),
})

/**
 * Compose the usage/cost host capabilities for one plugin fiber.
 * @param ctx - Cordis context owning every effect below.
 * @param config - composition entry config (possibly partial); settings may override it.
 */
export function apply(ctx: Context, config: Partial<UsageCostConfig> = {}): void {
  // Normalize the entry against defaults: the Loader hands back whatever the
  // row's `config` literal was (often empty), never a schema-defaulted value.
  const base: UsageCostConfig = {
    models: config.models ?? DEFAULT_CONFIG.models,
    budgetYuan: config.budgetYuan ?? DEFAULT_CONFIG.budgetYuan,
    peakWindows: config.peakWindows ?? DEFAULT_CONFIG.peakWindows,
    chunkInterval: config.chunkInterval ?? DEFAULT_CONFIG.chunkInterval,
    timeIntervalMs: config.timeIntervalMs ?? DEFAULT_CONFIG.timeIntervalMs,
  }

  // Live pricing: the composition entry is the base layer; a settings service
  // attaches and overrides it, and `recompute` re-resolves after every change.
  let current: () => UsageCostConfig = () => base
  let pricing: ModelPricingEntry[] = resolvePricing(base.models)
  const recompute = (): void => {
    pricing = resolvePricing(current().models)
  }
  recompute()

  const resolveCost = (model: string, peak: TokenSplit, offPeak: TokenSplit): number | null => {
    const entry = matchModelPricing(model, pricing)
    if (entry === undefined) return null
    return computeCost(entry, peak, offPeak)
  }

  const resolvePricingEntry = (model: string): ModelPricingEntry | null =>
    matchModelPricing(model, pricing) ?? null

  const getBudget = (): number => current().budgetYuan

  const isPeak = (epochMs: number): boolean => isPeakTime(epochMs, current().peakWindows)

  installSettingsSection(ctx, NS, Config, base, {
    setSource: (source) => { current = source },
    onChange: recompute,
  })

  // Account balance: poll the DeepSeek balance endpoint. The API key resolves
  // lazily per fetch through the credential seam, then the trusted process
  // environment, then the managed credentials document as a last resort.
  const resolveApiKey = async (): Promise<string | null> => {
    const credentials = ctx.get('credentials') as
      { resolve: (ref: unknown) => Promise<{ value: string } | undefined> } | undefined
    if (credentials !== undefined) {
      const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    }
    const envKey = process.env.DEEPSEEK_API_KEY
    if (envKey !== undefined && envKey.length > 0) return envKey
    try {
      const text = await readFile(dshHomePath('.credentials.yaml'), 'utf8')
      const match = /^\s*DEEPSEEK_API_KEY\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*$/m.exec(text)
      const value = match !== null ? (match[1] ?? match[2] ?? match[3]) : null
      if (value !== null && value.length > 0) return value
    } catch {
      // absent or unreadable: leave the balance empty
    }
    return null
  }
  let balanceSnapshot: () => AccountBalance = () => EMPTY_BALANCE
  const balancePoller = new BalancePoller(resolveApiKey)
  balanceSnapshot = () => balancePoller.snapshot()
  ctx.effect(() => {
    void balancePoller.start()
    return () => balancePoller.dispose()
  }, 'usage-cost: balance poller')

  // Cross-session totals, persisted under the DSH home (local-only).
  const totals = new UsageTotalsStore(
    dshHomePath('usage-cost', 'aggregates.json'),
    () => pricing,
    () => current().peakWindows,
  )
  ctx.effect(() => {
    void totals.start()
    return () => { void totals.dispose() }
  }, 'usage-cost: totals store')

  // Track the model in force per session and record authoritative usage.
  const modelBySession = new WeakMap<Session, string>()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'request/header') {
      modelBySession.set(session, event.data.header.config.model)
      return
    }
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const header = session.header
      const category = header.origin === 'subagent' || (header.delegationDepth ?? 0) >= 1
        ? 'subagent'
        : 'main'
      totals.record(session.id, event.seq, modelBySession.get(session) ?? '', event.data.usage, category, event.time)
    }
  })

  // The per-session usage/cost projection; absent a projection registry
  // (headless assembly) this child stays dormant and the plugin remains loaded.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createUsageCostProjection({
      resolveCost,
      isPeakTime: isPeak,
      resolvePricingEntry,
      getBudget,
      getBalance: () => balanceSnapshot(),
      getTotals: () => totals.snapshot(),
      chunkInterval: base.chunkInterval,
      timeIntervalMs: base.timeIntervalMs,
    }))
  })
}
