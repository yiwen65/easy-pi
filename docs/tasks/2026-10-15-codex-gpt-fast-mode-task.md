# Task Plan: Codex GPT Fast 模式原生支持

- Created: 2026-10-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户于 2026-10-15 明确要求“开始实施，完成交付”，授权本计划内的实现、离线验证和本地提交；未授权真实模型调用或发布。

<!-- task-doc-section:background-goal -->
## Background and goal

为 easy-pi 的 `openai-codex` GPT 模型增加原生 Fast 模式：用户可以选择服务档位，而不改变模型 ID、reasoning effort、消息内容或工具权限。

目前底层 Codex `stream()` 已接受 `serviceTier`，但会话使用的 `streamSimple()` 不透传该选项，也没有配置、会话状态和交互开关。目标是补通这条链路，并明确区分“请求 Fast”和“上游回报的实际档位”。

选择持久计划的原因：请求选项、模型能力、分支会话状态、compaction 与 UI 存在前后依赖；实际档位和既有费用兼容逻辑不能混为一谈，需要记录决策和验证门槛。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### 范围

- 仅对 `provider === "openai-codex"` 且 `api === "openai-codex-responses"` 的目标模型启用产品级 Fast 功能。
- 类型化选项经 SDK/会话传到 Codex `streamSimple()` 和 `stream()`，覆盖 SSE、WebSocket、缓存续传及其回退。
- 全局默认偏好、会话覆盖、分支恢复、`/fast` 命令、`/settings` 和全屏/常规 TUI 的状态显示。
- 模型级 Fast 能力描述；目录生成与用户 model override 的必要接线。
- 本会话 compaction/branch summary 的档位规则；原生 child session 的配置隔离测试。
- 保存请求档位与上游报告档位，保留两者差异；费用只能作为有明确依据或标识的估算。
- mock 单元/集成验证及文档更新。

### 非目标

- 不扩展到 `openai`、Azure、OpenRouter 或其他兼容服务的产品开关。
- 不支持 Flex、Ultrafast，不新增 `*-fast` 伪模型，不用降低 effort 代替 Fast。
- 不读取/改写 Codex 的 `config.toml`，不安装第三方 Fast 扩展。
- 不新增账户资格探测网络调用、官方 Codex 模型目录发现系统、自动提额或购买额度。
- 不新增子 agent 专属档位设置或修改 `spawn_agent` 工具参数。
- 不将 CLI `--fast`、专用 RPC 命令或完整跨端状态协议扩展列为首版交付；SDK 可设置会话偏好，非交互运行可读取配置。
- 不做无关重构、依赖升级或参考仓库修改，不运行 build、全量测试或真实付费 API。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

路径均相对于本工作区；行号是分析时定位信息，执行前须重新核对。

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 底层 Codex 选项已有 `serviceTier`，请求构建会写入 `service_tier`。 | `packages/ai/src/api/openai-codex-responses.ts:72-79,581-583`。 |
| F-002 | Codex 的 `streamSimple()` 从 `buildBaseOptions()` 构造选项；这两处均未透传 `serviceTier`，`SimpleStreamOptions` 也未声明该字段。 | 同文件 `:507-528`；`packages/ai/src/api/simple-options.ts`；`packages/ai/src/types.ts:319`。 |
| F-003 | SDK 主调用使用 `modelRuntime.streamSimple()`；已有配置注入与 payload hook。 | `packages/coding-agent/src/core/sdk.ts:355-389`；`test/sdk-stream-options.test.ts`。 |
| F-004 | Codex 在 SSE/WebSocket 分流前构造同一个请求体；缓存续传会比较除 input 外的请求字段。 | `packages/ai/src/api/openai-codex-responses.ts:275-307,1410-1460,1510-1540`。 |
| F-005 | 现有 Codex 费用兼容逻辑把部分 `response.service_tier=default` 解析成请求档位，且倍率分支只识别 `priority`、`flex`。此行为有测试保护。 | 同文件 `:609-646`；`packages/ai/test/openai-codex-stream.test.ts:1109-1206`。 |
| F-006 | 共享响应处理消费 `service_tier` 用于计价，但 `AssistantMessage` 未保留请求/实际档位。 | `packages/ai/src/api/openai-responses-shared.ts:615-646`；`packages/ai/src/types.ts:434`。 |
| F-007 | 原生会话已有 thinking/model 的分支事件与恢复机制；`/fast` 尚未内置。 | `packages/coding-agent/src/core/session-manager.ts:68-77,382-396,1360-1380`；`src/core/slash-commands.ts`。 |
| F-008 | 全屏模型/effort 标签在 editor frame，不在统计栏；常规 TUI 使用独立 footer。 | `packages/coding-agent/src/modes/interactive-grok/components/grok-editor-frame.ts`、`grok-stats-bar.ts`；`src/modes/interactive/components/footer.ts`。 |
| F-009 | compaction 有独立请求选项构造；不能假定主 agent 的字段自然传播。 | `src/core/compaction/subsystem/session-integration.ts:createPiAiCompleteFn`；`src/core/agent-session.ts:3394`；`test/compaction-codex-options.test.ts`。以上均在 `packages/coding-agent/` 下。 |
| F-010 | 当前模型目录没有服务档位能力描述；生成器维护 Codex 模型，禁止直接修改生成模型源文件。 | `packages/ai/src/types.ts:870`；`src/providers/data/openai-codex.json`；`scripts/generate-models.ts:2515`；根 `AGENTS.md`。 |
| F-011 | 原生 collaboration 通过 child session host 建立会话，root 把 settings 快照交给 host；不是仅通过旧 process runner 启动。 | `packages/coding-agent/src/extensions/pi-collaboration-root.ts`、`pi-collaboration-tools.ts`、`pi-child-session-host.ts`。 |
| F-012 | 本地 OpenAI SDK 的 Responses 请求类型已包含 `fast` 和 `priority`，无需为该字段升级依赖。 | `node_modules/openai/src/resources/responses/responses.ts:8765`；`packages/ai/package.json` 的 `openai: 7.2.0`。 |
| F-013 | 官方 Codex 将用户级 Fast 转成请求值 `priority`；公开 API 接受 `fast`/`priority`，并可能回报 `default`。Fast 独立于 effort。 | https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs 中 `ServiceTier::request_value()`；https://developers.openai.com/api/docs/guides/fast-mode；https://developers.openai.com/codex/speed 。 |
| F-014 | 初始工作区干净；代码变更后要求根 `npm run check`，该命令包含自动格式化。禁止未获授权的真实模型调用。 | 2026-10-15 `git status --short` 无输出；根 `AGENTS.md`、`package.json`。 |

外部证据限度：2026-10-15 已读取两篇官方文档，扫描因 `shadow_dom` 标记 incomplete；Codex 原始协议文件扫描完成。没有用搜索摘要代替协议源码，也没有验证当前账户资格或实际加速效果。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

### 首版实施合同（T-001 已固化）

1. 配置采用 `codexServiceTier?: "default" | "fast"`，会话 API 使用同一用户级语义；Codex 请求层把 `fast` 映射为 `priority`。未设置保持旧行为；显式 `default` 发出 `service_tier: "default"`。不用一个 boolean 混淆“未设置”和“关闭”。
2. 优先级为：显式单次 SDK 请求覆盖 > 当前分支会话覆盖 > 已信任的项目/全局默认配置 > 未指定。`/fast on|off` 只改当前会话；`/settings` 明确保存默认值，同时更新当前会话。默认配置提供“未指定”选项。
3. `/fast` 无参数切换当前有效偏好；`/fast status` 只读显示来源、请求偏好、模型能力与最近的上游报告。正在处理的请求不变，切换从下一次模型请求生效。
4. 会话偏好按分支持久化；resume、tree、fork、clone 恢复分支可见值。旧会话没有此事件时仍采用既有默认行为。
5. Fast 能力采用最小模型元数据，例如 `compat.supportsFastMode?: boolean`，而非扩展通用多档位系统。只为有官方依据的模型标记 true；未知/不支持模型禁止交互开启 Fast，默认配置不盲发加速字段，提供可解释的 unavailable 状态。手动单次请求不悄悄改成 Standard，应返回明确的能力校验结果。
6. 切换到不支持 Fast 的模型时保留偏好但停用其效果，不改 effort；切回支持模型时恢复。能力是模型级声明，不代表账户实际获准。
7. 同会话 compaction/branch summary 在支持的 Codex 模型上沿用该会话档位，并在文档披露额外消耗；独立 summarization 未显式设置时不新增 Fast 默认。
8. 子 agent 不自动继承父会话的 `/fast` 运行时覆盖；使用其创建时取得的项目/全局默认配置，并按自身模型能力解析。父会话后续切换不改已存在子会话，不新增子 agent 专属控制面。
9. UI 区分“Fast requested”“upstream reported Standard”“upstream tier unknown”。费用兼容解析不得反向覆盖上游原始档位；不把订阅配额倍率等同于 API 账单。
10. 不因 Fast 不可用而静默重发 Standard；错误保留给用户，避免未知结果下重复消费。

### 假设与待核实项

- Assumption A-001：上游 `default` 在 Codex 上既可能是历史回显行为，也可能是真实降级。影响实际档位与计价；T-001 保留既有兼容估算的证据，不能仅凭 API 文档删除 Codex 特例。
- Assumption A-002：模型级能力足以支持首版可用性提示。账户资格由上游最终决定，不承诺加速；不为验证资格读取凭据或发起付费请求。
- Open question Q-001：哪些当前模型可确定支持 Fast，以及各自费率依据。T-001 以官方模型/价格资料锁定初始集合；无依据的模型保持 unknown，费率不新增猜测常数。不阻塞文档编制，阻塞相应模型的能力/精确费用声明。
- Open question Q-002：A-001 的兼容计价是否有足够证据更新。T-001 先查本仓库既有测试/历史和公开上游资料；证据不足时保留估算兼容并明确标记，而非扩大为无依据的修复。
- 授权边界：用户已要求按本计划实施；不调用真实模型 API。初始自动标记能力的模型仅为 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-5.6-sol`（Speed 明确支持前两者，API Fast 文档明确 Sol；Codex Speed 同时说明 GPT-5.6 加速）。其他型号保持 unknown，可显式 model override，不根据 gpt 前缀放行。
- T-001 决议：保留既有 Codex default 回显计价兼容规则，增加 fast 别名；其结果只作兼容估算，原始 reported tier 不变。当前证据不足以把该规则改称准确账单或删除现有测试。所有 Fast 费用在产品提示中注明 estimate/额外用量，不新增模型专属费率常数。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-01：未配置且未切换 Fast 的会话，其请求不新增 `service_tier`；其他 provider 请求不受本功能影响。
- AC-02：受支持 Codex 模型开启 Fast 后，通过常用 SDK/会话路径发出 `priority`；显式关闭发出 `default`；三种状态不混淆。
- AC-03：模型 ID、reasoning effort、工具声明、权限、消息、cache key 和 affinity 不因 Fast 设置被意外改变。
- AC-04：SSE、WebSocket、websocket-cached、自动 fallback 和 agent 级重试正确保留本次解析出的档位；中途切换不篡改已发出的请求。
- AC-05：请求档位、最终发送档位和上游回报档位可区分；回报缺失不当作成功，兼容费用逻辑不伪造实际档位。
- AC-06：`/fast`、`/settings`、全屏/常规 TUI 与 SDK 读取同一会话状态；非法参数和不支持模型有明确反馈。
- AC-07：保存默认值、会话覆盖、resume/tree/fork/clone、切换模型符合上述优先级和分支语义。
- AC-08：compaction/branch summary 与原生 child 的消费边界符合合同，并由 mock 测试证明；父会话运行时覆盖不会污染既有 child。
- AC-09：既有受保护的计价场景经过审查；`fast`/`priority` 别名不导致静默按标准价冒充准确费用，无法证实的费用注明估算或未知。
- AC-10：新增/修改测试定向通过，根 `npm run check` 完整通过，diff 仅含本任务变更，文档说明成本、资格限制和实际档位不保证。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> {T-002, T-003}; {T-002, T-003} -> {T-004, T-006, T-008}; T-004 -> T-005; {T-004, T-005} -> T-009; T-003 -> T-010; {T-004, T-005, T-006, T-008, T-009, T-010} -> T-007。
- Parallel batches:
  - B1：T-001；输入合同确认后执行。
  - B2/B3：T-002 与 T-003 可并行：T-002 独占 `types.ts`（同时声明 supportsFastMode 字段），T-003 仅修改生成器、config schema 和能力测试。共享类型验证在两者集成后统一执行。
  - B4：T-004 与 T-006 使用已约定会话 API 并行；前者独占配置/SDK/AgentSession，后者仅编辑 UI。T-006 的最终测试验收须等 T-004 实现落地。
  - B5：T-004 done 后执行 T-005；不得与 T-004 并写 AgentSession。
  - B6：T-007 汇总、交叉验证、文档、静态检查与最终 diff 审核。
- Serialization constraints:
  - `packages/ai/src/types.ts` 仅由 T-002 修改；T-003 使用已约定字段，不修改该文件。模型生成输出由 T-003 独占。
  - T-004/T-005 的 `agent-session.ts` 串行修改；T-006 不修改 session 核心与 settings-manager。
  - T-005 只拥有 compaction/collaboration 代码及其测试；T-006 只拥有交互模式、slash command、footer/editor frame 及其测试。
  - 若实际需要修改对方拥有的文件，先串行交接，不能凭任务并行掩盖共享 worktree 冲突。
  - `npm run check` 会写文件，统一由 T-007 在其他编辑全部停止后运行；检查前后核对 git diff。
  - 本文始终由协调者单独更新；不维护第二份状态清单。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化协议、模型范围与消费合同

- Status: done
- Owner: coordinator
- Objective: 在动代码前消除实际档位、计价和消费继承的关键歧义。
- Inputs and prerequisites: 用户明确实施授权；F-001 至 F-014；上述首版拟定合同。
- Scope or files: 本文；只读核对官方 Codex/API/模型价格文档、现有 service-tier 测试及相关 git 历史。
- Expected output: 本文记录最终状态表、可支持模型集合、费率证据边界与实施合同；不创建第二份规格文档。
- Dependencies: None.
- Execution steps:
  1. 核对工作区漂移、完整阅读待修改文件；确认当前 provider/生成器/原生 child 路径。
  2. 锁定 undefined/default/fast 的 UI、配置、请求、恢复及不支持模型语义。
  3. 为初始模型逐项记录官方能力证据；审查 Codex default 回显的历史原因和现有费用假设。
  4. 对实施授权中仍未确认的物质性决策，只询问最小问题；实际 API 验证不得默认为获准。
- Acceptance criteria:
  - 关键状态与优先级无冲突；能力声明有依据；未知项不会被自动当作支持或精确计价。
  - compaction/child 行为及成本提示已明示；计价兼容与实际档位分离方案可执行。
- Verification method:
  - 表驱动逐项走查 AC-01 至 AC-09，核实本地符号和公开原始资料并记录链接/适用范围。
- Validation evidence: 复核 F-001 至 F-014 的调用链；既有测试明确保护 default 回显计价。初始能力集合和估算限制已写入本文；沿用已读取的官方 Speed、API Fast 与 Codex ServiceTier 源码证据，未调用真实 API。V-PLAN 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 补齐统一请求选项和原始档位观测

- Status: done
- Owner: /root/fast-adapter
- Objective: 让 Codex `streamSimple()` 能发送档位，并保留请求/上游档位而不混用计价结果。
- Inputs and prerequisites: T-001 固化的 wire 值、计价兼容和响应元数据合同。
- Scope or files: `packages/ai/src/types.ts`、`api/openai-codex-responses.ts`、`api/openai-responses-shared.ts`；必要的选项 helper；`packages/ai/test/openai-codex-stream.test.ts` 及独立新增的定向测试。
- Expected output: 类型化 service-tier 选项；Codex simple/full 两条路径一致；有限的请求/回报元数据；无 provider 越界行为。
- Dependencies: T-001.
- Execution steps:
  1. 在统一选项声明最小的档位控制，由 Codex `streamSimple()` 显式传递；不默认给所有 provider 加字段。
  2. 捕获最终请求体的 `service_tier`，包括 payload hook 替换结果，避免“声明参数”与“实际发出”不一致。
  3. 在共享响应处理保留终态回报值；Codex 费用估算兼容解析与原始观测分开。
  4. 规范化 fast/priority 别名用于比较和既有估算，不臆造新模型费率；保护现有标准路径和历史测试。
- Acceptance criteria:
  - AC-01、AC-02、AC-04、AC-05、AC-09 的 adapter 层场景通过；hook 改写也可解释。
  - 改变档位时 websocket-cached 不复用不匹配的 continuation；连接复用不被误认为档位继承。
- Verification method:
  - Mock SSE、WebSocket、缓存续传、fallback、default/priority/fast/缺失回包、hook 替换和错误；定向运行修改的 AI 测试文件，并补跑 `openai-responses-compat.test.ts` 保护共享处理。
- Validation evidence: 协调者审查 AI 类型、adapter/shared parser diff 和完整新增测试；独立复跑 `openai-codex-service-tier.test.ts openai-codex-stream.test.ts openai-responses-compat.test.ts`，165/165 通过。验证 hook 最终档位、WS delta 失效、fallback/retry、null/缺失回报和既有估算计价；无真实 API。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 接入可维护的模型 Fast 能力

- Status: done
- Owner: coordinator
- Objective: 仅对有依据的 Codex 模型开放 Fast，不按名字前缀猜支持。
- Inputs and prerequisites: T-001 模型集合；与 T-002 约定 `OpenAIResponsesCompat.supportsFastMode?: boolean`，类型文件由 T-002 独占修改。
- Scope or files: `packages/ai/scripts/generate-models.ts`、相关生成目录和元数据测试；`packages/coding-agent/src/core/model-config.ts` 与模型 override 测试。
- Expected output: 最小 Fast 能力元数据及本地 override 接线；生成数据可重建，unknown 与 false 可解释。
- Dependencies: T-001.
- Execution steps:
  1. 按 T-001 合同新增最小能力字段并在生成器声明支持模型，保留非 Codex 模型行为。
  2. 接通 model override 的 schema/校验/读取；对自定义支持声明明确其属于用户配置，不宣称账户验证。
  3. 通过仓库生成流程更新产物，不手工编辑生成源文件；审查远程目录覆盖时缺字段的安全行为。
  4. 用 fixture 验证支持/不支持/未知、override 和目录更新情况。
- Acceptance criteria:
  - 新旧目录与用户 override 能正确加载；未知能力不被当作支持；生成产物与生成逻辑一致。
- Verification method:
  - 定向运行实际修改的生成器/模型数据/registry 测试，必要时 `npm run check:model-data --workspace packages/ai`；生成器可能联网，先检查参数和输入，不运行 build。
- Validation evidence: 离线捕获本地 1577 条目录记录，用 `node scripts/generate-models.ts --strict --data-only --normalized-input /tmp/pi-fast-model-snapshot.json` 重建，`node scripts/check-model-data.ts` 通过。AI 定向 `normalized-model-generation.test.ts model-data-validation.test.ts` 共 30/30 通过；coding-agent `codex-fast-capability.test.ts` 2/2 通过。生成目录为仓库既有 ignored 产物，持久修正在生成器。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 建立配置、会话状态和分支持久化

- Status: done
- Owner: /root/fast-session
- Objective: 建立唯一档位解析入口，避免 UI、普通调用和恢复各自实现优先级。
- Inputs and prerequisites: T-002 协议类型；T-003 模型能力。
- Scope or files: `packages/coding-agent/src/core/settings-manager.ts`、`sdk.ts`、`agent-session.ts`、`session-manager.ts`、必要公开导出；仅在现有请求边界无法承载时修改 `packages/agent/src/{agent.ts,agent-loop.ts,types.ts}`；相关定向测试。
- Expected output: 默认配置与会话 API；分支可见的偏好持久化；每次请求确定最终档位与来源。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 加入配置验证和单一状态解析；区分 undefined/default/fast、requested/effective/unavailable。
  2. 在 SDK 共同 streamFn 请求边界解析会话偏好并透传；单次显式选项优先，不因对象展开的 undefined 清空持久默认。
  3. 增加会话 getter/setter 和状态事件；写入不进入模型上下文的分支事件，接入 resume/tree/fork/clone。
  4. 模型切换只重算可用性；正在流式生成的请求保持原档位，下一次请求使用新值。
  5. 审核 durable/protocol 序列化边界；只加入保存本功能所必需的投影，不扩展无关控制面。
- Acceptance criteria:
  - AC-01 至 AC-03、AC-06、AC-07 的配置/SDK/持久化场景通过；未配置旧会话请求保持不变。
- Verification method:
  - 扩充 `sdk-stream-options.test.ts`、`settings-manager.test.ts`、`session-manager/build-context.test.ts` 及实际分支测试；suite 下新增测试使用 faux harness。
- Validation evidence: 协调者审查核心 helper、SDK/AgentSession/settings diff 和完整新增 faux suite；独立复跑 `suite/codex-service-tier.test.ts settings-manager.test.ts sdk-stream-options.test.ts session-manager/build-context.test.ts` 103/103 通过。子任务 8 文件 147/147 结果含 runtime/tree guards；协调者另一次含旧 tree-navigation 的运行 132 passed/10 skipped（该旧文件本身 skipped），不将 skipped 当作通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 接通内部摘要并验证原生 child 边界

- Status: done
- Owner: coordinator（AgentSession 调用点交由 /root/fast-session 连续任务）
- Objective: 保证非普通对话调用不会漏传档位或意外扩大父会话 Fast 消费。
- Inputs and prerequisites: T-004 会话解析 API；T-001 的 compaction/child 合同。
- Scope or files: `packages/coding-agent/src/core/agent-session.ts`、`core/compaction/subsystem/session-integration.ts`、必要 `compaction.ts`；`src/extensions/pi-child-session-host.ts`、`pi-collaboration-root.ts`、`pi-collaboration-tools.ts` 中最小必要接线；`test/compaction-codex-options.test.ts` 和原生 collaboration 测试。
- Expected output: 摘要与主请求使用一致的会话档位；child 不继承父运行时覆盖，且独立读取自己的配置/能力。
- Dependencies: T-004.
- Execution steps:
  1. 显式贯通手动/自动 compaction 与 branch summary 的档位选项，不依赖主对话 onPayload 回调。
  2. 保留原有 toolChoice、reasoning、sessionId、cacheAffinityId、promptCacheKey 语义。
  3. 验证真实 native child host 的新建/恢复路径；仅在测试证明现有 settings 复制违背合同后修改接线。
  4. 验证父开/关、默认配置、child 模型不同或不支持、已存在 child 不受后续切换影响。
- Acceptance criteria:
  - AC-03、AC-08 通过；不改变 child 权限、工具、模型/effort 默认或团队 schema。
- Verification method:
  - 运行 `compaction-codex-options.test.ts` 和实际修改的 `pi-collaboration-*.test.ts`/host 测试；全部使用 mock/faux，不启动真实模型 child。
- Validation evidence: 协调者审查三个 AgentSession 调用点与完整摘要 suite；独立运行 `suite/codex-service-tier-summaries.test.ts compaction-codex-options.test.ts codex-fast-internal-options.test.ts codex-fast-child-isolation.test.ts pi-child-session-host.test.ts suite/regressions/6324-branch-summary-ambient-auth.test.ts suite/regressions/7048-branch-summary-truncated.test.ts`，7 文件 58/58 通过。真实 native host 使用 faux provider，支持/未知 child 模型和三个默认状态通过，不需要改 child 生产接线。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 添加 Fast 命令、设置菜单和两种 TUI 展示

- Status: done
- Owner: /root/fast-ui
- Objective: 用户能控制 Fast，并看懂请求偏好、不可用状态和最近上游报告的差别。
- Inputs and prerequisites: T-002 响应元数据和 T-003 能力；已与 T-004 约定的 codexServiceTier/getCodexServiceTierStatus()/setCodexServiceTier() 会话 API 和 codex_service_tier_changed 事件，UI 不改核心文件。
- Scope or files: `packages/coding-agent/src/core/slash-commands.ts`；`src/modes/interactive/interactive-mode.ts`、`components/settings-selector.ts`、`components/footer.ts`；`src/modes/interactive-grok/components/grok-editor-frame.ts`；必要 session port/event 投影；相关 TUI/交互测试。
- Expected output: `/fast [on|off|status]`、默认配置三态选项、全屏与常规模式提示；不复制核心解析逻辑。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 增加命令发现、参数校验、执行与帮助；命令错误不能落成普通模型 prompt。
  2. 菜单区分“当前会话”与“默认配置”；明确 Standard/Fast/未指定以及额外消耗。
  3. 展示有效偏好、unavailable/unknown 状态及必要的上游差异提示，不能把估算 tier 显示成实际生效。
  4. 验证窄屏、全屏、常规 footer、流式切换后刷新；不新增硬编码快捷键。
- Acceptance criteria:
  - AC-05、AC-06 通过；错误信息准确，未开启时不增加多余噪声，模型和 effort 标签无截断回归。
- Verification method:
  - 定向运行修改的 settings/command 测试及 `grok-shell-components.test.ts`、`interactive-mode-grok-components.test.ts` 中相关覆盖；使用 ANSI 主题和多宽度渲染断言。需要交互烟测时仅使用 faux provider。
- Validation evidence: 协调者审查 UI helper、全部 UI 接线 diff 和完整命令测试；独立复跑 `interactive-mode-fast-command.test.ts settings-selector.test.ts footer-width.test.ts grok-shell-components.test.ts interactive-mode-grok-components.test.ts grok-pi-session-port.test.ts`，6 文件 85/85 通过。包含本地命令拦截、非法参数/streaming/follow-up、真实 session 默认切换、上游未知/Standard、ANSI 宽度与双 TUI；无真实模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 集成回归、文档和交付门禁

- Status: done
- Owner: coordinator
- Objective: 用离线证据验证完整用户路径，记录限制并完成范围内交付。
- Inputs and prerequisites: T-005、T-006 完成且各自测试通过；T-002 至 T-004 证据可复查。
- Scope or files: 必要跨层回归测试；`packages/coding-agent/docs/settings.md`、`README.md`、相关 SDK/模型/session 文档；本轮已验证 SDK 快照教训的根 `LEARNS.md` 条目；符合分支规则时的对应 CHANGELOG；本文。
- Expected output: AC-01 至 AC-10 的当前验证记录、使用与成本说明、可审查的最小 diff。
- Dependencies: T-004, T-005, T-006, T-008, T-009, T-010.
- Execution steps:
  1. 走完整配置/命令/请求/回包/恢复/模型切换链路；复查所有修改测试及非 Codex 负例。
  2. 补齐文档与必要 changelog；不把未执行的真实加速测试写成通过。
  3. 所有编辑停止后运行根 `npm run check`，保留完整输出，核对自动改写范围；失败必须定位并重新验证。
  4. 对照 AC 矩阵审查 diff，验证本文；只在实现和所需验证完成后按仓库规则提交本任务显式文件。
- Acceptance criteria:
  - AC-01 至 AC-10 通过；无越界改动、无真实 API 消费；所有实现任务的验证证据已录入本文。
- Verification method:
  - 定向测试、`npm run check`、`git diff --check`、人工 diff 审查、任务文档 validator；不运行 build、`npm test` 或全量 vitest。
- Validation evidence: 最终根 `npm run check` exit 0（1544 文件，无自动修复，含全部 pinned-deps/imports/shrinkwrap/install-lock/tsc/browser-smoke 门禁）；最终定向 AI 5 文件 195/195、coding-agent 26 文件 360/360、protocol 55/55、server 16/16，共 33 文件 626/626，无 skipped。所有新增/修改测试均执行，文档五处更新，独立只读复核发现的问题经 T-009 先红后绿修正，远程目录边界经 T-010 先红后绿修正。生成目录离线验证通过，未运行真实 API/build/全量套件；本文 validator 与最终 staged diff 门禁另见执行日志。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 补齐公共类型消费者与协议观测投影

- Status: done
- Owner: coordinator
- Objective: 解决新增 compat/AssistantMessage 字段对已有严格类型消费者的必需集成，不增加服务档位远程控制面。
- Inputs and prerequisites: T-002/T-003 公共类型；静态检查发现 openai-responses Required compat 和 server ExactKeys 覆盖缺口。
- Scope or files: `packages/ai/src/api/openai-responses.ts`；`packages/protocol/src/schemas.ts`；`packages/server/src/protocol.ts` 与定向协议测试。
- Expected output: 非 Codex adapter 默认 Fast 能力 false；原始 requested/sent/reported/estimated 观测可经现有 transcript 投影保留，严格 JSON schema 接受可选元数据。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 核对新增公共类型的 Required/ExactKeys 消费者并补齐显式处理。
  2. 只增加可选响应元数据 schema/投影，不增加 RPC 命令、session 控制字段或其他 provider 的请求行为。
  3. 验证缺失/null/加速与标准差异的序列化和原有协议场景。
- Acceptance criteria:
  - 原有类型合同不破坏；观测字段不被伪造或混同；无协议控制面扩张。
- Verification method:
  - 定向 AI compatibility 与 server/protocol 测试；最终根 npm run check。
- Validation evidence: 修改完整 source/测试后定向运行 server `protocol.test.ts` 16/16、protocol `protocol.test.ts` 55/55、AI `openai-responses-compat.test.ts openai-codex-service-tier.test.ts` 124/124 均通过。原始档位可选字段保留 null/省略 undefined，schema 拒绝无效类型/未知键；根静态门禁由 T-007 执行。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 固定摘要重试的“未指定”档位快照

- Status: done
- Owner: /root/fast-session
- Objective: 修复独立复核发现的消费偏好泄漏：未指定档位开始的摘要重试不能因用户后续开启 Fast 而升级。
- Inputs and prerequisites: T-004/T-005 实现；独立只读评审定位到 SDK 每次 streamSimple 重新解析缺失 tier。
- Scope or files: `packages/coding-agent/src/core/codex-service-tier.ts`、`sdk.ts`、`agent-session.ts` 和实际 SDK seam 的摘要重试定向测试；必要 helper 仅限本任务。
- Expected output: “已解析且未指定”与“待读取默认配置”可区分；既有普通单次请求 undefined 仍按原优先级处理，不发送 Standard/null 代替省略。
- Dependencies: T-004, T-005.
- Execution steps:
  1. 先以实际 SDK stream seam + mocked runtime adapter 复现 manual/auto/branch 摘要 unset→Fast 的重试升级并记录失败断言。
  2. 在请求快照边界保留 unset 状态，防止重试重新查询当前偏好；不扩大为新的公开 tier 值或全局控制面。
  3. 复跑反向切换、显式 Fast/Standard、未指定普通请求、摘要与 child 邻域测试。
- Acceptance criteria:
  - 首次与重试请求都不携带 tier，下一条普通模型请求才采用新 Fast 偏好；不改变已有请求字段/effort/cache/权限。
- Verification method:
  - 实际 SDK seam 的回归先红后绿；相关 session/summary 测试、根静态检查。
- Validation evidence: 新 `suite/codex-service-tier-sdk-summaries.test.ts` 在改生产代码前 3 failed/6 passed，三个 unset 路径均捕获 [undefined,fast] 而非 [undefined,undefined]；显式 Fast/Standard 对照通过。增加摘要本地 snapshot wrapper 和 SDK 消费/剥离的内部 symbol 后九个场景通过；协调者审查 helper/SDK/callsites 和完整新测试，独立六文件 67/67 通过。子任务九文件 110/110、scoped tsc/Biome 通过；根静态门禁在 T-007 复跑。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 保留旧远程目录缺失的新能力字段

- Status: done
- Owner: coordinator
- Objective: 验证并修正正常目录刷新覆盖 bundled Codex 模型时丢失 supportsFastMode 的集成缺口；未知模型仍不得自动放行。
- Inputs and prerequisites: T-003 的本地能力声明；远程目录 merge 当前按整条模型替换，旧目录可能没有新字段。
- Scope or files: `packages/coding-agent/src/core/remote-catalog-provider.ts` 和 `test/remote-catalog-provider.test.ts`；必要文档一句说明。
- Expected output: 对已知相同 Codex provider/API/model，仅在远程字段缺失时继承 bundled 能力；远程显式 false 优先，未知模型/不同 API 不继承。
- Dependencies: T-003.
- Execution steps:
  1. 用 mocked catalog fetch 和离线 store 恢复构造旧目录覆盖已知模型的失败回归。
  2. 限定合并新能力字段，不全局深合并其他 compat 或改变目录时间戳/价格规则。
  3. 验证显式覆盖、未知模型、不同 API、冷启动恢复和既有 mixed-operation 目录场景。
- Acceptance criteria:
  - 已验证支持模型在旧目录刷新后仍可开启 Fast；远程明确禁用仍生效，不放大支持集合。
- Verification method:
  - 目录回归先红后绿；相关 capability/session 测试与根 check。
- Validation evidence: 协调者先新增回归，`remote-catalog-provider.test.ts` 1 failed/18 passed，唯一失败为缺失新字段的远程条目抹掉已知模型 true；显式 false/true、异 API 和原目录对照通过。限定 Codex 相同 API/model 的缺字段回填后，remote-catalog + capability + session 三文件 42/42 通过；包含新 fetch/冷 store 恢复、getModels/getAllModels、未知模型保护。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

### 命令与权限

- V-PLAN：`python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-10-15-codex-gpt-fast-mode-task.md`。计划模式唯一必须执行的结构校验。
- V-AI：从 `packages/ai` 运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/openai-codex-stream.test.ts test/openai-responses-compat.test.ts`；新建/修改的 AI 定向测试同样逐文件列出并执行。
- V-SESSION：从 `packages/coding-agent` 用相同 vitest 入口运行 `test/sdk-stream-options.test.ts test/settings-manager.test.ts test/session-manager/build-context.test.ts` 及实际修改的分支恢复测试。
- V-INTERNAL：同目录定向运行 `test/compaction-codex-options.test.ts`、实际修改的原生 collaboration/child host 测试，禁止替换成 real-provider 文件。
- V-UI：同目录定向运行实际修改的菜单/命令/全屏/常规 footer 测试；新建测试使用仓库既有 faux/harness。
- V-STATIC：根 `npm run check`，不得截断输出；代码变更后的交付必需。它会自动改写文件，前后必须核对范围。
- V-DIFF：根 `git diff --check`、`git diff --stat` 和逐文件 diff 审查，验证权限/缓存/模型身份未被顺带改变。
- 执行时新测试的准确路径由所属任务记录；不在未创建文件前假装其测试已存在或通过。

### 最小测试矩阵

| 维度 | 必测场景 | 责任任务 |
| --- | --- | --- |
| 请求偏好 | undefined/default/fast，单次请求覆盖，hook 改写 | T-002, T-004 |
| 能力 | 支持、不支持、未知、用户 override、非 Codex；旧远程目录缺字段与冷恢复 | T-003, T-004, T-010 |
| 传输 | SSE、WS、cached delta、切档后 full request、fallback、重试 | T-002, T-007 |
| 回报 | priority、fast、default、null/缺失、失败终态 | T-002, T-007 |
| 费用 | 既有倍率回归、别名、上游 default 差异、估算/未知说明 | T-001, T-002, T-006 |
| 会话 | 配置来源、运行中切换、resume/tree/fork/clone、旧会话 | T-004 |
| 内部调用 | 手动/自动 compaction、branch summary、独立 summarization | T-005 |
| child | 默认配置、父会话覆盖隔离、异模型、现有 child 不变 | T-005 |
| 交互 | on/off/status、无参数切换、非法参数、菜单、窄屏双 TUI | T-006 |

### 最终定向组合（各自在对应 package 根目录执行）

统一入口为 `node ../../node_modules/vitest/dist/cli.js --run`，以下为实际文件参数与结果：

- `packages/ai`：`test/openai-codex-service-tier.test.ts test/openai-codex-stream.test.ts test/openai-responses-compat.test.ts test/normalized-model-generation.test.ts test/model-data-validation.test.ts` — 5 文件 195/195。
- `packages/coding-agent`：`test/codex-fast-capability.test.ts test/codex-fast-child-isolation.test.ts test/codex-fast-internal-options.test.ts test/compaction-codex-options.test.ts test/footer-width.test.ts test/grok-shell-components.test.ts test/settings-manager.test.ts test/settings-selector.test.ts test/interactive-mode-fast-command.test.ts test/suite/codex-service-tier.test.ts test/suite/codex-service-tier-summaries.test.ts test/suite/codex-service-tier-sdk-summaries.test.ts test/sdk-stream-options.test.ts test/interactive-mode-grok-components.test.ts test/grok-pi-session-port.test.ts test/pi-child-session-host.test.ts test/suite/agent-session-compaction.test.ts test/suite/agent-session-runtime.test.ts test/suite/regressions/7048-branch-summary-truncated.test.ts test/suite/regressions/6324-branch-summary-ambient-auth.test.ts test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts test/suite/regressions/3688-tree-cancel-compacting.test.ts test/suite/regressions/tree-during-streaming.test.ts test/session-manager/build-context.test.ts test/session-manager/tree-traversal.test.ts test/remote-catalog-provider.test.ts` — 26 文件 360/360。
- `packages/protocol`：`test/protocol.test.ts` — 55/55。
- `packages/server`：`test/protocol.test.ts` — 16/16。

真实 API 验证是额外可选项，不属于当前授权或必需离线门禁。若以后用户明确批准，需显式 opt-in env、定向单文件、mock/CI 默认不执行；默认模型为 `gpt-6.1-sol`、medium effort，不输出凭据。届时只能验证该账户/模型/时间点的接受情况与回报档位，不能把一次速度差当成普遍性能保证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-001（授权）：用户已明确授权实施和交付；真实模型调用、发布和额度购买仍不在授权内。
- R-002（计价语义）：Codex default 回显有既有测试保护，公开 API 的真实降级语义不能直接套用为删除兼容逻辑的理由。T-001 核实，T-002 分离 raw report 与估算。
- R-003（费用）：Fast 会增加用量；compaction 沿用同会话档位。child 仅使用自己的默认配置，避免父运行时切换无声扩大消费。
- R-004（能力漂移）：静态/远程目录可能不同步，账户可能拒绝请求。未知能力不自动启用；文档和 UI 不承诺实际加速。
- R-005（状态一致性）：配置默认、分支覆盖、模型切换和请求中途修改可能产生多份真相。T-004 单一解析入口和分支测试作为准入门槛。
- R-006（缓存）：service tier 是非 input 请求字段；切档后的 WS continuation 必须遵守既有匹配规则。缓存 key/affinity 不随功能改写。
- R-007（扩展）：payload hook 可覆盖 service_tier。最终发出值应可观测，不能只显示选项对象中的值。
- R-008（共享工作区）：生成器与 `npm run check` 可能写大量产物。执行前核对现状、独占相关文件，保留其他会话改动。
- R-009（协议扩散）：若新增持久响应字段触及 strict JSON/schema 必须补最小序列化测试；不借此扩展全部 RPC/client/server 控制面。
- 当前无已开始后被阻塞的实现任务；R-001 是整个实施阶段的准入门槛，不把尚未开始的任务虚标为 blocked。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-15 17:16 +0800：以 plan 模式建立任务文档；初始 `git status --short` 无输出。复用上一轮官方文档/协议与 Codex provider 分析证据，并核对 SDK、compaction 测试、模型生成器、原生 collaboration 和 TUI 接线。
- 2026-10-15：填入范围、拟定合同、T-001 至 T-007、串并行边界和离线验证矩阵。只创建/编辑本文，未修改实现、未启动子 agent、未运行产品测试或付费模型调用。
- 2026-10-15：V-PLAN 返回 `Task document is valid`；`git diff --check` 无输出，`git status --short` 仅列出本文为新文件。人工检查任务依赖无环，T-002/T-003 和 T-004/T-005 的共享文件串行，实施任务均为 pending。
- 2026-10-15：用户授权实施，切换 execute；T-001 开始。分支 `my-pi`，只有本任务计划文件未跟踪；不在非 main 分支添加 CHANGELOG。
- 2026-10-15：T-001 完成合同走查和证据核对；T-002 开始，由 fast-adapter 实现限定 AI 协议层；协调者只读准备后续会话接线。
- 2026-10-15：核实生成器支持 normalized-input 离线重建。明确 types.ts 由 T-002 独占并声明 supportsFastMode 后，T-003 改为仅依赖 T-001，由协调者并行修改生成器/config schema/能力测试，避免不必要的串行等待。
- 2026-10-15：T-003 完成，审查生成器只给已证实的三款 Codex 模型补能力，保留显式 false；离线重建和 32 项定向测试通过。
- 2026-10-15：T-002 经协调者 diff/完整测试审查及独立复跑 165 项测试验收。T-004 开始，由 fast-session 独占核心配置/会话实现；AI 协议类型不再并改。
- 2026-10-15：固定会话 API 合同后，T-006 改为仅依赖已完成协议/能力任务并并行开发 UI，最终验收等待 T-004。文件所有权无交叉；T-005 仍等待核心文件交接。
- 2026-10-15：T-004 定向静态检查发现公共类型的 Required compat/ExactKeys 消费者缺口。新增必要任务 T-008，协调者独占协议观测投影与非 Codex compat 默认；不扩展远程档位控制面。
- 2026-10-15：T-004 核心差异和新 suite 经协调者复查，独立 103 项测试通过，完成交接；T-008 三组定向验证通过。T-005 开始：协调者修改摘要 helper/验证 native child，fast-session 连续任务仅补已读过的 AgentSession 调用点和独立定向测试。
- 2026-10-15：T-005/T-006 经协调者完整新测试/接线差异审查、独立 58/85 项测试复跑后验收；所有 worker 已明确交回编辑权。T-007 开始，补文档、跨层验证和根静态门禁。
- 2026-10-15：首次根 check 在两个新测试的 compat 类型访问失败，无生产类型错误；已修正测试类型。独立只读 reviewer 指出未指定摘要重试经 SDK 重新解析会被后续 Fast 开关升级，协调者复查因果链成立。T-007 blocked，新增 T-009 先复现后修复；不把原 custom-stream 测试当成该边界的充分验证。
- 2026-10-15：T-009 先红后绿证实根因和修复；协调者独立复跑 67 项通过后验收。T-007 解阻并恢复，所有子任务交回编辑权。根 LEARNS.md 追加本轮已验证的“resolved omission + 真实 SDK seam”教训，未修改旧记录；两个测试类型修正复跑 5/5 通过。
- 2026-10-15：根 check 全部通过（1544 文件无自动修复）。最终目录覆盖走查发现旧远程条目按整条替换会丢弃新 bundled 能力，新增 T-010 的先红后绿目录集成门禁；不把静态本地目录测试当作远程刷新验证。
- 2026-10-15：T-010 回归先 1 failed/18 passed，限定回填后相关三文件 42/42 通过，完成验收。此前全组集成为 AI 195、coding-agent 341、protocol 55、server 16 项全部通过；补目录场景后重新执行最终 coding-agent 组合和根 check。
- 2026-10-15：末次根 `npm run check` 全部通过（1544 文件，无自动修复）；最终 AI/coding-agent/protocol/server 定向组合分别 195/360/55/16 项通过，共 33 文件 626 项，无 skipped。T-007 验收完成；仅本任务文件进入显式路径提交，不发布、不构建产物。已清理本轮 /tmp snapshot/tsconfig 脚本，所有子 agent 已完成并关闭。
- 2026-10-15：最终任务 validator 通过；`git diff --check`、`git diff --cached --check` 均通过。逐路径审查后显式暂存 47 个本任务文件（源实现、回归、文档和单条 verified learn），没有未暂存代码改动；无依赖/lockfile/参考仓库变更。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-010 全部完成（含实现、独立审查、两个真实边界缺口的失败/通过回归）；根 check 全部通过，33 个定向测试文件共 626/626 通过。AC-01 至 AC-10 均有本文各任务的 mock/faux/静态验证证据；文档结构校验、范围审查和 staged diff 校验全部通过。
- Limitations: 这是源码/本地提交交付，未构建、安装或发布二进制。未调用真实模型 API，故账户/地区资格、实际加速幅度和账单未验证，不能承诺上游一定执行 Fast。终端交互使用组件和 faux 测试而非人工真实模型烟测；目录能力默认仅覆盖已记录的三款模型，其他模型需有依据的显式声明。
