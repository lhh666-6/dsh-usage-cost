# dsh-usage-cost — 交接文档（Handoff）

> 给下一个对话的 agent：先读本文档，再动代码。源码目录就是本文件所在目录。

## 这是什么

一个 DSH 插件：实时显示 DeepSeek 对话的 token 用量与成本。
- 状态栏胶囊（模型名 · 入/出 token · 成本，流式期间带 `~` 估算标记，数字实时滚动）
- 点击展开详情面板（输入/输出/缓存命中/缓存未命中/总 token/本次成本/耗时/tokens/s/今日/本月累计/数据状态）
- 流式估算 + 请求结束用服务端 `usage` 权威校准
- 成本公式：`cache_hit/1e6*cacheHit + cache_miss/1e6*cacheMiss + completion/1e6*output`（人民币/百万 token）
- 价格表可配置、模型名模糊匹配（`deepseek-chat-2025-xxx` → `deepseek-chat`），缺价格显示「未配置价格」
- 今日/本月/按模型累计，本地持久化到 `$DSH_HOME/usage-cost/aggregates.json`

## 目录结构

```
dsh-usage-cost/
├── package.json            # dsh.bundle.patch + dsh.client manifest + exports["./client"]
├── cordis.yml              # Host 行声明（顶层数组：- insert: [ {id: usage-cost, name: dsh-usage-cost} ]）
├── tsconfig.json           # Host 面类型检查
├── tsconfig.client.json    # Client 面类型检查
├── tsdown.config.ts        # 打包 lib/index.js（ESM）+ lib/client.js（CJS+__ModuleLoader__ 包裹）
├── lib/                    # 构建产物（index.js / client.js）
└── src/
    ├── index.ts            # Host 插件入口：注册投影 + 累计 + settings 段
    ├── types.ts            # 纯类型 + SessionProjectionMap 声明合并（usageCost key）
    ├── pricing.ts          # 价格表、模糊匹配、成本公式、默认配置
    ├── estimator.ts        # gpt-tokenizer 封装
    ├── projection.ts       # usageCost session 投影单元（核心 fold）
    ├── aggregates.ts       # 今日/本月/模型累计 + JSON 持久化 + 幂等 watermark
    └── client/
        ├── index.ts        # Client 入口：注册胶囊到 conversation.session.header.utilities
        ├── UsageCapsule.tsx# 胶囊 + 详情面板（内联样式，无 CSS module）
        └── format.ts       # token/成本/耗时格式化
```

## 关键技术点（改代码前必读）

1. **插件是 DSH 的 Cordis 插件**，双面：Host 半面（`src/index.ts` 导出 `name`/`inject`/`Config`/`apply`，无 default export）+ Client 半面（`src/client/index.ts`）。
2. **实时数据走 session projection seam**：Host 注册 `usageCost` 投影（`projection.ts`），框架自动做实时推送、落盘（projection-cache）、重放；客户端用 `useProjection('usageCost')` 读。**不要自己起轮询/WebSocket**。
3. **usage 字段映射**（`llm-deepseek/translate.ts`）：`prompt_tokens` 已含缓存命中；映射后 `inputTokens = prompt_tokens - cache_hit`（= 缓存未命中）、`cacheReadTokens = prompt_cache_hit_tokens`、`outputTokens = completion_tokens`。成本里 cacheMiss 用 `inputTokens`，cacheHit 用 `cacheReadTokens`。
4. **投影 fold 是纯函数**：`apply(state, event)` 必须返回同一引用表示"不感兴趣"；`view(state)` 输出纯 JSON。成本在 `view` 里用闭包捕获的 `resolveCost` 现算（定价不进 fold state，保证重放纯）。
5. **节流**：`projection.ts` 里 `chunkInterval`(50) / `timeIntervalMs`(100) 控制输出 token 全量重算频率；每 chunk 只做增量 `countTokens(delta)`。
6. **累计幂等**：`aggregates.ts` 用 `watermark[sessionId] = seq` 防止重放/重启重复累加；只监听 `session/event` 的 `assistant/message`（带 usage 的权威值）。

## 构建与验证

```powershell
cd D:\Claude_Design\deepseek-harness-desktop\dsh-usage-cost
npm install          # 首次或改依赖后
npm run build        # tsdown 打包 → lib/index.js + lib/client.js
npm run typecheck    # tsc 两个 face
```

**验证过的状态**：`typecheck` 和 `build` 都通过；在 rc.5 的 `web` profile 里能正常加载、客户端 bundle 能下发。

## 部署/生效（三处）

| 位置 | 是什么 | 生效方式 |
|---|---|---|
| 本目录 | 唯一源码 | 改这里 |
| `C:\Users\lenovo\.dsh\profiles\web\node_modules\dsh-usage-cost` | 老 DeepSeek Harness 的 `link:` 链接（指回本目录） | `npm run build` 后**重启 DeepSeek Harness** |
| `C:\Users\lenovo\AppData\Local\Programs\DSH Desktop\resources\app.asar.unpacked\node_modules\dsh-usage-cost` | 新 DSH Desktop 2.0 exe 里的打包副本 | 需要重新 `yarn dist:win` 才会更新 |

## 环境背景（重要，容易踩坑）

- 本机 `$DSH_HOME = C:\Users\lenovo\.dsh`，profiles 有 `web` / `headless`（**没有 desktop**）。
- 老的 **DeepSeek Harness**（0.1.0-rc.5，进程名 `DeepSeek Harness.exe`）用的是 `web` profile，插件已装进它（`dsh.profile.bundles` 里有 `dsh-usage-cost`）。
- 新的 **DSH Desktop 2.0**（`DSH Desktop.exe`）用的是 `desktop` profile，插件已内置进安装包（改的是 `dsh-plugin-desktop/src/profile.ts` 的 `REQUIRED_BUNDLES` + `package.json` 依赖）。
- **两者不能同时开**：DSH Desktop 2.0 会因单实例锁与 DeepSeek Harness 冲突而秒退（exit 0，无报错）。
- 老的 DeepSeek Harness 是 rc.5，新桌面是 rc.6；插件 peerDependencies 用 `*` 兼容两边。
- 国内网络下 electron-builder 要从 GitHub 下 electron/NSIS 会超时，需设镜像：
  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  ```

## 已完成的仓库改动（桌面 2.0 内置插件相关）

在 `D:\Claude_Design\deepseek-harness-desktop`：
- `dsh-plugin-desktop/src/profile.ts`：`REQUIRED_BUNDLES` 追加了 `dsh-usage-cost`
- `dsh-plugin-desktop/package.json`：dependencies 加了 `"dsh-usage-cost": "file:../dsh-usage-cost"`
- `yarn.lock`：已更新
- `dsh-usage-cost/`：插件本体（新增）

## 已知待办 / 风险

- 胶囊/详情面板的 UI 是在 rc.5 源码契约上写的，rc.6 客户端槽位 `conversation.session.header.utilities` 若命名有细微差异需微调（当前 typecheck 通过）。
- 价格表默认值（deepseek-chat 0.5/2/8，deepseek-reasoner 1/4/16）会随官方调价过期，用户可在 `$DSH_HOME/settings.yaml` 的 `usage-cost` 段覆盖。
- 可选增强未做：预算阈值告警、CSV 导出、历史会话成本排行。
