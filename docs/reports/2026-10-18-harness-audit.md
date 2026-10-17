# easy-pi Agent Harness 审查报告

- 日期：2026-10-18；基线：`f7606c3df`，分支 `my-pi`，初始工作树干净。
- 唯一开发目标：`pi/`。本轮采用实际模块边界、关键调用链和失败/取消/恢复路径审查，不宣称逐行穷尽或消除未知问题。
- 任务状态与验收权威文件：[`../tasks/2026-10-18-harness-audit-remediation-task.md`](../tasks/2026-10-18-harness-audit-remediation-task.md)。本文仅保存审查证据，不维护第二份整改状态。
- 结论：模块覆盖、重现、整改和统一验收已闭环；90条初审候选（88条模块初审加两条CLI/文档）及实施中补入的合理整改均有计划与证据。详细状态以任务计划为准，旧的初审/中间回执不是当前未完成项。
- 不将所有条目统称为安全漏洞：其中包含功能缺陷、资源边界改进及测试/文档契约修正。没有未证明的吞吐/RSS提升主张。

## 模块与关键调用链

实际源码清单含 1958 条路径（排除 `models.generated.ts` 与 lockfile；含测试、文档和脚本），识别 17 个运行时/支持 package 边界及桌面桥接工具。采用完整关键模块阅读与消费者追踪，生成物、vendor、示例和退休代码不计作当前产品能力。

| 边界 | 实际入口/关键链 | 审查任务 |
| --- | --- | --- |
| CLI / SDK / 装配 | `coding-agent/src/cli.ts → main.ts → createAgentSessionServices → createAgentSessionRuntime → sdk.createAgentSession → AgentSession`；`createBuiltInExtensions` 注册产品能力 | T-001 |
| 执行核心 | `agent/src/agent.ts → agent-loop.ts → resource-scheduler/tool-plan/run-scope`；另一公开 `AgentHarness` 路径有独立 lane/reducer/session 接口，不能误认为 CLI 已切换 | T-002 |
| 工具与进程 | coding-agent 工具包装 → agent harness tools → node process executor / background manager → 保留日志及 completion 通知 | T-002 |
| 模型 | `ModelRuntime → provider-composer/Models → api adapters → stream/event stream`；Codex SSE/WS、共享重试/取消与认证存储 | T-003 |
| 权限与发现 | `permissions → easy-pi` 工具 gate；MCP 暴露/白名单 → tool-search；codemode nested dispatch 复用 live execution gate | T-004 |
| MCP / VM / 公共网页 / 桌面桥接 | MCP HTTP/stdio transports；codemode worker/host/VM；web public network guard/browser/snapshot；`tools/agent-desktop-mcp` | T-004 |
| 上下文与主会话 | `AgentSession → SessionManager JSONL tree → branch/fork/compaction checkpoint → runtime replacement/task recovery` | T-005 |
| 原生多 agent | easy-pi native collaboration → controller/mailbox/store → child session host → 同一 SDK/AgentSession；独立历史和取消，工作目录共享 | T-005 |
| 扩展与资源 | loader → runner/wrapper → session binding；resource loader 的 project trust 分段发现 | T-006 |
| 用户交互 | print/json/rpc 与 interactive adapters；`tui` terminal/input/rendering；`grok-tui` state/action/controller；compat 仅再导出 | T-006 |
| 服务与协议 | `client → protocol framing/CBOR → server connection/session subscription → service host` | T-007 |
| 可插拔存储 | agent harness session façade → memory/JSONL；`session-backends/sqlite-node` transaction/repository 与 conformance | T-007 |
| 可观测性 / eval | telemetry contexts/sinks、错误和事件终态；evals harness/report；faux provider 与分层测试 | T-007 |
| 构建与交付 | root scripts → offline package builds → `build-easy-pi-product.mjs` native module allowlist → `pack-easy-pi.mjs` 显式 bundle → tag-gated publish | T-001 |

### 用户要求的覆盖轴

架构/模块边界（T-001/007）、agent 循环（T-002）、模型（T-003）、工具/权限（T-002/004）、上下文/持久化（T-005/007）、并发/多 agent（T-002/005）、取消/恢复（全部生命周期边界）、扩展（T-006）、性能/资源（T-002/003/004/007）、可观测性（T-005/007）、测试（各整改 + T-008）、交互（T-001/006）。完整阅读范围、关键链、静态发现和明确限制保留于六份初审快照：[`runtime`](2026-10-18-harness-audit/runtime.md)、[`model`](2026-10-18-harness-audit/model.md)、[`tools`](2026-10-18-harness-audit/tools.md)、[`session`](2026-10-18-harness-audit/session.md)、[`ui`](2026-10-18-harness-audit/ui.md)、[`infra`](2026-10-18-harness-audit/infra.md)。这些不是逐文件穷尽承诺；shared adapter 覆盖不等于每个 provider 工厂、每个 UI widget 或原生平台均已深入验证。

## 已证实的问题

### R-CLI-01：非交互跨项目会话不得进入 readline 确认

- Severity: Medium
- Axis: Correctness
- Location: `packages/coding-agent/src/main.ts:createSessionManager` 的 `case "global"`。
- Problem: `--session <id>` 只在其他项目命中时，无条件创建 readline 确认；print/json/rpc、重定向 stdin/stdout 也进入交互分支。
- Impact: 消耗自动化输入、向协议输出提示，或取消后以 0 退出却没有执行任务；EOF 不调用 question callback 时还会留下未结算流程。
- Root cause: 已有 `resolveAppMode` 模式判定未用于跨项目确认边界；session 查找不区分可交互确认与显式用户意图。
- Recommended fix: 只有 interactive 模式允许确认；其他模式返回明确失败，提示 `--fork <id>` 或 `--session <path>`；保留显式路径/fork 与原交互取消。
- Certainty: Confirmed — `test/session-global-confirm.test.ts` 在原实现上 6 fail / 3 pass，错误为预期 exit:1 实际 exit:0（实际确认路径被 mock 回答 n）；原代码没有模式 gate。日志 `/tmp/pi-harness-cli-red.log`。
- Plan: T-009。

### R-DOC-01：README 否认产品已内置的原生协作

- Severity: Low
- Axis: Readability
- Location: `packages/coding-agent/README.md` 概述与 Philosophy 的 “No sub-agents”。
- Problem: 同一文档已经展示 `/agents`，但仍沿用上游“不提供 subagents”的说明。
- Impact: 用户误判功能边界，可能重复安装或搭建冲突的协作机制。
- Root cause: 上游定位文案未随 fork 产品装配更新。
- Recommended fix: 说明本 fork 的原生子 agent 和权限/共享工作树限制，链接现有 collaboration 文档。
- Certainty: Confirmed — `src/extensions/index.ts` 注册 easy-pi，`sdk.ts` 绑定原生 session；根 README 与 collaboration 文档均描述内置协作。
- Plan: T-009。

## 全量发现索引与验证证据

以下88条模块初审加上前述2条CLI/文档发现，构成本轮90条初审候选。每条的代码位置、触发、影响、根因、改进方向与静态可信度见对应初审；实施回执提供red/green、变更文件与测量。回执是历史快照（可能记录当时尚未完成），**最终状态只看任务计划及下方统一验收结果**。独立复查发现的遗漏回流原任务，不重复虚增修复数。

### 执行核心与进程（19项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [RUNTIME-1](2026-10-18-harness-audit/runtime.md) | Background launch ignores cancellation | T-130 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-2](2026-10-18-harness-audit/runtime.md) | Concurrent durable admission | T-131 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-3](2026-10-18-harness-audit/runtime.md) | Pause loses operation ownership | T-132 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md)、[durable-storage-review](2026-10-18-harness-audit/validation-durable-storage-review.md) |
| [RUNTIME-4](2026-10-18-harness-audit/runtime.md) | Queue admission after abort/finish | T-133 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-5](2026-10-18-harness-audit/runtime.md) | Cancelled queue items are still consumed | T-134 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-6](2026-10-18-harness-audit/runtime.md) | Execution target changes after validation | T-135 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-7](2026-10-18-harness-audit/runtime.md) | Idempotent live timeout treated as settled | T-136 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md)、[durable-storage-review](2026-10-18-harness-audit/validation-durable-storage-review.md) |
| [RUNTIME-8](2026-10-18-harness-audit/runtime.md) | Provider dispatched after cancellation | T-137 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-9](2026-10-18-harness-audit/runtime.md) | Idle waiter ignores preparation | T-138 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-10](2026-10-18-harness-audit/runtime.md) | Progress counters cross user boundaries | T-139 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md)、[process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-11](2026-10-18-harness-audit/runtime.md) | Image progress discarded | T-140 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-12](2026-10-18-harness-audit/runtime.md) | Retry/checkpoint usage lost | T-141 | [durable-runtime](2026-10-18-harness-audit/validation-durable-runtime.md) |
| [RUNTIME-13](2026-10-18-harness-audit/runtime.md) | Late search spawn after abort | T-142 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-14](2026-10-18-harness-audit/runtime.md) | Missing-target aliases bypass mutation queue | T-143 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-15](2026-10-18-harness-audit/runtime.md) | Shutdown claims completion before log close | T-144 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-16](2026-10-18-harness-audit/runtime.md) | Incomplete shutdown report stays cached | T-145 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-17](2026-10-18-harness-audit/runtime.md) | Background UTF-8 chunk corruption | T-146 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-18](2026-10-18-harness-audit/runtime.md) | Promotion wins after abort/callback failure | T-147 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |
| [RUNTIME-19](2026-10-18-harness-audit/runtime.md) | Raw streams hang on producer rejection | T-148 | [process-runtime](2026-10-18-harness-audit/validation-process-runtime.md) |

### 模型、认证和传输（17项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [MODEL-1](2026-10-18-harness-audit/model.md) | Scope socket reuse by endpoint/auth | T-060 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-2](2026-10-18-harness-audit/model.md) | Remove token bodies from errors | T-061 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-3](2026-10-18-harness-audit/model.md) | Fail closed on unresolved stored key expressions | T-062 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-4](2026-10-18-harness-audit/model.md) | Honor explicit tokens for OAuth-only providers | T-063 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md)、[provider-headers](2026-10-18-harness-audit/validation-provider-headers.md) |
| [MODEL-5](2026-10-18-harness-audit/model.md) | Make lazy setup cancellation-aware | T-064 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-6](2026-10-18-harness-audit/model.md) | Do not resurrect transformed-away headers | T-065 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-7](2026-10-18-harness-audit/model.md) | Honor case-insensitive Google header deletion | T-066 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-8](2026-10-18-harness-audit/model.md) | Keep direct streamSimple failures in the protocol | T-067 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-9](2026-10-18-harness-audit/model.md) | Detach Codex's header-only deadline | T-068 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-10](2026-10-18-harness-audit/model.md) | Keep error-body reads cancellable | T-069 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-11](2026-10-18-harness-audit/model.md) | Do not retry terminal HTTP/hook errors | T-070 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-12](2026-10-18-harness-audit/model.md) | Parse SSE newline state across chunks | T-071 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-13](2026-10-18-harness-audit/model.md) | Cancel bodies on early logical exits | T-072 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-14](2026-10-18-harness-audit/model.md) | Retain pi-messages partial output on local failure | T-073 | [ai-transports](2026-10-18-harness-audit/validation-ai-transports.md) |
| [MODEL-15](2026-10-18-harness-audit/model.md) | Apply modelOverrides headers last | T-074 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-16](2026-10-18-harness-audit/model.md) | Validate Anthropic token shape before persistence | T-075 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |
| [MODEL-17](2026-10-18-harness-audit/model.md) | Link OAuth operation/manual-prompt cancellation | T-076 | [model-auth](2026-10-18-harness-audit/validation-model-auth.md) |

### 工具、MCP、VM 和网页（11项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [TOOLS-1](2026-10-18-harness-audit/tools.md) | Use Bash's effective cwd for deletion assessment | T-020 | [tool-boundaries](2026-10-18-harness-audit/validation-tool-boundaries.md)、[review-boundaries](2026-10-18-harness-audit/validation-review-boundaries.md) |
| [TOOLS-2](2026-10-18-harness-audit/tools.md) | Cancel request-owned MCP HTTP work | T-021 | [mcp](2026-10-18-harness-audit/validation-mcp.md) |
| [TOOLS-3](2026-10-18-harness-audit/tools.md) | Reject OAuth token redirects | T-022 | [mcp](2026-10-18-harness-audit/validation-mcp.md) |
| [TOOLS-4](2026-10-18-harness-audit/tools.md) | Cancel queued desktop actions before CLI startup | T-023 | [tool-boundaries](2026-10-18-harness-audit/validation-tool-boundaries.md) |
| [TOOLS-5](2026-10-18-harness-audit/tools.md) | Preserve desktop unknown effects through MCP | T-024 | [tool-boundaries](2026-10-18-harness-audit/validation-tool-boundaries.md) |
| [TOOLS-6](2026-10-18-harness-audit/tools.md) | Clean stdio descendants after leader exit | T-025 | [mcp](2026-10-18-harness-audit/validation-mcp.md)、[mcp-review](2026-10-18-harness-audit/validation-mcp-review.md) |
| [TOOLS-7](2026-10-18-harness-audit/tools.md) | Enforce HTTP MCP bounds during consumption | T-026 | [mcp](2026-10-18-harness-audit/validation-mcp.md)、[mcp-review](2026-10-18-harness-audit/validation-mcp-review.md) |
| [TOOLS-8](2026-10-18-harness-audit/tools.md) | Bind snapshots to logical session/branch identity | T-027 | [sandbox-web](2026-10-18-harness-audit/validation-sandbox-web.md) |
| [TOOLS-9](2026-10-18-harness-audit/tools.md) | Release idle expired snapshot owners | T-028 | [sandbox-web](2026-10-18-harness-audit/validation-sandbox-web.md) |
| [TOOLS-10](2026-10-18-harness-audit/tools.md) | Bound codemode deletion payloads | T-029 | [sandbox-web](2026-10-18-harness-audit/validation-sandbox-web.md) |
| [TOOLS-11](2026-10-18-harness-audit/tools.md) | Bound codemode host call history | T-030 | [sandbox-web](2026-10-18-harness-audit/validation-sandbox-web.md) |

### 会话、压缩与原生协作（10项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [SESSION-1](2026-10-18-harness-audit/session.md) | Cold child loading can execute an old task | T-080 | [host-admission](2026-10-18-harness-audit/validation-host-admission.md) |
| [SESSION-2](2026-10-18-harness-audit/session.md) | Fork-before-user resumes the prompt intended for editing | T-081 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |
| [SESSION-3](2026-10-18-harness-audit/session.md) | Import overwrites colliding history before validation | T-082 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |
| [SESSION-4](2026-10-18-harness-audit/session.md) | Native task locks break budgeted parallel admission | T-083 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |
| [SESSION-5](2026-10-18-harness-audit/session.md) | abort() leaves automatic compaction running | T-084 | [session-execution](2026-10-18-harness-audit/validation-session-execution.md) |
| [SESSION-6](2026-10-18-harness-audit/session.md) | Compaction skips cancellation hooks for short/checkpoint history | T-085 | [session-execution](2026-10-18-harness-audit/validation-session-execution.md)、[compaction-contract](2026-10-18-harness-audit/validation-compaction-contract.md)、[compaction-tests](2026-10-18-harness-audit/validation-compaction-tests.md) |
| [SESSION-7](2026-10-18-harness-audit/session.md) | Modern compaction usage disappears from session totals | T-086 | [session-execution](2026-10-18-harness-audit/validation-session-execution.md)、[compaction-accounting](2026-10-18-harness-audit/validation-compaction-accounting.md) |
| [SESSION-8](2026-10-18-harness-audit/session.md) | forkFrom stamps v3 onto unmigrated entries | T-087 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |
| [SESSION-9](2026-10-18-harness-audit/session.md) | Cyclic parent links hang context construction | T-088 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |
| [SESSION-10](2026-10-18-harness-audit/session.md) | Resume bypasses model-bound cache validation | T-089 | [session-history](2026-10-18-harness-audit/validation-session-history.md) |

### 扩展与交互（15项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [UI-1](2026-10-18-harness-audit/ui.md) | Escape terminal titles | T-040 | [ui-render](2026-10-18-harness-audit/validation-ui-render.md) |
| [UI-2](2026-10-18-harness-audit/ui.md) | Sanitize untrusted transcript text | T-041 | [ui-render](2026-10-18-harness-audit/validation-ui-render.md)、[review-boundaries](2026-10-18-harness-audit/validation-review-boundaries.md)、[tool-name](2026-10-18-harness-audit/validation-tool-name.md) |
| [UI-3](2026-10-18-harness-audit/ui.md) | Roll back failed factory registrations | T-042 | [ui-render](2026-10-18-harness-audit/validation-ui-render.md)、[review-boundaries](2026-10-18-harness-audit/validation-review-boundaries.md) |
| [UI-4](2026-10-18-harness-audit/ui.md) | Catch synchronous shortcut exceptions | T-043 | [ui-interactive](2026-10-18-harness-audit/validation-ui-interactive.md) |
| [UI-5](2026-10-18-harness-audit/ui.md) | Settle displaced extension dialogs | T-044 | [ui-interactive](2026-10-18-harness-audit/validation-ui-interactive.md)、[modes-review](2026-10-18-harness-audit/validation-modes-review.md) |
| [UI-6](2026-10-18-harness-audit/ui.md) | Retain custom-overlay ownership | T-045 | [ui-interactive](2026-10-18-harness-audit/validation-ui-interactive.md) |
| [UI-7](2026-10-18-harness-audit/ui.md) | Ignore stale clipboard completion | T-046 | [ui-interactive](2026-10-18-harness-audit/validation-ui-interactive.md) |
| [UI-8](2026-10-18-harness-audit/ui.md) | Cache converted images by identity | T-047 | [ui-render](2026-10-18-harness-audit/validation-ui-render.md) |
| [UI-9](2026-10-18-harness-audit/ui.md) | Install RPC plumbing before startup hooks | T-048 | [rpc](2026-10-18-harness-audit/validation-rpc.md) |
| [UI-10](2026-10-18-harness-audit/ui.md) | Remove duplicate RPC replacement binding | T-049 | [rpc](2026-10-18-harness-audit/validation-rpc.md) |
| [UI-11](2026-10-18-harness-audit/ui.md) | Validate RPC envelopes | T-050 | [rpc](2026-10-18-harness-audit/validation-rpc.md) |
| [UI-12](2026-10-18-harness-audit/ui.md) | Respect deferred RPC shutdown | T-051 | [rpc](2026-10-18-harness-audit/validation-rpc.md)、[modes-review](2026-10-18-harness-audit/validation-modes-review.md) |
| [UI-13](2026-10-18-harness-audit/ui.md) | Reject errors in void RpcClient methods | T-052 | [rpc](2026-10-18-harness-audit/validation-rpc.md) |
| [UI-14](2026-10-18-harness-audit/ui.md) | Route shortcut shutdown through the bound handler | T-053 | [ui-interactive](2026-10-18-harness-audit/validation-ui-interactive.md) |
| [UI-15](2026-10-18-harness-audit/ui.md) | Fix stale bash-renderer assertions | T-054 | [ui-render](2026-10-18-harness-audit/validation-ui-render.md) |

### 协议、服务、存储和可观测性（16项）

| 初审条目 | 问题 | 计划 | 实施/验证回执 |
| --- | --- | --- | --- |
| [INFRA-1](2026-10-18-harness-audit/infra.md) | Retain ownership after failed disposal | T-100 | [service](2026-10-18-harness-audit/validation-service.md)、[server-close](2026-10-18-harness-audit/validation-server-close.md) |
| [INFRA-2](2026-10-18-harness-audit/infra.md) | Restore persisted cwd | T-011 | [service-initial](2026-10-18-harness-audit/validation-service-initial.md) |
| [INFRA-3](2026-10-18-harness-audit/infra.md) | Unsubscribe snapshot-only watchers | T-010 | [service-initial](2026-10-18-harness-audit/validation-service-initial.md) |
| [INFRA-4](2026-10-18-harness-audit/infra.md) | Recheck connection generation per decoded frame | T-103 | [service](2026-10-18-harness-audit/validation-service.md) |
| [INFRA-5](2026-10-18-harness-audit/infra.md) | Validate response session identity | T-104 | [service](2026-10-18-harness-audit/validation-service.md) |
| [INFRA-6](2026-10-18-harness-audit/infra.md) | Drain admitted Unix writes on graceful close | T-105 | [service](2026-10-18-harness-audit/validation-service.md) |
| [INFRA-7](2026-10-18-harness-audit/infra.md) | Preserve reserved JSON keys in adapters | T-106 | [service](2026-10-18-harness-audit/validation-service.md) |
| [INFRA-8](2026-10-18-harness-audit/infra.md) | Capture durable inputs before asynchronous queues | T-107 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-9](2026-10-18-harness-audit/infra.md) | Evict released JSONL storages | T-108 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-10](2026-10-18-harness-audit/infra.md) | Reject newline-terminated corruption | T-109 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-11](2026-10-18-harness-audit/infra.md) | Validate durable decoded payloads | T-110 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-12](2026-10-18-harness-audit/infra.md) | Snapshot SQLite fork source transactionally | T-111 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-13](2026-10-18-harness-audit/infra.md) | Recheck migrations under the write transaction | T-112 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-14](2026-10-18-harness-audit/infra.md) | Seal SQLite repository admission on close | T-113 | [storage](2026-10-18-harness-audit/validation-storage.md)、[durable-storage-review](2026-10-18-harness-audit/validation-durable-storage-review.md) |
| [INFRA-15](2026-10-18-harness-audit/infra.md) | Roll back lease on metadata decode failure | T-114 | [storage](2026-10-18-harness-audit/validation-storage.md) |
| [INFRA-16](2026-10-18-harness-audit/infra.md) | Preserve reserved telemetry attribute names | T-115 | [service](2026-10-18-harness-audit/validation-service.md) |

### 实施中补入与验收支撑

- T-150/151：重试 sleep listener 与顶层服务 failed-close 的资源收尾。
- T-152/153：delivery 后恢复续跑、device-code 诊断脱敏。
- T-154/155/156：未激活 compaction 的已知使用量、过期真实模型测试迁移、冷 child 新任务隔离旧恢复队列。
- T-160/161/162/163/164：文档与工具描述、全仓类型契约、CLI auth-check 状态兼容、编译 smoke/CI gate、完整套件发现的两个验收失败。
- 具体位置、收益、风险、依赖、接受条件和当前证据均在相应任务条目；不因优先级低省略。

### 独立复查闭环

六次新建、工具权限实际限制为read的独立复查覆盖安全/UI、MCP/VM/网页、交互模式、模型、durable/storage、会话链。其意见不是测试通过证明；每个可行动缺口均追加或回流重现/修复：

- [边界/UI](2026-10-18-harness-audit/review-boundary-ui.md)：物理 cwd、Grok 原始入口、失败工厂延迟回调；另补齐工具名显示。
- [MCP/sandbox](2026-10-18-harness-audit/review-mcp-sandbox.md)：stdio drain 与组退出分离、已知 HTTP 状态不能被诊断读取错误掩盖。
- [模式](2026-10-18-harness-audit/review-modes.md)：独立 compaction 结束触发 deferred shutdown、被取代的 tree workflow 不能重新抢占 UI。
- [模型](2026-10-18-harness-audit/review-model.md)：OAuth-only 显式 token 保留 provider headers。
- [durable/storage](2026-10-18-harness-audit/review-durable-storage.md)：未落盘 reconciliation 仍须阻止 live invocation replay、pause-vs-finish、SQLite failed close 可重试。
- [会话](2026-10-18-harness-audit/review-session-final.md)：post-commit hook 期间取消不得继续推理；startup signal 不能成为以后回合的永久取消信号。

## 改进机会、待验证假设与排除依据

- 不把 `Agent` 与 `AgentHarness` 的共存直接判为缺陷：它们有不同的公开入口与宿主契约。合并需要行为等价证据，当前没有收益测量；本轮优先修复各自真实生命周期问题。
- 旧 subagent DAG/worktree 源文件仍在树内，但 product build 的 `nativeModules` 白名单与 package exports 将它们排除；未因“看起来没用”删除有意保留的代码。
- Full Access、可信 JS extension 可运行任意宿主代码是明确契约，不伪称工具白名单或 VM 是 OS sandbox。
- 不为“全面优化”机械拆分大文件、改名或重排模块；没有可证实收益的重构不纳入。
- 真实 provider、跨平台原生终端、外部 MCP/桌面服务均不在离线单机验证的证明能力内；不使用真实凭据/付费 API，不把 mock 通过等同现场验证。

## 已实施的重点改动

- 执行生命周期：接纳/暂停/恢复/队列/取消与终态提交串行；实际未停止的副作用不能因幂等声明或持久化失败被重放/释放；后台进程和日志 writer 一并结算。
- 模型边界：OAuth/配置键 fail-closed、诊断脱敏、显式 token 与配置 headers 正确组合、setup/stream/body 取消、Codex socket 身份与重试/SSE/partial-output 修复。
- 工具边界：Bash按真实调用cwd评估并保留保护根；MCP请求级取消、受限诊断体、进程组/stdio drain分离；桌面未知效果传入恢复/codemode，不能靠catch提交状态。
- 会话/协作：fork历史不等于新执行授权；child加载与新assignment隔离旧恢复队列；创建信号不污染后续回合；导入不覆盖已有历史；compaction取消/观察钩子/完整Usage正确收尾。
- 扩展/UI/协议：失败工厂API撤销；显示层净化但不改变派发身份；对话框/overlay/clipboard归属；RPC初始化、错误、退出与订阅；连接generation、session correlation及保留JSON键。
- 存储/可观测性：同步detach写入输入、损坏数据拒绝、JSONL registry释放、SQLite一致性/迁移/租约/可重试关闭、使用量和遥测键保留。
- 测试/交付：新增确定性并发/faux/字节级回归，校正陈旧fixture；更新20份契约文档及README/工具描述；CI加入编译产物和私有包原生协作/权限验收。未更改依赖或锁文件，未发布/推送。

## 可复现资源与行为对比

这些是相同受控输入的计数/字节结果，不是吞吐、RSS或真实模型价格承诺。各回执列出命令和对应测试。

| 场景 | 修复前 | 修复后 | 证据 |
| --- | --- | --- | --- |
| 100次服务snapshot（正常/错误、创建/重开） | 100个未释放watch | 每次后0 | validation-service-initial |
| MCP JSON（256-byte配置预算） | 4,132 bytes /65 pulls | 320 /5（含1个溢出chunk） | validation-mcp |
| MCP错误体 | 131,072 bytes /128 pulls | 8,192 /8，剩余body取消 | validation-mcp |
| 空闲snapshot过期 | 1条/289 bytes保留 | 0/0；owner可被GC | validation-sandbox-web |
| codemode cheap calls，deadline=Infinity | 2,048次派发/保留 | 1,024上限；超限不再派发且不提交store | validation-sandbox-web |
| codemode tombstone/escaped-key写集 | 1,048,610–1,574,320 bytes通过 | 超预算拒绝，0个提交 | validation-sandbox-web |
| Codex八次退避后的多余abort listener | 8 | 0；48种受控时序保持清理 | validation-codex-sleep |
| live timed-out幂等mutation + failed reconciliation write | 2次并发且可提前release | peak=1；活跃时release=0 | validation-durable-storage-review |
| SQLite failed close | 仍有timer/lease，无法重试 | 立即停timer；重试清完lease并关闭一次 | validation-durable-storage-review |
| Grok未可信工具名OSC52 | collapsed 1/1、expanded 2/3 | 两模式0/0，raw派发身份未变 | validation-tool-name |
| native watcher fixture即时写入 | 8/30未观测到directory event | 独立ready probe后30/30通过 | validation-validation-tail |

最后一项修正的是测试就绪前提；未声称定位或修复底层OS事件丢失。

## 基线与验证记录

- `./test.sh`（空环境、临时 HOME、无真实 API key）基线 exit 1：coding-agent 8 files / 13 tests failed，其余执行到的 package 通过。
- 13项基线失败均已处理：5项CLI因陈旧materialized dist，重建消除；5项路径fixture规范化到实际canonical临时目录而保留精确断言；2项Bash日志标签断言与现行截断契约对齐；1项managed-fd stream.path假设改为检查实际日志路径。
- 原始基线日志：`/tmp/pi-harness-baseline-tests.log`。`npm run build:offline` exit 0 后，6 个 CLI/session 文件 19/19 通过（含原先5个旧 dist 失败），证明该组为陈旧本地产物而非需要源代码补丁。
- 服务修复 T-010/T-011：root 独立检查 diff 并重跑 `test/harness-service.test.ts test/server/create-harness.test.ts`，27/27 通过；原实现3失败。100次快照后未释放 watch 从100降为0（正常及转换失败路径），两工作目录重开后实际相对 read 读取各自 marker。计数对比不是堆大小或延迟估算。

### 最终统一验收

- `npm run check`：通过，1608文件，无formatter改写；包含pinned deps、imports、shrinkwrap/install-lock、全仓tsc和browser smoke。日志 `/tmp/pi-harness-check-final.log`。
- `npm run build:offline`：通过；本仓库全部构建链和私有产品bundle已重建。日志 `/tmp/pi-harness-build-verified.log`。
- `./test.sh`：**通过**，空环境/临时HOME下的完整默认工作区测试；日志 `/tmp/pi-harness-tests-verified.log`。首轮最终验证曾有2失败，已按T-164纠正并重跑；不删除或跳过失败用例。
- 主要Vitest结果：agent 801通过/1跳过；ai 1518/862；coding-agent 4073/74（380文件通过、16文件跳过）；client44、codemode197、evals23、MCP86、protocol153、server72、telemetry17、SQLite111均通过。跳过的真实provider/环境用例不计通过。
- node:test：脚本89通过/1跳过、web148通过、compat1通过；TUI/Grok-TUI的dot-reporter包脚本均exit0，不伪造未打印的精确总数。
- 默认workspace脚本未包括的定向验收：原生协作9文件233通过；权限15+3通过；desktop bridge10通过（stub执行，无真实桌面效果）。原生协作/权限已加CI步骤；desktop保留独立依赖/测试入口。
- 编译产物 `scripts/check-native-subagent-product.mjs`：合成provider下native spawn、catalog、退休导出、CLI help/version、两份npm-pack inventory全部通过，且以空环境/独立HOME再次验证。日志 `/tmp/pi-harness-compiled-isolated-final.log`。未做实际发布。
- 编译smoke的初次失败是旧验收脚本仍期待退休acceptance字段和旧spawn envelope，已修正；严格隔离wrapper另一次失败来自npm禁止user/global共用同一/dev/null配置，改为两个独立空文件后通过。合并命令的该次exit1不掩盖已通过的check/build/test阶段，也不冒充一次全链exit0。
- 最终CI YAML/新增gate结构/shell语法、`git diff --check`、任务文档validator均通过；核对206个本地链接、34个报告证据引用、31个计划报告引用；包文档的相对链接/示例JSON验证见文档回执。执行型回执与静态独立复查分开记录，远端CI未运行。
- 代码/测试/包文档/CI的203个显式路径已提交为`bf3ab709bbc759f7134c5655997b11a154c448b1`（`fix(agent): harden harness lifecycle and execution boundaries`）；审查/计划/学习记录独立归档。最终内容hash核对无源代码/测试漂移。
- 当前clone未安装Git hook入口，普通commit没有自动执行`.husky/pre-commit`；随后显式运行原脚本通过，包括lockfile guard及完整`npm run check`，1608文件无formatter改写，完整输出`/tmp/pi-harness-manual-hook.log`已检查。没有使用`--no-verify`或修改hook配置。

## Validation gaps and residual risks

- 未调用真实provider评测；未验证真实OAuth服务、真实桌面/剪贴板效果、Linux/Windows/Bun/Cloudflare全部运行组合。网络测试使用mock或私有loopback；字节/资源计数不等同于物理终态或真实服务兼容性。
- FS watcher首次全套超时的底层OS原因未唯一证明。受控事件测试和保留的native integration已稳定并通过最终全套；生产watcher没有改动，不把测试就绪修正称作OS修复。
- 旧fork记录无provenance的历史不反向猜测；旧activated checkpoint缺少usage不回填；缺失diagnostics不估算消费。已知数据不足须保留，而不是编造状态/费用。
- API/行为风险已在计划列明：短历史compaction hook的legacy preparation可为undefined；codemode新增1024次host-call与完整serialized-write预算（1,048,576个JavaScript字符串长度单位，不是UTF-8字节上限）；损坏历史更严格拒绝；显式未解析凭据不回退ambient；非交互跨项目ID要求明确fork/路径。
- Full Access/工具过滤/VM都不是OS sandbox；可信扩展可以忽略取消，已派发外部效果不会回滚；进程组证明不涵盖setsid逃逸及所有PID重用时序。
- 生成物、vendor、退休DAG、每个widget/每个非共享provider工厂未逐行穷尽；六份初审明确各自阅读范围。Bedrock/Azure/Vertex等非共享adapter、真实平台与供应商兼容性不因共享层测试而被宣称通过。
- 架构重写、未测量的整文件读取优化/调度公平性、未建立契约的eval-score持久化等未纳入：没有本轮经验证的收益或产品要求，不能用偏好扩大范围。具体机会/假设见各初审排除段落。
- 本轮只修改并重建本仓库，未安装/部署/发布。已经运行的easy-pi实例不会热替换已加载代码，使用新构建需要重启。
