/**
 * The `usageCost` session-projection unit: a pure fold over the durable
 * session log that produces whole-session token usage, cost, wall time, and the
 * data-status (estimating / calibrated / incomplete). Authoritative provider
 * `usage` on `assistant/message` replaces streaming estimates; a step that ends
 * without usage keeps its estimate and marks the session `incomplete` without
 * touching calibrated history.
 *
 * @module dsh-usage-cost/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  AssistantMessage, ContentBlock, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AccountBalance, UsageCostProjection, UsageTotals, ModelPricingEntry } from './types.ts'
import type { TokenSplit } from './pricing.ts'
import { estimateTextTokens } from './estimator.ts'

/** Resolve cost for a matched model from peak/off-peak token splits, or null when unpriced. */
export interface UsageCostProjectionDeps {
  resolveCost: (
    model: string,
    peak: TokenSplit,
    offPeak: TokenSplit,
  ) => number | null
  /** Whether an epoch-millisecond instant falls inside a peak window. */
  isPeakTime: (epochMs: number) => boolean
  resolvePricingEntry: (model: string) => ModelPricingEntry | null
  getBudget: () => number
  getBalance: () => AccountBalance
  getTotals: () => UsageTotals
  chunkInterval: number
  timeIntervalMs: number
}

/** Fold state (plain JSON, persisted by the projection cache). */
export interface UsageCostState {
  model: string | null
  status: 'idle' | 'estimating' | 'calibrated' | 'incomplete'
  /** Summed authoritative prompt tokens (cached + uncached + write). */
  authInput: number
  /** Summed authoritative cache-hit tokens. */
  authCacheRead: number
  /** Summed authoritative cache-write tokens. */
  authCacheWrite: number
  /** Summed authoritative completion tokens. */
  authOutput: number
  /** Summed authoritative cache-hit tokens consumed during peak windows. */
  authPeakCacheHit: number
  /** Summed authoritative cache-miss tokens consumed during peak windows. */
  authPeakCacheMiss: number
  /** Summed authoritative completion tokens consumed during peak windows. */
  authPeakOutput: number
  /** Summed estimated output from steps that ended without usage. */
  estOutput: number
  /** Latest request header's system + tool text, for the input estimate. */
  systemText: string
  /** Cumulative user/tool message text, for the input estimate. */
  messagesText: string
  /** Token estimate over systemText + messagesText. */
  estInput: number
  /** Open step boundary and streaming estimator state. */
  step: {
    turn: number
    step: number
    startTime: number
    outputText: string
    outputTokens: number
    chunkCount: number
    lastEstimateTime: number
  } | null
  /** Summed model wall time across message-assembling steps, ms. */
  totalDurationMs: number
}

const emptyTotalsBucket = () => ({
  costYuan: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  requests: 0,
})

const emptyTotals = (): UsageTotals => ({
  today: emptyTotalsBucket(),
  month: emptyTotalsBucket(),
  total: emptyTotalsBucket(),
  main: emptyTotalsBucket(),
  subagent: emptyTotalsBucket(),
  models: {},
})

const totalsBucketSchema = z.object({
  costYuan: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheHitTokens: z.number(),
  cacheMissTokens: z.number(),
  requests: z.number().int(),
})

const totalsSchema = z.object({
  today: totalsBucketSchema,
  month: totalsBucketSchema,
  total: totalsBucketSchema,
  main: totalsBucketSchema,
  subagent: totalsBucketSchema,
  models: z.record(z.string(), totalsBucketSchema),
})

const pricingSchema = z.object({
  id: z.string(),
  cacheHit: z.number(),
  cacheMiss: z.number(),
  output: z.number(),
  peakCacheHit: z.number().optional(),
  peakCacheMiss: z.number().optional(),
  peakOutput: z.number().optional(),
}).nullable()

const balanceSchema = z.object({
  balanceYuan: z.number().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
})

const usageCostSchema = z.object({
  model: z.string().nullable(),
  status: z.enum(['idle', 'estimating', 'calibrated', 'incomplete']),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheHitTokens: z.number(),
  cacheMissTokens: z.number(),
  totalTokens: z.number(),
  costYuan: z.number().nullable(),
  durationMs: z.number(),
  tokensPerSecond: z.number().nullable(),
  calibrated: z.boolean(),
  pricing: pricingSchema,
  budgetYuan: z.number(),
  remainingMonth: z.number().nullable(),
  remainingTotal: z.number().nullable(),
  balance: balanceSchema,
  totals: totalsSchema,
})

/** The in-flight step boundary and streaming estimator, or null when idle. */
const stepStateSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  startTime: z.number(),
  outputText: z.string(),
  outputTokens: z.number(),
  chunkCount: z.number().int(),
  lastEstimateTime: z.number(),
}).nullable()

/** Validates the fold state (the `init`/`apply` `UsageCostState`) before it seeds a persisted fold. */
const usageCostStateSchema = z.object({
  model: z.string().nullable(),
  status: z.enum(['idle', 'estimating', 'calibrated', 'incomplete']),
  authInput: z.number(),
  authCacheRead: z.number(),
  authCacheWrite: z.number(),
  authOutput: z.number(),
  authPeakCacheHit: z.number(),
  authPeakCacheMiss: z.number(),
  authPeakOutput: z.number(),
  estOutput: z.number(),
  systemText: z.string(),
  messagesText: z.string(),
  estInput: z.number(),
  step: stepStateSchema,
  totalDurationMs: z.number(),
})

/** Concatenate the text of content blocks, recursing through tool-result payloads. */
function contentText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        out += block.text
        break
      case 'tool-result':
        out += contentText(block.content)
        break
      default:
        break
    }
  }
  return out
}

/** System prompt plus tool schema names/descriptions, as input-priceable text. */
function headerText(header: EpochHeader): string {
  let out = header.system ?? ''
  for (const tool of header.tools ?? []) {
    out += `${tool.name} ${tool.description ?? ''}`
  }
  return out
}

/** Whether a stream chunk carries output text worth pricing (text or reasoning). */
function chunkText(chunk: StreamChunk): string | null {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text
    default:
      return null
  }
}

/** Prompt tokens from one provider usage record (disjoint fields summed). */
function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Build the `usageCost` projection definition. The fold owns token/timing
 * mathematics only; cost and aggregate totals are injected so the unit stays
 * replay-pure while cost still reflects live pricing at read time.
 * @param deps - cost resolver, totals snapshot, and throttle tunables.
 * @returns the registrable projection definition.
 */
export function createUsageCostProjection(deps: UsageCostProjectionDeps):
ProjectionDefinition<'usageCost', UsageCostState> {
  const init = (): UsageCostState => ({
    model: null,
    status: 'idle',
    authInput: 0,
    authCacheRead: 0,
    authCacheWrite: 0,
    authOutput: 0,
    authPeakCacheHit: 0,
    authPeakCacheMiss: 0,
    authPeakOutput: 0,
    estOutput: 0,
    systemText: '',
    messagesText: '',
    estInput: 0,
    step: null,
    totalDurationMs: 0,
  })

  const apply = (state: UsageCostState, event: SessionEvent): UsageCostState => {
    switch (event.type) {
      case 'request/header': {
        const model = event.data.header.config.model
        const systemText = headerText(event.data.header)
        if (model === state.model && systemText === state.systemText) return state
        return {
          ...state,
          model,
          systemText,
          estInput: estimateTextTokens(systemText + state.messagesText),
        }
      }
      case 'user/message': {
        const text = contentText(event.data.content)
        if (text.length === 0) return state
        const messagesText = state.messagesText + text
        return {
          ...state,
          messagesText,
          estInput: estimateTextTokens(state.systemText + messagesText),
        }
      }
      case 'tool/result': {
        const text = contentText(event.data.message.content)
        if (text.length === 0) return state
        const messagesText = state.messagesText + text
        return {
          ...state,
          messagesText,
          estInput: estimateTextTokens(state.systemText + messagesText),
        }
      }
      case 'step/start': {
        return {
          ...state,
          status: 'estimating',
          step: {
            turn: event.data.turn,
            step: event.data.step,
            startTime: event.time,
            outputText: '',
            outputTokens: 0,
            chunkCount: 0,
            lastEstimateTime: event.time,
          },
        }
      }
      case 'assistant/chunk': {
        const step = state.step
        if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state
        const text = chunkText(event.data.chunk)
        if (text === null) return state
        const outputText = step.outputText + text
        const chunkCount = step.chunkCount + 1
        const due = chunkCount >= deps.chunkInterval
          || event.time - step.lastEstimateTime >= deps.timeIntervalMs
        const outputTokens = due
          ? estimateTextTokens(outputText)
          : step.outputTokens + estimateTextTokens(text)
        return {
          ...state,
          step: {
            ...step,
            outputText,
            outputTokens,
            chunkCount: due ? 0 : chunkCount,
            lastEstimateTime: due ? event.time : step.lastEstimateTime,
          },
        }
      }
      case 'assistant/message': {
        const step = state.step
        if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state
        const durationMs = Math.max(0, event.time - step.startTime)
        const usage = event.data.usage
        if (usage !== undefined) {
          const cacheRead = usage.cacheReadTokens ?? 0
          const cacheMiss = usage.inputTokens
          const output = usage.outputTokens
          const peak = deps.isPeakTime(event.time)
          return {
            ...state,
            status: 'calibrated',
            authInput: state.authInput + promptTokens(usage),
            authCacheRead: state.authCacheRead + cacheRead,
            authCacheWrite: state.authCacheWrite + (usage.cacheWriteTokens ?? 0),
            authOutput: state.authOutput + output,
            authPeakCacheHit: state.authPeakCacheHit + (peak ? cacheRead : 0),
            authPeakCacheMiss: state.authPeakCacheMiss + (peak ? cacheMiss : 0),
            authPeakOutput: state.authPeakOutput + (peak ? output : 0),
            step: null,
            totalDurationMs: state.totalDurationMs + durationMs,
          }
        }
        // No usage: keep this step's estimate as incomplete output, never
        // touching calibrated history.
        return {
          ...state,
          status: 'incomplete',
          estOutput: state.estOutput + step.outputTokens,
          step: null,
          totalDurationMs: state.totalDurationMs + durationMs,
        }
      }
      case 'step/end': {
        // step/end without a matched assistant/message (abort): keep estimates.
        const step = state.step
        if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state
        return {
          ...state,
          status: 'incomplete',
          estOutput: state.estOutput + step.outputTokens,
          step: null,
          totalDurationMs: state.totalDurationMs + Math.max(0, event.time - step.startTime),
        }
      }
      default:
        return state
    }
  }

  const view = (state: UsageCostState): UsageCostProjection => {
    const streaming = state.step !== null
    const cacheHitTokens = state.authCacheRead
    const cacheMissTokens = streaming
      ? Math.max(0, state.estInput - state.authCacheRead)
      : state.authInput - state.authCacheRead - state.authCacheWrite
    const inputTokens = streaming ? state.estInput : state.authInput
    const outputTokens = state.authOutput + state.estOutput + (state.step?.outputTokens ?? 0)
    const model = state.model

    // Authoritative cost components split by their recorded peak/off-peak window.
    const authCacheMiss = state.authInput - state.authCacheRead - state.authCacheWrite
    const peak: TokenSplit = {
      cacheHit: state.authPeakCacheHit,
      cacheMiss: state.authPeakCacheMiss,
      output: state.authPeakOutput,
    }
    const offPeak: TokenSplit = {
      cacheHit: state.authCacheRead - state.authPeakCacheHit,
      cacheMiss: authCacheMiss - state.authPeakCacheMiss,
      output: state.authOutput - state.authPeakOutput,
    }
    // Estimated (streaming / incomplete) deltas are priced at the current instant.
    const nowPeak = deps.isPeakTime(Date.now())
    const estMiss = Math.max(0, cacheMissTokens - authCacheMiss)
    const estOut = state.estOutput + (state.step?.outputTokens ?? 0)
    if (nowPeak) {
      peak.cacheMiss += estMiss
      peak.output += estOut
    } else {
      offPeak.cacheMiss += estMiss
      offPeak.output += estOut
    }

    const costYuan = model === null
      ? null
      : deps.resolveCost(model, peak, offPeak)
    const totals = deps.getTotals()
    const budgetYuan = deps.getBudget()
    const pricing = model === null ? null : deps.resolvePricingEntry(model)
    const remainingMonth = budgetYuan > 0 ? budgetYuan - totals.month.costYuan : null
    const remainingTotal = budgetYuan > 0 ? budgetYuan - totals.total.costYuan : null
    const balance = deps.getBalance()
    return {
      model,
      status: streaming ? 'estimating' : state.status,
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens,
      totalTokens: inputTokens + outputTokens,
      costYuan,
      durationMs: state.totalDurationMs,
      tokensPerSecond: state.totalDurationMs > 0 && outputTokens > 0
        ? outputTokens / (state.totalDurationMs / 1000)
        : null,
      calibrated: !streaming && state.status === 'calibrated',
      pricing,
      budgetYuan,
      remainingMonth,
      remainingTotal,
      balance,
      totals,
    }
  }

  return {
    key: 'usageCost',
    schema: usageCostSchema,
    init,
    apply,
    view,
    stateVersion: 2,
  }
}

export type { AssistantMessage }
