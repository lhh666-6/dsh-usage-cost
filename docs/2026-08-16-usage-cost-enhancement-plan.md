# dsh-usage-cost 增强实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-usage-cost` 插件加上单价显示、总额度/剩余金额、主对话/子代理/按模型/按日期分类，并重排详情面板 UI。

**Architecture:** 扩展现有 `usageCost` session 投影 + `UsageTotalsStore`。新字段在 `view` 现算（价格/额度/剩余）或来自 live 的 `getTotals()`（累计/分类）；不改 fold state，`stateVersion` 保持 1，仅扩展 value `schema` 与 `view`。

**Tech Stack:** TypeScript、Cordis session-projection、zod、gpt-tokenizer、React（`React.createElement`）、tsdown 打包、vitest（新增，仅测纯逻辑）。

**设计文档：** `dsh-usage-cost/docs/2026-08-16-usage-cost-enhancement-design.md`

---

## 目录约定

- 插件根目录（npm 命令在此运行）：`D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost`
- git 仓库根（commit 命令在此运行）：`D:\Claude_Design\deepseek-harness-desktop`
- 下文 `npm run …` 均在插件根目录；`git …` 均在仓库根，路径以 `dsh-usage-cost/…` 开头。

## 文件结构（改动总览）

| 文件 | 职责 | 变更 |
|---|---|---|
| `src/types.ts` | 纯类型 + `SessionProjectionMap` 合并 | 增 `budgetYuan`、`total/main/subagent`、`pricing/budgetYuan/remaining*` |
| `src/pricing.ts` | 价格表/匹配/成本公式/默认配置 | `DEFAULT_CONFIG` 增 `budgetYuan: 0` |
| `src/aggregates.ts` | 累计 store + 持久化 + 幂等 | 增 `total/main/subagent` 桶、`record` 增 `category` |
| `src/projection.ts` | `usageCost` 投影 fold/view | deps 增 `resolvePricingEntry/getBudget`，view 现算价格/剩余 |
| `src/index.ts` | Host 入口：配置/累计/投影接线 | 增 `budgetYuan` 配置、`resolvePricingEntry/getBudget`、category 派生 |
| `src/client/format.ts` | 格式化 | 增 `formatPrice`、`percentOf` |
| `src/client/UsageCapsule.tsx` | 胶囊 + 详情面板 | 面板重排为分节卡片 |
| `test/aggregates.test.ts` | 新增单测 | 分类累计/幂等/向后兼容 |
| `test/projection.test.ts` | 新增单测 | 价格/剩余现算 |
| `package.json` | 脚本/依赖 | 增 `test` 脚本 + `vitest` devDep |
| `vitest.config.ts` | 新增 | vitest 配置 |

---

## Task 1: 引入 vitest 测试基础设施

**Files:**
- Modify: `dsh-usage-cost/package.json`
- Create: `dsh-usage-cost/vitest.config.ts`
- Create: `dsh-usage-cost/test/smoke.test.ts`

- [ ] **Step 1: 安装 vitest 并加 test 脚本**

在插件根目录运行：

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm install --save-dev vitest
```

然后编辑 `package.json` 的 `scripts` 段，加入 `"test": "vitest run"`（最终 `scripts` 形如）：

```json
"scripts": {
  "build": "tsdown",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit",
  "test": "vitest run",
  "bundle": "tsdown",
  "watch": "tsdown --watch"
}
```

- [ ] **Step 2: 创建 vitest 配置**

创建 `vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 3: 写冒烟测试**

创建 `test/smoke.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

describe('vitest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: 运行确认通过**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run test
```

Expected: 输出 `Test Files  1 passed` 或类似，退出码 0。

- [ ] **Step 5: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/package.json dsh-usage-cost/package-lock.json dsh-usage-cost/vitest.config.ts dsh-usage-cost/test/smoke.test.ts
git commit -m "test(dsh-usage-cost): add vitest infrastructure"
```

> 若 `package-lock.json` 不存在（该包之前未提交锁文件），去掉那行再提交。

---

## Task 2: 扩展类型与默认配置

**Files:**
- Modify: `dsh-usage-cost/src/types.ts`
- Modify: `dsh-usage-cost/src/pricing.ts`

- [ ] **Step 1: 扩展 `UsageTotals` / `UsageCostConfig` / `UsageCostProjection`**

编辑 `src/types.ts`：

`UsageCostConfig` 增加 `budgetYuan`：

```ts
export interface UsageCostConfig {
  /** Fuzzy-matched pricing table; later entries do not override earlier ones on collision. */
  models: ModelPricingEntry[]
  /** Total budget in CNY; 0 means "not set" (remaining is hidden). */
  budgetYuan: number
  /** Re-estimate streaming output tokens every N chunks (whichever comes first with the time window). */
  chunkInterval: number
  /** Re-estimate streaming output tokens after at least this many milliseconds. */
  timeIntervalMs: number
}
```

`UsageTotals` 增加三个桶：

```ts
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
```

`UsageCostProjection` 增加四个字段：

```ts
export interface UsageCostProjection {
  // …现有字段不变（model/status/inputTokens/outputTokens/cacheHitTokens/cacheMissTokens/
  //   totalTokens/costYuan/durationMs/tokensPerSecond/calibrated/totals）…
  /** The matched pricing row for the session model, or null when unmatched. */
  pricing: ModelPricingEntry | null
  /** Total budget in CNY (0 = not set). */
  budgetYuan: number
  /** budget − month.costYuan, or null when budget is not set. */
  remainingMonth: number | null
  /** budget − total.costYuan, or null when budget is not set. */
  remainingTotal: number | null
  totals: UsageTotals
}
```

- [ ] **Step 2: `DEFAULT_CONFIG` 增 `budgetYuan`**

编辑 `src/pricing.ts` 末尾：

```ts
export const DEFAULT_CONFIG: UsageCostConfig = {
  models: DEFAULT_MODEL_PRICING,
  budgetYuan: 0,
  chunkInterval: 50,
  timeIntervalMs: 100,
}
```

- [ ] **Step 3: 类型检查通过**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run typecheck
```

Expected: 此时 `src/index.ts` 的 `base` 归一化、`src/projection.ts`、`src/aggregates.ts` 会因新字段缺失而报错——这是预期的「红」，后续 Task 逐步修复。**本步只需确认没有 typos/语法错误**；若想本步即绿，可暂不运行 typecheck，改在 Task 5 后统一绿。执行者自行选择，但 Task 5 结束时必须全绿。

- [ ] **Step 4: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/types.ts dsh-usage-cost/src/pricing.ts
git commit -m "feat(dsh-usage-cost): add budget/category/pricing types"
```

---

## Task 3: aggregates.ts 增加分类与累计桶

**Files:**
- Modify: `dsh-usage-cost/src/aggregates.ts`
- Test: `dsh-usage-cost/test/aggregates.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/aggregates.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageTotalsStore } from '../src/aggregates.ts'
import { DEFAULT_MODEL_PRICING } from '../src/pricing.ts'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  ...over,
})

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-cost-'))
  file = join(dir, 'aggregates.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('UsageTotalsStore', () => {
  it('accumulates into total and main/subagent by category', async () => {
    const store = new UsageTotalsStore(file, () => DEFAULT_MODEL_PRICING)
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage({ cacheReadTokens: 100, outputTokens: 100 }), 'main')
    store.record('s2', 1, 'deepseek-chat', usage({ inputTokens: 500, cacheReadTokens: 50, outputTokens: 50 }), 'subagent')

    const snap = store.snapshot()
    expect(snap.total.requests).toBe(2)
    expect(snap.main.requests).toBe(1)
    expect(snap.subagent.requests).toBe(1)
    expect(snap.total.costYuan).toBeCloseTo(snap.main.costYuan + snap.subagent.costYuan, 6)
    await store.dispose()
  })

  it('is idempotent per session sequence watermark', async () => {
    const store = new UsageTotalsStore(file, () => DEFAULT_MODEL_PRICING)
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage(), 'main')
    store.record('s1', 1, 'deepseek-chat', usage(), 'main') // replay of same seq
    store.record('s1', 2, 'deepseek-chat', usage(), 'main')

    const snap = store.snapshot()
    expect(snap.total.requests).toBe(2)
    expect(snap.main.requests).toBe(2)
    await store.dispose()
  })

  it('persists new buckets and loads a legacy doc without them', async () => {
    const store = new UsageTotalsStore(file, () => DEFAULT_MODEL_PRICING)
    await store.start()
    store.record('s1', 1, 'deepseek-chat', usage({ outputTokens: 100 }), 'main')
    await store.dispose()

    // Strip new fields to simulate a legacy v1 document.
    const raw = JSON.parse(await readFile(file, 'utf8'))
    delete raw.total
    delete raw.main
    delete raw.subagent
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const store2 = new UsageTotalsStore(file, () => DEFAULT_MODEL_PRICING)
    await store2.start()
    const snap = store2.snapshot()
    expect(snap.today.requests).toBe(1)   // legacy data preserved
    expect(snap.total.requests).toBe(0)   // new buckets default empty
    expect(snap.main.requests).toBe(0)
    expect(snap.subagent.requests).toBe(0)
    await store2.dispose()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npx vitest run test/aggregates.test.ts
```

Expected: 编译/类型错误或断言失败（`snap.total` 为 `undefined`、`record` 不接受第 5 个参数等）。

- [ ] **Step 3: 实现 aggregates.ts**

编辑 `src/aggregates.ts`：

`PersistedAggregates` 增加三个桶：

```ts
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
```

`parseDocument` 返回体增加缺省回退（向后兼容，不升 `PERSIST_VERSION`）：

```ts
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
```

构造函数初始 `state`：

```ts
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
```

`record` 签名与累加（新增 `category` 参数，累加 `total` + `main`/`subagent`）：

```ts
record(sessionId: string, seq: number, model: string, usage: TokenUsage, category: 'main' | 'subagent'): void {
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
  const inc: UsageTotalsBucket = {
    costYuan: entry === undefined ? 0 : computeCost(entry, cacheHit, cacheMiss, output),
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
```

`snapshot` 返回新桶：

```ts
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
```

> `rollover()` 不改：它只重置 `today`/`month`，`total`/`main`/`subagent` 永不重置。

- [ ] **Step 4: 运行确认通过**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npx vitest run test/aggregates.test.ts
```

Expected: 3 个用例全部 PASS。

- [ ] **Step 5: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/aggregates.ts dsh-usage-cost/test/aggregates.test.ts
git commit -m "feat(dsh-usage-cost): categorize aggregates by main/subagent and add all-time total"
```

---

## Task 4: projection.ts 现算价格/额度/剩余

**Files:**
- Modify: `dsh-usage-cost/src/projection.ts`
- Test: `dsh-usage-cost/test/projection.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/projection.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createUsageCostProjection } from '../src/projection.ts'
import type { ModelPricingEntry, UsageTotals, UsageTotalsBucket } from '../src/types.ts'

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

const pricing: ModelPricingEntry = { id: 'deepseek-chat', cacheHit: 0.5, cacheMiss: 2, output: 8 }

const makeDef = (budget: number) =>
  createUsageCostProjection({
    resolveCost: (m, h, miss, out) => (m === 'deepseek-chat' ? h / 1e6 * 0.5 + miss / 1e6 * 2 + out / 1e6 * 8 : null),
    resolvePricingEntry: (m) => (m === 'deepseek-chat' ? pricing : null),
    getBudget: () => budget,
    getTotals: () => totals(),
    chunkInterval: 50,
    timeIntervalMs: 100,
  })

const headerEvent = (model: string): any => ({
  type: 'request/header', seq: 0, time: 0,
  data: { header: { config: { model } }, reason: 'initial' },
})

describe('createUsageCostProjection view', () => {
  it('exposes pricing for the matched model', () => {
    const def = makeDef(100)
    let state = def.init()
    state = def.apply(state, headerEvent('deepseek-chat'))
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
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npx vitest run test/projection.test.ts
```

Expected: 失败——`deps.resolvePricingEntry`/`deps.getBudget` 不存在、`view` 无 `pricing`/`remaining*` 字段。

- [ ] **Step 3: 实现 projection.ts**

编辑 `src/projection.ts`：

① 顶部 import 增加 `ModelPricingEntry`：

```ts
import type { UsageCostProjection, UsageTotals, ModelPricingEntry } from './types.ts'
```

② deps 增加两个方法：

```ts
export interface UsageCostProjectionDeps {
  resolveCost: (
    model: string,
    cacheHitTokens: number,
    cacheMissTokens: number,
    outputTokens: number,
  ) => number | null
  resolvePricingEntry: (model: string) => ModelPricingEntry | null
  getBudget: () => number
  getTotals: () => UsageTotals
  chunkInterval: number
  timeIntervalMs: number
}
```

③ `emptyTotals` 增加三桶：

```ts
const emptyTotals = (): UsageTotals => ({
  today: emptyTotalsBucket(),
  month: emptyTotalsBucket(),
  total: emptyTotalsBucket(),
  main: emptyTotalsBucket(),
  subagent: emptyTotalsBucket(),
  models: {},
})
```

④ `totalsSchema` 增加三桶：

```ts
const totalsSchema = z.object({
  today: totalsBucketSchema,
  month: totalsBucketSchema,
  total: totalsBucketSchema,
  main: totalsBucketSchema,
  subagent: totalsBucketSchema,
  models: z.record(z.string(), totalsBucketSchema),
})
```

⑤ 新增 pricing schema 并扩展 `usageCostSchema`：

```ts
const pricingSchema = z.object({
  id: z.string(),
  cacheHit: z.number(),
  cacheMiss: z.number(),
  output: z.number(),
}).nullable()

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
  totals: totalsSchema,
})
```

⑥ `view` 现算新字段（把 `totals` 提为局部变量，新增 `budgetYuan`/`pricing`/`remaining*`）：

```ts
const view = (state: UsageCostState): UsageCostProjection => {
  const streaming = state.step !== null
  const cacheHitTokens = state.authCacheRead
  const cacheMissTokens = streaming
    ? Math.max(0, state.estInput - state.authCacheRead)
    : state.authInput - state.authCacheRead - state.authCacheWrite
  const inputTokens = streaming ? state.estInput : state.authInput
  const outputTokens = state.authOutput + state.estOutput + (state.step?.outputTokens ?? 0)
  const model = state.model
  const costYuan = model === null
    ? null
    : deps.resolveCost(model, cacheHitTokens, cacheMissTokens, outputTokens)
  const totals = deps.getTotals()
  const budgetYuan = deps.getBudget()
  const pricing = model === null ? null : deps.resolvePricingEntry(model)
  const remainingMonth = budgetYuan > 0 ? budgetYuan - totals.month.costYuan : null
  const remainingTotal = budgetYuan > 0 ? budgetYuan - totals.total.costYuan : null
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
    totals,
  }
}
```

> 保持 `stateVersion: 1` 不变。

- [ ] **Step 4: 运行确认通过**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npx vitest run test/projection.test.ts
```

Expected: 4 个用例全部 PASS。

- [ ] **Step 5: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/projection.ts dsh-usage-cost/test/projection.test.ts
git commit -m "feat(dsh-usage-cost): expose pricing, budget, and remaining in projection"
```

---

## Task 5: index.ts 接线（配置 + 价格解析 + 分类派生）

**Files:**
- Modify: `dsh-usage-cost/src/index.ts`

- [ ] **Step 1: 增 `budgetYuan` 配置 + `resolvePricingEntry` + `getBudget` + category 派生**

编辑 `src/index.ts`：

① `Config` 增加 `budgetYuan`：

```ts
export const Config: z<UsageCostConfig> = z.object({
  models: z.array(pricingEntrySchema).default(DEFAULT_CONFIG.models),
  budgetYuan: z.number().min(0).default(DEFAULT_CONFIG.budgetYuan),
  chunkInterval: z.number().step(1).min(1).default(DEFAULT_CONFIG.chunkInterval),
  timeIntervalMs: z.number().min(0).default(DEFAULT_CONFIG.timeIntervalMs),
})
```

② `base` 归一化增加 `budgetYuan`：

```ts
const base: UsageCostConfig = {
  models: config.models ?? DEFAULT_CONFIG.models,
  budgetYuan: config.budgetYuan ?? DEFAULT_CONFIG.budgetYuan,
  chunkInterval: config.chunkInterval ?? DEFAULT_CONFIG.chunkInterval,
  timeIntervalMs: config.timeIntervalMs ?? DEFAULT_CONFIG.timeIntervalMs,
}
```

③ 在 `resolveCost` 之后增加两个闭包：

```ts
const resolvePricingEntry = (model: string): ModelPricingEntry | null =>
  matchModelPricing(model, pricing) ?? null

const getBudget = (): number => current().budgetYuan
```

④ `session/event` 处理里派生 `category` 并传入 `record`：

```ts
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
    totals.record(session.id, event.seq, modelBySession.get(session) ?? '', event.data.usage, category)
  }
})
```

⑤ 投影注册传入新 deps：

```ts
projectionCtx.sessionProjections.register(createUsageCostProjection({
  resolveCost,
  resolvePricingEntry,
  getBudget,
  getTotals: () => totals.snapshot(),
  chunkInterval: base.chunkInterval,
  timeIntervalMs: base.timeIntervalMs,
}))
```

- [ ] **Step 2: 类型检查 + 单测 + 构建**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run typecheck
npm run test
npm run build
```

Expected: 三个命令全部通过，退出码 0。

- [ ] **Step 3: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/index.ts
git commit -m "feat(dsh-usage-cost): wire budget config, pricing resolver, and session category"
```

---

## Task 6: format.ts 增加价格与占比辅助

**Files:**
- Modify: `dsh-usage-cost/src/client/format.ts`

- [ ] **Step 1: 增加两个纯函数**

编辑 `src/client/format.ts`，追加：

```ts
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
```

- [ ] **Step 2: 类型检查**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run typecheck
```

Expected: 通过。

- [ ] **Step 3: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/client/format.ts
git commit -m "feat(dsh-usage-cost): add price and percent formatting helpers"
```

---

## Task 7: 重排 UsageCapsule 面板 UI

**Files:**
- Modify: `dsh-usage-cost/src/client/UsageCapsule.tsx`

- [ ] **Step 1: 用下方完整文件替换 `UsageCapsule.tsx`**

```tsx
/**
 * UsageCapsule: status-bar pill plus a sectioned detail panel. Live data
 * arrives as the `usageCost` projection whole value through `useProjection`.
 * Sections: session usage → unit price → budget & remaining → categorized
 * consumption (main/subagent, per model, today/month/all-time).
 */

import { useCallback, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageCostProjection } from '../types.ts'
import { formatCost, formatDuration, formatTokens, formatTokensCompact, formatPrice, percentOf } from './format.ts'

type CapsuleProps = PropsRuntime<'conversation.session.header.utilities'>

const RED = '#e5484d'
const AMBER = '#f5a623'
const GREEN = '#3ddc84'
const GRAY = '#8a8f98'

const STATUS_META: Record<UsageCostProjection['status'], { label: string; color: string }> = {
  idle: { label: '等待中', color: GRAY },
  estimating: { label: '估算中', color: AMBER },
  calibrated: { label: '已校准', color: GREEN },
  incomplete: { label: '未完成', color: GRAY },
}

const capsuleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid var(--dsw-border-subtle, rgba(128,128,128,0.28))',
  background: 'var(--dsw-surface-subtle, rgba(128,128,128,0.10))',
  color: 'var(--dsw-text-secondary, inherit)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.3,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 1000,
  width: 340,
  padding: 14,
  borderRadius: 12,
  border: '1px solid var(--dsw-border-subtle, rgba(128,128,128,0.28))',
  background: 'var(--dsw-surface, #16181d)',
  color: 'var(--dsw-text-primary, inherit)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  fontSize: 12.5,
  lineHeight: 1.5,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  border: '1px solid',
}

const dotStyle: CSSProperties = { width: 6, height: 6, borderRadius: 999 }

const sectionTitleStyle: CSSProperties = {
  margin: '4px 0 2px',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--dsw-text-tertiary, rgba(255,255,255,0.45))',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '2px 0',
}

const labelStyle: CSSProperties = { color: 'var(--dsw-text-secondary, rgba(255,255,255,0.6))' }
const valueStyle: CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const monoStyle: CSSProperties = { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums' }
const mutedStyle: CSSProperties = { color: 'var(--dsw-text-tertiary, rgba(255,255,255,0.45))', padding: '2px 0' }

const barTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-border-subtle, rgba(128,128,128,0.25))',
  overflow: 'hidden',
  margin: '4px 0 6px',
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }): ReactElement {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueColor ? { ...valueStyle, color: valueColor } : valueStyle}>{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div>
      <div style={sectionTitleStyle}>{title}</div>
      {children}
    </div>
  )
}

function Divider(): ReactElement {
  return <div style={{ height: 1, margin: '8px 0', background: 'var(--dsw-border-subtle, rgba(128,128,128,0.28))' }} />
}

function SubDivider(): ReactElement {
  return <div style={{ height: 1, margin: '6px 0', background: 'var(--dsw-border-subtle, rgba(128,128,128,0.16))' }} />
}

function StatusBadge({ status }: { status: UsageCostProjection['status'] }): ReactElement {
  const meta = STATUS_META[status]
  return (
    <span style={{ ...badgeStyle, color: meta.color, borderColor: meta.color }}>
      <span style={{ ...dotStyle, background: meta.color }} />
      {meta.label}
    </span>
  )
}

function RatioBar({ main, subagent }: { main: number; subagent: number }): ReactElement {
  const pct = percentOf(main, main + subagent)
  return (
    <div style={barTrackStyle}>
      <div style={{ width: `${pct}%`, height: '100%', background: GREEN, borderRadius: 3 }} />
    </div>
  )
}

function DetailPanel({ projection }: { projection: UsageCostProjection }): ReactElement {
  const approximate = !projection.calibrated
  const mark = approximate ? '~' : ''
  const cost = projection.costYuan
  const costValue = cost === null ? '未配置价格' : `${approximate ? '~' : ''}${formatCost(cost)}`
  const tps = projection.tokensPerSecond === null
    ? '—'
    : `${projection.tokensPerSecond.toFixed(1)} tok/s`
  const p = projection.pricing
  const totals = projection.totals
  const budget = projection.budgetYuan
  const budgetOn = budget > 0
  const remTotal = projection.remainingTotal
  const remMonth = projection.remainingMonth

  const remainingColor = (r: number | null): string | undefined =>
    r === null ? undefined : r < 0 ? RED : r < budget * 0.1 ? AMBER : GREEN

  const models = Object.entries(totals.models).sort((a, b) => b[1].costYuan - a[1].costYuan)

  return (
    <div style={panelStyle} role="dialog" aria-label="用量与成本详情">
      <div style={headerStyle}>
        <span style={{ ...monoStyle, fontWeight: 600 }}>{projection.model ?? '—'}</span>
        <StatusBadge status={projection.status} />
      </div>

      <Divider />

      <Section title="本次会话">
        <Row label="输入 token" value={`${mark}${formatTokens(projection.inputTokens)}`} />
        <Row label="输出 token" value={`${mark}${formatTokens(projection.outputTokens)}`} />
        <Row label="缓存命中" value={`${mark}${formatTokens(projection.cacheHitTokens)}`} />
        <Row label="缓存未命中" value={`${mark}${formatTokens(projection.cacheMissTokens)}`} />
        <Row label="总 token" value={`${mark}${formatTokens(projection.totalTokens)}`} />
        <Row label="本次成本" value={costValue} />
        <Row label="耗时 · 速度" value={`${formatDuration(projection.durationMs)} · ${tps}`} />
      </Section>

      <Divider />

      <Section title="单价（¥ / 1M token）">
        {p === null ? (
          <div style={mutedStyle}>未配置价格</div>
        ) : (
          <>
            <Row label="缓存命中" value={formatPrice(p.cacheHit)} />
            <Row label="缓存未命中" value={formatPrice(p.cacheMiss)} />
            <Row label="输出" value={formatPrice(p.output)} />
          </>
        )}
      </Section>

      <Divider />

      <Section title="额度与剩余">
        {!budgetOn ? (
          <div style={mutedStyle}>未设置总额度（在 settings.yaml 的 usage-cost.budgetYuan 配置）</div>
        ) : (
          <>
            <Row label="累计总消耗" value={formatCost(totals.total.costYuan)} />
            <Row label="累计剩余" value={remTotal === null ? '—' : formatCost(remTotal)} valueColor={remainingColor(remTotal)} />
            <Row label="本月消耗" value={formatCost(totals.month.costYuan)} />
            <Row label="本月剩余" value={remMonth === null ? '—' : formatCost(remMonth)} valueColor={remainingColor(remMonth)} />
          </>
        )}
      </Section>

      <Divider />

      <Section title="分类消耗">
        <Row label="主对话" value={formatCost(totals.main.costYuan)} />
        <Row label="子代理" value={formatCost(totals.subagent.costYuan)} />
        <RatioBar main={totals.main.costYuan} subagent={totals.subagent.costYuan} />
        <SubDivider />
        <div style={mutedStyle}>按模型</div>
        {models.length === 0 ? (
          <div style={mutedStyle}>暂无数据</div>
        ) : (
          models.map(([id, bucket]) => (
            <Row key={id} label={id} value={formatCost(bucket.costYuan)} />
          ))
        )}
        <SubDivider />
        <div style={mutedStyle}>按日期</div>
        <Row label="今日" value={formatCost(totals.today.costYuan)} />
        <Row label="本月" value={formatCost(totals.month.costYuan)} />
        <Row label="累计" value={formatCost(totals.total.costYuan)} />
      </Section>
    </div>
  )
}

export function UsageCapsule({ useProjection }: CapsuleProps): ReactElement | null {
  const projection = useProjection('usageCost')
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(value => !value), [])

  if (projection === undefined) return null

  const approximate = !projection.calibrated
  const mark = approximate ? '~' : ''
  const model = projection.model ?? '—'
  const inTok = projection.inputTokens
  const outTok = projection.outputTokens
  const cost = projection.costYuan === null ? '未配置价格' : formatCost(projection.costYuan)
  const isEstimating = projection.status === 'estimating'
  const p = projection.pricing
  const priceTip = p === null
    ? '未配置价格'
    : `单价（每 1M）：缓存命中 ${formatPrice(p.cacheHit)} · 未命中 ${formatPrice(p.cacheMiss)} · 输出 ${formatPrice(p.output)}`

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        style={capsuleStyle}
        onClick={toggle}
        aria-expanded={open}
        aria-label="用量与成本"
        title={isEstimating ? `${priceTip}（流式估算中）` : priceTip}
      >
        <span style={monoStyle}>{model}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>入 <b style={monoStyle}>{mark}{formatTokensCompact(inTok)}</b></span>
        <span>出 <b style={monoStyle}>{mark}{formatTokensCompact(outTok)}</b></span>
        <span style={{ opacity: 0.5 }}>·</span>
        <b style={monoStyle}>{approximate ? `${mark}${cost}` : cost}</b>
        {isEstimating && <span style={{ opacity: 0.6 }}>·</span>}
      </button>
      {open && <DetailPanel projection={projection} />}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查 + 构建**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run typecheck
npm run build
```

Expected: 通过（注意 `tsconfig.client.json` 会校验 JSX；`formatPrice`/`percentOf` 已由 Task 6 提供）。

- [ ] **Step 3: 提交**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop
git add dsh-usage-cost/src/client/UsageCapsule.tsx
git commit -m "feat(dsh-usage-cost): sectioned detail panel with price, budget, and category breakdown"
```

---

## Task 8: 全量验证 + 手动 web profile 检查

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量自动化验证**

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm run typecheck
npm run test
npm run build
```

Expected: 全部通过，退出码 0。

- [ ] **Step 2: 重启老 DeepSeek Harness 手动验证**

1. 确认 `C:\Users\lenovo\.dsh\profiles\web\node_modules\dsh-usage-cost` 仍是指回本目录的 `link:` 链接（`npm run build` 已刷新 `lib/`）。
2. 启动老的 **DeepSeek Harness**（rc.5，web profile）。
3. 检查：
   - 胶囊 hover 显示单价；点击展开面板，五节齐全（本次会话/单价/额度与剩余/分类消耗）。
   - 未设 `budgetYuan` 时「额度与剩余」显示引导文案。
   - 在 `settings.yaml` 的 `usage-cost` 段设 `budgetYuan: 50`，重启后「累计剩余/本月剩余」出现并随对话减少，颜色分级正确。
   - 发起一个 subagent 对话（子代理）后，面板「子代理」成本增加，「主对话」不变。
   - 未配价格模型显示「未配置价格」。
4. 重启后检查 `$DSH_HOME/usage-cost/aggregates.json` 里新增了 `total`/`main`/`subagent` 字段，且旧的 `today`/`month`/`models` 数据未丢失。

- [ ] **Step 3: 若发现 UI 或数据问题，修复后回到 Step 1 重跑验证，再提交**

（此步仅在发现问题时执行；正常情况下 Task 8 无需新提交。）

---

## Self-Review 结果（已内联修正）

- **Spec 覆盖**：四个目标均有对应任务——单价（Task 4/7）、额度剩余（Task 2/4/5/7）、分类（Task 3/5/7）、UI（Task 6/7）；§6 文件清单与 Tasks 1–7 一一对应；§8 验证对应 Task 8。
- **占位符**：无 TBD/TODO；所有改动均给出完整代码。
- **类型一致性**：`UsageTotals.total/main/subagent`、`UsageCostProjection.pricing/budgetYuan/remainingMonth/remainingTotal`、`record(..., category)`、`formatPrice`、`percentOf` 在所有任务中命名一致；`PERSIST_VERSION` 保持 1（向后兼容，无需迁移）。
