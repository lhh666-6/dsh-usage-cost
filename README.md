# dsh-usage-cost

> GitHub: https://github.com/lhh666-6/dsh-usage-cost
>
> npm: `dsh-usage-cost`

实时显示 DeepSeek 会话 token 用量与成本的 DSH 插件（状态栏小胶囊 + 详情面板）。全部数据本地计算、本地持久化，不上传任何内容。

## 功能

- **常驻胶囊**：注册到会话标题栏右侧 `conversation.session.header.utilities`，显示模型名、输入/输出 token、本次会话成本；流式输出期间数字实时滚动，估算值带 `~` 标记。
- **详情面板**：点击胶囊展开，显示输入/输出 token、缓存命中/未命中 token、总 token、本次成本、耗时、tokens/s、今日/本月累计成本、数据状态（估算中/已校准/未完成）。
- **实时估算 + 权威校准**：流式期间用本地 tokenizer（`gpt-tokenizer`）估算，按「每 50 个 chunk 或每 100ms」节流；请求结束用 DeepSeek 返回的 `usage`（`prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`）校准。
- **成本计算**：`cost = cache_hit/1e6 * cacheHit + cache_miss/1e6 * cacheMiss + completion/1e6 * output`（人民币/百万 token）。价格表可配置，模型名模糊匹配（`deepseek-chat-2025-xxx` → `deepseek-chat`）；缺失价格只显示 token，成本显示「未配置价格」。
- **持久化**：本次会话数据走 session projection（由 `session-projection-cache` 落盘）；今日/本月/按模型累计写入 `$DSH_HOME/usage-cost/aggregates.json`，重启不丢。
- **边界**：流式中断/报错保留估算并标记「未完成」，不覆盖历史准确数据；切换会话由投影按会话隔离，不串数据；多币种暂不做汇率，默认人民币。

## 架构

这是一个**双面 DSH 插件包**（与 `dsh-plugin-desktop` 同一套插件系统，无需改动主程序）：

- **Host 面**（`lib/index.js`）：注册 `usageCost` session projection（纯 fold，框架自动做实时推送 + 落盘 + 重放），监听 `session/event` 累计今日/本月/按模型数据，注册 `usage-cost` settings 段用于价格配置。
- **Client 面**（`lib/client.js`）：`dsh.client` manifest + `exports["./client"]`，注册状态栏胶囊；组件通过标准 `useProjection('usageCost')` 读实时值。

## 目录

```
dsh-usage-cost/
├── package.json          # dsh.bundle.patch + dsh.client manifest + exports
├── cordis.yml            # Host 行声明（insert usage-cost）
├── tsconfig.json         # Host 面类型检查
├── tsconfig.client.json  # Client 面类型检查
├── tsdown.config.ts      # 打包 lib/index.js + lib/client.js
└── src/
    ├── index.ts          # Host 插件入口
    ├── types.ts          # 纯类型 + SessionProjectionMap 声明合并
    ├── pricing.ts        # 价格表、模糊匹配、成本公式
    ├── estimator.ts      # gpt-tokenizer 封装
    ├── projection.ts     # usageCost session projection 单元
    ├── aggregates.ts     # 今日/本月/模型累计 + JSON 持久化
    └── client/
        ├── index.ts      # Client 插件入口
        ├── UsageCapsule.tsx
        └── format.ts
```

## 构建

```sh
npm install
npm run build        # tsdown 打包 + tsc 声明
npm run typecheck    # 仅类型检查
```

## 安装到 DSH Desktop / DSH

插件通过官方 `dsh plugin` 语义安装（Desktop 内等价于 `desktopPnpm.runPlugin`）：

```sh
# npm 安装（推荐，预构建）
dsh plugin --profile desktop add dsh-usage-cost
dsh plugin --profile web add dsh-usage-cost

# 或直接从 GitHub 安装
dsh plugin --profile desktop add github:lhh666-6/dsh-usage-cost
dsh plugin --profile web add github:lhh666-6/dsh-usage-cost
```

安装后重启（或切换一次 profile），发起对话时状态栏即出现用量胶囊。

## 价格配置

默认价格（人民币 / 百万 token）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|------|---------|-----------|------|
| `deepseek-chat` | ¥0.5 | ¥2 | ¥8 |
| `deepseek-reasoner` | ¥1 | ¥4 | ¥16 |

可在 `$DSH_HOME/settings.yaml` 的 `usage-cost` 段覆盖（或通过 DSH 设置页的插件配置）：

```yaml
usage-cost:
  models:
    - id: deepseek-chat
      cacheHit: 0.5
      cacheMiss: 2
      output: 8
    - id: deepseek-reasoner
      cacheHit: 1
      cacheMiss: 4
      output: 16
  chunkInterval: 50
  timeIntervalMs: 100
```

官方价格会变动，请以 DeepSeek 最新价格为准更新此表。

## 模型体验

无。本插件只观察会话事件与 provider `usage`，不注入任何模型可见指令、工具或请求字段。
