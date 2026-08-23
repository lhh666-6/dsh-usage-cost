# dsh-usage-cost 增强设计文档

- 日期：2026-08-16
- 状态：设计已确认，待实现
- 范围：仅 `dsh-usage-cost/` 插件本体（不动 `dsh-plugin-desktop/`、上游 submodule）

## 1. 背景与目标

`dsh-usage-cost` 已实现：状态栏胶囊 + 详情面板，实时显示 token 用量与成本，本地持久化今日/本月/按模型累计。本次增强有四个目标：

1. **显示单价**：详情面板展示当前模型命中的价格行（缓存命中/未命中/输出，¥ 每 1M token）。
2. **显示剩余总金额**：新增一个用户自填的「总额度」，面板同时显示「本月剩余」与「累计剩余」。
3. **细分消耗**：把消耗按 **主对话 / 子代理 / 按模型 / 按日期（今日+历史）** 拆分展示。
4. **界面更好看**：详情面板从平铺行改为分节卡片，加状态徽章、占比条、余额颜色分级。

## 2. 非目标（YAGNI）

- 不接入 DeepSeek 官方余额 API（插件保持本地隐私优先）。
- 不做预算阈值告警、CSV 导出（仍列为后续可选）。
- 不迁移/补算升级前的历史数据到新分类（见 §7 已知限制）。
- 不改动桌面 2.0 内置打包（`yarn dist:win`）与部署链路。

## 3. 架构决策

采用**方案 A：扩展现有 `usageCost` 投影 + `UsageTotalsStore`**。

- 所有新字段通过现有 `usageCost` session 投影的 `view` 现算（价格、额度、剩余），或来自 live 的 `getTotals()`（累计/分类）。
- 服务端聚合持有全部跨会话数据；客户端只渲染。
- 保持重放纯：定价不进 fold state，成本/价格在 `view` 时用闭包捕获的 `resolveCost`/`resolvePricingEntry` 现算。
- **不改 fold state**：`stateVersion` 保持 1；仅扩展 value `schema` 与 `view` 输出。旧投影缓存无需失效（fold state 序列化字段与语义未变）。

备选方案（未采用）：
- 方案 B：拆独立「汇总」投影 —— 模块边界更清晰，但当前体量下多一套投影/缓存/重放，收益低。
- 方案 C：仅客户端计算 —— 分类需要访问所有会话的事件，客户端拿不到，不可行。

## 4. 数据模型变更（`src/types.ts`）

```ts
export interface UsageTotals {
  today: UsageTotalsBucket      // 今日（已有）
  month: UsageTotalsBucket      // 本月（已有）
  total: UsageTotalsBucket      // 累计总消耗（新增，永不重置）
  main: UsageTotalsBucket       // 主对话（新增）
  subagent: UsageTotalsBucket   // 子代理（新增）
  models: Record<string, UsageTotalsBucket>  // 按模型（已有）
}

export interface UsageCostConfig {
  models: ModelPricingEntry[]
  budgetYuan: number            // 总额度；0 = 未设置（新增）
  chunkInterval: number
  timeIntervalMs: number
}

export interface UsageCostProjection {
  // …现有字段不变…
  pricing: ModelPricingEntry | null   // 当前模型命中的单价行；未命中为 null（新增）
  budgetYuan: number                  // 新增
  remainingMonth: number | null       // budget − 本月消耗；budget≤0 时 null（新增）
  remainingTotal: number | null       // budget − 累计总消耗；budget≤0 时 null（新增）
  totals: UsageTotals                 // 扩展为含 total/main/subagent
}
```

`UsageTotalsBucket` 形状不变（`costYuan/inputTokens/outputTokens/cacheHitTokens/cacheMissTokens/requests`）。

## 5. 各功能设计

### 5.1 价格显示

- 投影 `view` 新增 `pricing`：`model === null ? null : deps.resolvePricingEntry(model)`。
- 新增 dep `resolvePricingEntry(model): ModelPricingEntry | null`，复用 `matchModelPricing`。
- 面板「单价」节展示三行或一行摘要：`缓存命中 ¥0.50 · 未命中 ¥2.00 · 输出 ¥8.00（每 1M token）`；未命中显示「未配置价格」。

### 5.2 额度与剩余

- 配置新增 `budgetYuan: z.number().min(0).default(0)`（0 = 未设置）。
- `view` 现算：
  - `budgetYuan = deps.getBudget()`
  - `remainingMonth = budget > 0 ? budget − totals.month.costYuan : null`
  - `remainingTotal = budget > 0 ? budget − totals.total.costYuan : null`
- 面板「额度与剩余」节：`累计总消耗 / 累计剩余 / 本月消耗 / 本月剩余`。
  - 剩余 < 0：红色；剩余 < 10% 额度：琥珀色；其余：绿色。
  - 未设额度（budgetYuan = 0）：显示「未设置总额度（在 `$DSH_HOME/settings.yaml` 的 `usage-cost.budgetYuan` 配置）」。

### 5.3 分类消耗

- 分类依据：`session.header`（见 `@deepseek-ai/dsh-session`）——
  - 子代理：`header.origin === 'subagent'` 或 `(header.delegationDepth ?? 0) >= 1`；
  - 否则主对话。
- `session/event` 处理里派生 `category: 'main' | 'subagent'`，传给 `totals.record(...)`。
- `record()` 每个权威 usage 同时累加进：`total`（永远）+ `main`/`subagent`（按类别）+ 现有 `today`/`month`/`models`。
- 面板「分类消耗」节：
  - 主对话 / 子代理：成本金额 + 一条水平占比条（占比按成本，成本为 0 时按 token）。
  - 按模型：`totals.models` 逐行（模型名 + 成本，成本为 0 显示 token）。
  - 按日期：今日 / 本月 / 累计总消耗。

### 5.4 界面更好看

详情面板改为分节卡片（自顶向下）：

```
┌ 模型名                    [● 已校准] ┐   ← 头部：模型 + 状态徽章
├ 本次会话 ────────────────────────────┤
│  输入/输出/缓存命中/未命中/总 token    │
│  本次成本 · 耗时 · tokens/s           │
├ 单价（¥ / 1M token）─────────────────┤
│  缓存命中 ¥0.50 · 未命中 ¥2.00 · 输出 ¥8.00 │
├ 额度与剩余 ──────────────────────────┤
│  累计总消耗 ¥x · 累计剩余 ¥y（带颜色） │
│  本月消耗 ¥x · 本月剩余 ¥y（带颜色）   │
├ 分类消耗 ────────────────────────────┤
│  主对话 ██████░░ ¥a（占比条）         │
│  子代理 ██░░░░░░ ¥b                  │
│  ── 按模型 ──  deepseek-chat ¥c …     │
└──────────────────────────────────────┘
```

- 节标题：小号、次要色、字母间距加宽；节间用细分隔线。
- 状态徽章：`估算中`（琥珀）/ `已校准`（绿）/ `未完成`（灰）/ `等待中`（灰）。
- 胶囊 hover 加 `title` 显示单价；面板中「剩余金额」按告警级变色（红/琥珀/绿）。

## 6. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `UsageTotals` 增 `total/main/subagent`；`UsageCostConfig` 增 `budgetYuan`；`UsageCostProjection` 增 `pricing/budgetYuan/remainingMonth/remainingTotal` |
| `src/pricing.ts` | `DEFAULT_CONFIG` 增 `budgetYuan: 0` |
| `src/index.ts` | `Config` 增 `budgetYuan`；`base` 归一化增 `budgetYuan`；新增 `resolvePricingEntry`、`getBudget`；`session/event` 派生 category 传入 `record` |
| `src/projection.ts` | deps 增 `resolvePricingEntry`/`getBudget`；`emptyTotals`/`totalsSchema` 增 `total/main/subagent`；`usageCostSchema` 增 `pricing/budgetYuan/remaining*`；`view` 现算新字段 |
| `src/aggregates.ts` | `PersistedAggregates` 增 `total/main/subagent`；`record()` 增 `category` 参数并累加新桶；`snapshot()` 含新桶；`parseDocument()` 对缺省新字段回退空桶（向后兼容，不升 `PERSIST_VERSION`） |
| `src/client/UsageCapsule.tsx` | 面板重排为分节卡片；新增单价/额度剩余/分类节；状态徽章、占比条、余额颜色 |
| `src/client/format.ts` | 新增单价与占比辅助（如 `formatPricePerM`、比例计算） |
| `cordis.yml` / `package.json` | 无改动 |

## 7. 已知限制

- **升级后新分类从 0 累计**：旧 `aggregates.json` 里的 `today/month/models` 保留，但历史事件无法追溯会话分类、也无法补算「累计」。升级后头一段时间 `main + subagent ≠ total`，属预期缺口。
- **`total`（累计）从 0 起算**：v1 文件只存了当前月/今日，无法重构全部历史，故升级后「累计总消耗」从 0 重新累计。
- **价格默认值会随官方调价过期**：沿用 settings 覆盖机制（`usage-cost.models`）。
- **子代理识别依赖 `session.header`**：多级子代理统一归「子代理」，不做按层级细分。

## 8. 验证方式

1. `npm run typecheck`（两个 face）与 `npm run build` 通过。
2. 在 web profile 实际对话：
   - 胶囊/面板正常，单价节显示命中的价格行。
   - 设 `budgetYuan` 后「累计剩余/本月剩余」随消耗减少，颜色分级正确。
   - 主对话与子代理（subagent）对话各自累计进对应分类；按模型/按日期正确。
   - 未配价格模型显示「未配置价格」，未设额度显示引导文案。
3. 重启后 `aggregates.json` 正确加载（旧文件不丢今日/本月/按模型数据）。

## 9. 后续（不在本次范围）

预算阈值告警、CSV 导出、历史会话成本排行；子代理按层级细分。
