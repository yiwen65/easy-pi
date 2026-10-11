# Task Plan: main MCP 更新分析与 easy-pi 移植方案

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户已追加「开始实施，完成交付」，授权按本方案第一期实现、必要安装/锁文件、本地构建和模拟服务器验证；不包含真实凭据、付费 API 或外部发布。

<!-- task-doc-section:background-goal -->
## Background and goal

**建议：移植最新 main 的独立 MCP 客户端，按 easy-pi 的工具授权和恢复契约改造接入层；MCP 与 codemode 分开交付，不整提交 cherry-pick。**

最终第一期产品范围建议为 stdio + Streamable HTTP、OAuth、工具/resources、`/mcp` 和 `epi mcp`、direct/deferred/hidden exposure，以及原生子 agent 的严格授权。先用 direct 模式打通内部链路，再补 deferred；最终默认 deferred，避免把大量 schema 一次性塞进模型上下文。codemode 单独作为后续需求。

上游并非「加一个插件」：2026-09-29 的 `8562bcf66` 同时引入协议客户端、codemode、按需发现、嵌套工具执行、结构化结果和通用工具 exposure，涉及 143 个文件，17,616 行新增、221 行删除。因此必须按功能依赖裁剪，不能用一次 cherry-pick 取代接入设计。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

前轮完成只读分析；本轮按第一期范围实施，允许有边界的子 agent 协作、必要锁文件更新与本地构建/定向测试。只修改本任务负责文件；当前 recovery/collaboration 用户改动保留，不切换分支、不对外发布。

建议第一期实施范围：

- `packages/mcp/` 客户端及单元测试，保留许可证。
- MCP 配置、transport/runtime、OAuth store、工具与 resources 适配。
- 必需的 extension API、exposure 元数据、发现及分支恢复。
- CLI、现有 TUI 管理入口、SDK 和 native child 接线。
- easy-pi 打包、锁文件、离线本地回归。

不包含：

- 合并整个 main；迁移 upstream durable/env/chord 等无关架构。
- QuickJS/codemode、脚本嵌套工具调用、classifier/image 模型扩展。
- Radius 一键 MCP 设置、`auth.provider` 凭据转发、pi.dev CIMD 身份。
- legacy SSE、MCP Apps UI、sampling、MCP tasks；不自行补齐上游不支持的协议面。
- 新权限弹窗、OS sandbox 或共享 MCP 连接池。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

### 基线与范围

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 本次 main 指 origin/main，不是 easy-pi/main。origin/main 为 `e37cdc420669e48b4df4bbce0fb2617fc3c71328`，2026-10-10 提交；远端 tip 与本地一致。 | `git remote -v`、`git branch -avv`、`git ls-remote origin refs/heads/main`、`git log origin/main -1`。 |
| F-002 | 本轮开始时 easy-pi 分支为 my-pi，HEAD `11067598d`，领先 easy-pi/main 30 个提交；存在用户/并行会话未提交改动，调查期间恢复相关文件继续变化。 | 两次 `git status --short --branch`；`core/agent-session.ts`、`core/task-recovery.ts`、协作控制器和 harness 文件处于并行修改中。 |
| F-003 | Git 报告 HEAD 与 origin/main 存在多个 merge base；三点 diff 不适合直接当作本次功能增量。 | `git diff --stat HEAD...origin/main` 的警告。改用 `git show 8562bcf66` 确认引入范围、`git diff HEAD origin/main -- <具体文件>` 对照接口，以及 main 文件快照读取。 |
| F-004 | MCP 初始引入提交是 `8562bcf66`，后续有大量正确性、生命周期及安全修正。 | `git log origin/main --reverse --oneline --grep=mcp -i`、`git show --stat 8562bcf66`。 |

### 上游功能分层

| Layer | 观察到的实现 | 移植结论 |
| --- | --- | --- |
| 协议客户端 | `packages/mcp/src/client.ts`、`transports/stdio.ts`、`transports/streamable-http.ts`、`oauth/`；唯一运行时依赖 `cross-spawn: 7.0.6`，不依赖官方 MCP SDK 或其他 pi 包。 | 最适合按固定 main SHA 引入源码和测试；不需要先迁移 agent-core。 |
| 配置 | `core/mcp-servers.ts`、`extensions/mcp/config.ts`：全局/可信项目 mcp.json，项目完整替换或有限 enabled/exposure/toolExposure 覆盖，扩展注册、名称冲突检查。 | 配置校验及合并逻辑可复用；默认 exposure 和可用选项必须按一期能力调整。 |
| runtime/OAuth | `extensions/mcp/runtime.ts`、`oauth.ts`：后台连接、列表变化、断线重连、进度/取消、跨进程刷新锁，凭据按 server name + URL 分离。 | 保留当前 main 的并发与清理修复，不从初始版本重新拼装。agentDir 和凭据后端改成实例注入。 |
| 工具适配 | `extensions/mcp/tools.ts`、`resources.ts`：mcp__server__tool 命名、哈希消歧、文本/图片、20 KB 文本预算、全文/二进制临时文件、资源工具。 | 可复用转换逻辑；必须适配 easy-pi 的 AgentToolResult/AgentToolError 和恢复语义。 |
| discovery | `extensions/tool-search/tool.ts`：BM25 搜索 metadata，加载 deferred 工具；ToolDefinition.exposure 和 AgentSession registry 配合。 | 建议一期带 deferred，不必带 QuickJS；搜索只能在当前授权目录中进行。 |
| 管理界面 | `extensions/mcp/index.ts`、`ui.ts`、`cli.ts`：/mcp 与 shell add/remove/list/login/logout。 | 复用行为与测试；不能整文件复制，缺少的 UI/输出辅助函数要接现有实现或最小补充。 |
| codemode | `packages/codemode/`、coding-agent 的 codemode extension，QuickJS worker/wasm、prepareLoadout、executeTool、nestedCalls。 | 不是协议客户端的前置依赖；上游 MCP index/tools 有静态耦合，裁剪时必须拆开这些 import 和启动分支。 |

功能依据：已完整读取 main 的 `packages/mcp/README.md`、`packages/coding-agent/docs/mcp.md`、`docs/codemode.md`；配置、工具、resources、runtime、OAuth、管理 extension 与 UI 代码均已读取。main 文件通过 `git show` 保存到临时目录读取，未切换工作分支。

### 必须覆盖的后续修复

| Commit | 已观察到的修复 | 移植要求 |
| --- | --- | --- |
| `c5f5b3282` | OAuth 回调存在 iss、但无 authorization server metadata 时，交换 code 前拒绝；此前无法核对 issuer。 | 必须包含。`packages/mcp/CHANGELOG.md` 将它列在 Unreleased；仅依赖版本字符串 1.1.0 不能保证获得这个修复。 |
| `1d74741e1` / `5806068c2` | 跨进程序列化 token 刷新；凭据按名称和 URL 分离。 | 保留，避免并行会话刷新令牌轮换互相破坏。 |
| `c662ec7e3` | resume/reload 时，MCP 尚未连接导致已发现工具丢失；暂存未注册工具名称，注册后恢复。 | 迁移语义，不复制 main 整套会话投影。 |
| `8c911797c` | shutdown 取消并等待仍在 connecting 的连接。 | 保留在 quit/reload/child disposal 的回归中。 |
| `2db5e359b` | /mcp 不等待所有连接完成；后台管理操作与替换串行，执行时解析当前连接。 | 保留，避免慢服务卡住管理界面或旧连接继续被调用。 |
| `f10993bc7` | Esc/shutdown 取消登录；OAuth 请求有时限；关闭 HTTP session 不触发新刷新。 | 保留，退出还需等待已完成令牌轮换的持久化。 |
| `04b97ef00` | MCP 工具名 pattern、--no-mcp，并保留未被 --tools 点名的间接 MCP 工具。 | pattern 和 --no-mcp 可取；放宽 allowlist 的部分必须拒绝。 |

### easy-pi 接口冲突与解决方向

这些是移植冲突，不是声称当前 easy-pi 已存在 MCP 缺陷。

**1. 授权集合不能等同于工具声明集合，也不能套用 main 的 MCP 例外。**

当前 `core/agent-session.ts::_refreshToolRegistry()` 严格按 `_allowedToolNames` / `_excludedToolNames` 过滤 builtin、extension、custom 工具。main 的 `_isAllowedTool()` 则允许 allowlist 未匹配的 MCP 工具保留，供 codemode/tool_search 间接访问；main `test/suite/agent-session-mcp.test.ts:231-301` 专门断言这种行为。

例：移植 main 原逻辑后，`tools: ["read", "tool_search"]` 可以搜索并激活未授权 MCP 工具。不能把这种上游产品选择移入 easy-pi SDK 或 delegation。

方案：明确三个概念，不必另建复杂框架：

- allowed：host/delegation 真正授予的工具名称；显式 tools 始终是严格白名单。
- callable/discoverable：allowed 内、当前配置未 hidden/撤销且可调用或可发现的工具。
- declared：本次交给模型的 schema；deferred 被发现前不在这里。

`setActiveTools`、动态注册、搜索、历史恢复及每次执行都不得扩张 allowed。若支持 CLI pattern，在会话边界统一应用严格 matcher；委派仍记录已解析的具体名称，不把 wildcard 当作允许未来自动加工具的授权。`--tools read` 不连接/暴露未授权 MCP 工具；`--tools read,tool_search` 搜索结果仍不能超出明确授予的 MCP 工具。Full Access 不改变该工具能力边界，也不意味着 stdio 是 OS sandbox。

**2. Native child 没有 MCP factory；只复制 root 插件并不会自动给子 agent 提供 MCP。**

证据：`extensions/index.ts::createBuiltInExtensions()` 是实例工厂；`core/sdk.ts` 只在未提供 resourceLoader 时使用它。`extensions/pi-child-session-host.ts::createPiChildSessionHost()` 自建 loader，显式加载 web-search/easy-pi-child，`pi-collaboration-root.ts` 又设置 noExtensions=true，只复用已经批准的绝对路径扩展。

同时 root/controller admission/child live guard 目前以 `getActiveToolNames()` 为能力来源；child 每次 run 又调用 `setActiveToolsByName()` 重建工具集合。deferred 引入后，未声明但已授权的工具会遗漏，搜索加载状态还可能被重置。

方案：root 和 child 都实例化 MCP adapter。沿协作能力查询链区分「可授予目录」和「本次声明」，保留 live ancestry/root 撤权检查；发现仅改变 declared。创建及 follow-up 时不接受超出父级有效授权的工具。未加载的 MCP 项先不自动纳入本次委派；父级完成注册后才能在新的授权快照中使用。preserved-prefix 仍要求有序 schema 完全一致，不兼容时按现有机制拒绝，不偷偷改 rebuild。

child 使用父级已批准配置的受限视图，不自行重新发现更多项目/global MCP 服务，不触发浏览器登录。需要凭据时由 root 用户登录，child 返回 needs-auth。一期每 session 自有 runtime 和 transport；明确 ownership/close，不增加共享连接池或全局 cwd/env 修改。进程数量成本记录为后续测量项。

**3. Resource 工具是跨 server 通用入口，仅检查名称不够。**

main `resources.ts::createMcpResourceToolDefinitions()` 用 `options.servers()` 覆盖所有连接；`read_mcp_resource({server,uri})` 根据参数选服务，list 省略 server 会枚举全部。授予一个通用 resource 工具不能被解释成授予所有服务器。

方案：root 的资源范围来自已批准配置；child 的资源范围是父范围与明确委派资源范围的交集。将受限 server 视图传给资源 adapter，并在每次调用参数解析后核验 server；省略 server 也只能枚举此视图。不能仅凭 mcp__A__tool 的授权推定可读 A 的全部资源，更不能访问 B。若首轮 child 尚无 server-scoped resource 授权表达，就不授予 child 这些通用工具，不能用宽泛 name allowlist 凑合。

**4. MCP 错误必须接入执行确定性，不只是显示红色。**

当前 `packages/agent/src/types.ts::AgentToolResult` 无 main 新增的 structuredContent/isError；错误通过 AgentToolError 表达，并区分 not_started/confirmed/unknown。`AgentSession::_installTaskRecoveryHooks()` 根据 contract 记录可重试保证和 executionOutcome。直接复制返回 `{isError:true}` 的 main adapter，当前执行器不能据此得到正确错误语义。

方案：一期保持现有结果类型；MCP 明确返回 isError 时转换成携带必要内容/详情的 AgentToolError，只有在已收到并确认协议结果的边界标记 confirmed。confirmed 不是「没有副作用」。连接失败或取消只有证明尚未发送才是 not_started；发送后断线、超时、取消不能证明远端未执行，保持 unknown，暂停/核验，不自动重放。不要统一 catch 后标成 confirmed。

MCP 工具默认 `contract.sideEffects: external`，没有 replay/retry 保证。服务端 readOnlyHint/idempotentHint 是不可信提示，不直接升级为 ToolContract.readOnly/idempotent。资源请求的本地临时文件写入等副作用也必须在 contract 设计中考虑。保留 main 对连接/资源可重试、tools/call 不泛化重试的区别；session-expired 等明确未处理请求的例外须单测证明。

structuredContent 用于直接调用时按内容预算转换成文本或全文文件引用，不把完整 raw result 无界重复塞进 details/session；outputSchema、原始结构化返回和嵌套调用支持留待 codemode 另行设计。

**5. 恢复工具声明不能照搬 main 的新会话架构。**

easy-pi 已有 `extensions/wrapper.ts` 捕获新增工具到 addedToolNames，agent-loop 持久化该字段，compaction 的 context-identity 也纳入它；这不等于已完成恢复。main 用 system message 的 toolsAdded + pendingToolNames 恢复；两边的持久化/compaction 链路不同。

方案：用当前 branch-visible history 恢复已发现名称，pending 集合等待 MCP 注册，恢复时再与 live allowed/hidden/exclude 相交；tree、fork、resume、reload 不能跨分支泄漏，也不能因为凭据/服务重新连接而扩权。验证 compact 后状态仍足够重建。已有 addedToolNames 可复用为证据，不能只在内存 setActiveTools 就宣称持久化完成。

**6. Built-in 扩展、配置信任和实例路径需要适配。**

保留 `createBuiltInExtensions(agentDir, ...)`、background-tasks、web-search、easy-pi native collaboration，不用 main 的静态 builtInExtensions 数组覆盖。main loader 的 replaceable/builtin 与 `builtin:mcp` 配置机制需按当前 loader 接入；第三方注册 /mcp 时内置实现应退让，避免双连接。

当前 `trust-manager.ts::TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 没有 mcp.json，需要加上，保证只有 `.pi/mcp.json` 的项目也经过既有 project trust。Full Access 不等于自动信任仓库内的进程启动指令或 `!command` 凭据解析。

main MCP 使用 `getAgentDir()` 作为若干默认值，而 easy-pi SDK/child 支持实例 agentDir；配置、mcp-auth.json、refresh locks、mcp.log 都应沿工厂注入同一个实例路径。main OAuth HTML import `@earendil-works/pi-ai/utils/oauth-page` 在当前 pi-ai exports 中不存在；当前页面实现在 `packages/ai/src/auth/oauth/oauth-page.ts`，须最小新增合法导出或本地桥接，不迁移整个 ai auth 模块。

main 的 AuthUrlComponent、VisualLinePreview、truncateMiddle、writeOutputFile 等辅助能力在当前扫描范围没有对应实现；管理界面/结果预览应复用已有 TUI API并补齐必需小组件，而不是顺带迁移 upstream TUI。SDK 自定义 loader 仍由 host 决定是否加载 MCP，不能悄悄启动所有服务。

**7. 包装成功与 workspace 成功是两个验收点。**

root package.json 的 build 顺序当前没有 mcp；`scripts/pack-easy-pi.mjs` 的 internal 白名单也没有它，且目前内部打包只复制 dist/package.json/LICENSE。新增包必须接 root build/离线 build、TypeScript/测试/loader 解析、coding-agent dependency、shrinkwrap/install-lock 和 easy-pi pack；同时显式携带 MCP LICENSES 文件。`dfbb4a21e` 是 main 对本地发行遗漏新包的修复，证明不能仅在 workspace 中跑通。

### 推荐目标链路

```text
可信全局/项目配置 + extension registrations
          ↓（实例 agentDir/cwd，受限视图）
MCP runtime：stdio / HTTP + OAuth + 生命周期
          ↓
MCP ToolDefinition：命名、schema、内容预算、错误确定性
          ↓
easy-pi 现有 registry / tool_call / tool_result / recovery hooks
          ↓
allowed 内的 direct 声明，或 deferred → tool_search → 声明
          ↓
root / child 执行时再次核验 live 权限
```

不增加 MCP 专用调度器、第二套会话日志或绕过现有 hooks 的执行通道。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户所说 main 是已核验 origin/main；easy-pi 目标为当前 my-pi 工作分支，而不是把提交移到 easy-pi/main。实施前需重新确认基线及并行恢复改动已稳定。
- Assumption: 一期不要求脚本批量调用 MCP。建议 direct/deferred 足够交付基础功能，codemode 非强制依赖；如目标是与 upstream 默认 codemode 行为完全相同，范围将显著扩大。
- Decision: 用户授权按方案实施；一期默认 deferred，显式 codemode/autoEnableCodemode 报不支持，不静默解释成其他模式。
- Decision: 一期 child 没有通用资源授权，显式 resourceServerScope=[] 并阻止 generic resource 工具委派；未暗中扩大名称授权。
- Open question: 是否未来需要 auth.provider、Radius、CIMD。当前建议不取；CIMD 不能直接冒用 pi.dev 上游客户端身份。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

本轮方案验收：

- 能指出 MCP 引入提交、main 当前 tip、重要后续修复，以及与独立客户端/extension/codemode 的关系。
- 对严格 tools 白名单、child factory/live 权限、resource server 范围、恢复与打包的冲突给出代码依据和最小解决方向。
- 后续任务有明确边界、依赖、验收和验证；未实施部分保持 pending。
- 不修改产品代码、安装依赖、使用真实 provider/MCP 凭据或切换分支。

第一期实施验收：

- stdio 和 Streamable HTTP MCP 可连接、发现、执行、显示文本/图片/资源；不支持的协议明确报错。
- tools/excludeTools、动态注册、搜索、resume/reload/tree/fork 及委派不会扩权；hidden/撤销工具不可调用。
- 慢服务器不冻结首轮或 /mcp；退出清理连接、子进程、回调及锁，刷新结果已持久化。
- 已发送调用的不确定失败不自动重放；服务声明 hint 不自动获得安全重试保证。
- user/global/project/SDK agentDir 隔离；项目 MCP 只在既有信任规则下加载；child 不发起浏览器登录。
- 保留 background tasks、web-search、native collaboration、当前 compaction/recovery。
- easy-pi 独立安装包在 workspace 外运行且带齐 MCP 包/许可证；定向本地测试通过，无付费 API。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → {T-002, T-008, T-009, T-010} → T-003 → T-004 → T-005 → T-006 → T-007。T-003 依赖前三个源码单元全部通过其边界验证。
- Parallel batches: 第一批协议包(T-002)、通用扩展接口(T-008)、MCP adapter(T-009)互不写同一文件；coordinator 独占任务文档、agent-session、产品入口和锁文件。后续按主链串行集成。
- Serialization constraints: agent-session 与已存在 recovery 改动采用新鲜读取后的精确补丁；extension API/loader 仅 T-008 写，MCP/tool-search 仅 T-009 写；任何 agent 不修改共享锁文件或提交代码。
- Internal milestones: T-003/T-004 为 direct 内部验收，不是正式发布；T-005/T-006/T-007 完成后才可发布一期，避免把 child 能力缺口藏起来。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 调查 main 更新与 easy-pi 接口，完成移植方案

- Status: done
- Owner: coordinator
- Objective: 形成有来源的技术结论与分阶段移植边界。
- Inputs and prerequisites: 用户分析请求、pi/AGENTS.md、origin/main 与当前 easy-pi。
- Scope or files: 本文档；只读代码、提交、相关文档。
- Expected output: 固定基线、功能/依赖表、兼容风险、实施顺序和验收方案。
- Dependencies: None.
- Execution steps:
  1. 核验 branch/remotes/status 和远端 main SHA。
  2. 读取 main MCP 文档、实现和后续修复；对照 registry、恢复、child 和打包。
  3. 在本文档记录证据、非目标和未来实施任务。
- Acceptance criteria:
  - 本轮方案验收项全部覆盖，且没有实施代码。
- Verification method:
  - 复查关键符号、历史和状态；运行 task document validator。
- Validation evidence: git ls-remote 确认 main SHA；git show/diff 和代码阅读确认本文分层、allowlist 例外及 child/恢复接口；文档校验结果见末尾。没有运行产品测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 引入独立 MCP 客户端和上游修复

- Status: done
- Owner: mcp-client
- Objective: 获得不依赖 easy-pi agent 重构的协议层。
- Inputs and prerequisites: T-001、用户实施授权、固定 main SHA。
- Scope or files: packages/mcp/ 源码、包配置及协议测试。root 构建/解析/锁文件由 coordinator 在集成阶段独占处理。
- Expected output: 与 main tip 协议行为一致的 workspace 包，保留 MIT 来源与 LICENSES。
- Dependencies: T-001.
- Execution steps:
  1. 引入源码/测试/fixtures并适配内部版本，不仅依赖 npm 1.1.0 标签。
  2. 接工作区构建与解析；依赖精确锁定，不运行 lifecycle scripts。
  3. 验证 stdio、HTTP、OAuth issuer 拒绝路径与取消。
- Acceptance criteria:
  - c5f5b3282 安全修复存在；协议测试与许可证完整。
- Verification method:
  - 包内逐文件定向 Vitest；local/mock endpoint，不使用真实服务器凭据。
- Validation evidence: coordinator 复跑 packages/mcp 的五个定向文件：43/43 通过；tsc --noEmit 通过；固定 SHA 逐文件比较只 package.json/vitest.config.ts 两个适配差异。MCP build 已启动，协议源码/安全修复与许可证已核验。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 最小 core 接口与 direct MCP adapter

- Status: done
- Owner: unassigned
- Objective: 让 MCP 经现有工具和恢复 pipeline 直接调用，先证明权限和错误语义。
- Inputs and prerequisites: T-002、当前 recovery 并行改动已稳定。
- Scope or files: coding-agent/core/extensions 的 types/loader/runner、core/mcp-servers.ts、agent-session registry、tools wrapper、extensions/mcp 的 config/runtime/tools/resources、trust-manager.ts。
- Expected output: 严格 allowlist 的 direct/hidden MCP 基础链路及实例路径注入。
- Dependencies: T-002, T-008, T-009, T-010.
- Execution steps:
  1. 集成必要 MCP registry/exposure/namespace/annotations 接口，不取 prepareLoadout/executeTool。
  2. 适配错误为 AgentToolError 和执行确定性；默认 external、不可信 hints 不升级 contract。
  3. 接 config/trust/后台连接，保留名称消歧、内容预算和取消/关闭修复。
- Acceptance criteria:
  - direct call、hidden、撤权、MCP isError、发送后断线/超时都表现正确。
  - no-tools/严格 tools 下禁止的 MCP 不可调用；已有非 MCP 工具行为不变。
- Verification method:
  - faux provider + in-memory transport；known error/unknown effect 故障注入。
- Validation evidence: coordinator 最终 12 文件/163 项 MCP 定向测试通过，覆盖 direct、严格 wildcard/exclusion、hook、known isError、原 unknown suspended task 与重复副作用拒绝；npm run build:offline 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — CLI、OAuth 和管理界面接入

- Status: done
- Owner: unassigned
- Objective: 完成用户可配置、诊断、登录和管理的 surface。
- Inputs and prerequisites: T-003、已确定支持 direct/deferred/hidden 的产品范围。
- Scope or files: extensions/index.ts 与 mcp/index.ts/ui.ts/cli.ts/oauth.ts、main.ts/cli/args.ts、resource-loader/loader、必要 OAuth 页面导出和文档。
- Expected output: epi mcp add/remove/list/login/logout、/mcp、--no-mcp、替代扩展退让。
- Dependencies: T-003.
- Execution steps:
  1. 将 MCP 加入现有实例 built-ins，不替换 easy-pi/background/web-search。
  2. 迁移 token store/refresh locks/回调清理，排除 provider-token 转发和 pi.dev CIMD。
  3. 接当前 TUI，慢连接时 manager 仍可操作；shell 命令不加载 extension。
- Acceptance criteria:
  - Esc/quit/reload 结束登录和连接；不同 agentDir 不串配置、凭据或日志。
  - 第三方 /mcp 接管后内置不产生第二套连接；不支持的 codemode 配置明确报错。
- Verification method:
  - mcp-command/store/refresh/manager 测试；本地 fake OAuth server + TUI 定向回归。
- Validation evidence: 163 项组内包含 CLI/OAuth/lifecycle/product-loader 回归；独立安装包外 CLI --help/--version/mcp add/mcp list smoke 通过；SDK agentDir 临时隔离，stdio/HTTP 实际调用和退出 drain 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Deferred 发现与分支恢复

- Status: done
- Owner: unassigned
- Objective: 支持不预先声明大量 schema 的工具发现，保持授权和历史一致性。
- Inputs and prerequisites: T-004、direct pipeline 已验证。
- Scope or files: extensions/tool-search/、core/agent-session.ts、extensions/wrapper.ts、session/compaction 中相关声明投影及测试。
- Expected output: allowed 内的 BM25 搜索/加载、pending 注册恢复、最终默认 deferred。
- Dependencies: T-004.
- Execution steps:
  1. 区分 allowed、discoverable/callable、declared；不引入 main 的 MCP allowlist 例外。
  2. 复用 addedToolNames 或现有声明记录，按 branch 恢复，等待 MCP 注册再激活。
  3. 覆盖 compact/tree/fork/resume/reload 后的声明与权限。
- Acceptance criteria:
  - tools:[read,tool_search] 不能发现未授权 MCP；explicit exclusion 在恢复后仍有效。
  - 分支工具加载不串分支，服务迟到注册不制造额外授权。
- Verification method:
  - faux suite 断言 provider 实收 schema、工具调用结果及 persisted branch 状态。
- Validation evidence: mcp-tool-exposure-history 18 项通过，包含晚注册、resume/reload、branch/fork、实际 faux compaction；严格授权搜索和曝光转换通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Native child 的 MCP 能力与资源范围

- Status: done
- Owner: unassigned
- Objective: 使子 agent 仅使用父级明确授权的 MCP，发现不扩权，撤权实时生效。
- Inputs and prerequisites: T-005、child resource 范围契约已确认。
- Scope or files: pi-child-session-host.ts、pi-collaboration-root/tools/context.ts、subagent controller/contract 的能力查询接点及 MCP 受限配置视图。
- Expected output: 显式 child MCP factories、授权目录查询、server-scoped resource 视图、独立生命周期。
- Dependencies: T-005.
- Execution steps:
  1. 在 child loader 注册受限 MCP/tool-search，使用父级批准配置，不二次扩大发现。
  2. 更新 admission/follow-up/live guard 的能力来源；发现只改声明，保持 ancestry 交集。
  3. 校验 resource server 参数与省略 server 的枚举范围；验证 prefix-preserve 拒绝路径。
- Acceptance criteria:
  - 显式白名单和 inherit 不扩大父级有效权限；root 撤销立即拒绝后续 child 调用。
  - read_mcp_resource 不能越过受限 server 视图；未实现 scope 则不向 child 授予此工具。
  - close 一个 child 不影响 root/其他 child；child 不启动浏览器登录。
- Verification method:
  - 两个 mock MCP server + native child faux tests；撤权、迟到注册、follow-up 和 dispose 故障注入。
- Validation evidence: agent-session-mcp-child 与 product-loader 12 项通过；新增真实 root/controller 生产回归验证 startup grant、approved runtime config（外部文件漂移不被消费）、无未授权服务器及资源范围泄漏；配套调用/撤权/follow-up/独立关闭回归通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 打包、定向回归与发行门禁

- Status: done
- Owner: coordinator
- Objective: 证明移植不仅在 workspace 中成立，独立 easy-pi 产物也可用且无核心回归。
- Inputs and prerequisites: T-006、构建/产物 smoke 验证获得用户授权。
- Scope or files: scripts/pack-easy-pi.mjs、local-release/install/shrinkwrap 脚本、package/lock 元数据、MCP 和 easy-pi 定向测试及文档。
- Expected output: 带 mcp dist/dependencies/LICENSES 的产物和实际测试记录。
- Dependencies: T-006.
- Execution steps:
  1. 补 easy-pi internal package 白名单及 LICENSES 复制，生成并核对锁文件。
  2. 运行定向协议、会话、恢复、协作、UI 回归；保留已有用户改动。
  3. 获授权后在 workspace 外进行本地 stdio/HTTP mock MCP 的 Node/Bun 产物 smoke。
- Acceptance criteria:
  - 定向检查通过，--no-mcp 启动路径不加载/连接 MCP。
  - 包外启动、MCP 调用、OAuth mock、进程退出均通过；缺平台验证如实记录。
- Verification method:
  - 包内定向 Vitest、代码修改后的 npm run check、获授权的本地产物 smoke；不跑全 npm test。
- Validation evidence: coordinator npm run check 全通过（formatter/pins/imports/shrinkwrap/install-lock/tsgo/browser）；offline build、pack/独立安装、包外 CLI/SDK stdio+HTTP+清理 smoke、pack fixture 3/3 通过。仅 MCP ownership patch 已暂存，纯 index 快照补齐已有 ignored 模型 JSON 后 tsgo 和 163 项 MCP 测试通过；MCP 功能已提交 d22113e47；未混入并行恢复源代码。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 通用扩展 MCP 注册与 exposure 接口

- Status: done
- Owner: mcp-core-api
- Objective: 在现有 extension runtime 中新增 MCP registration、exposure/namespace/annotation 元数据，不改变已有执行契约。
- Inputs and prerequisites: T-001 的固定 main 快照和当前扩展实现。
- Scope or files: core/mcp-servers.ts；core/extensions/types.ts、loader.ts、runner.ts、index.ts 及独立接口测试。禁止改 agent-session、SDK、产品入口、锁文件。
- Expected output: 可供 adapter 使用的注册/查询/变化事件接口；仅 direct/deferred/hidden/model-only exposure。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取当前扩展文档和对应模块，最小复用 main 注册机制。
  2. 补核心 metadata 和 runtime 类型，不取 codemode/nested execution。
  3. 定向验证 registration ownership、配置拒绝和 change event。
- Acceptance criteria:
  - 当前工具/扩展 API保持可用；不支持配置明确拒绝；无需 MCP 协议包即可验证核心注册。
- Verification method:
  - 定向扩展/配置测试及 scoped static validation。
- Validation evidence: 配置/注册/ownership/change event/source rollback 与 runner 的 one-shot drain 测试纳入 coordinator 最终 163 项全过；source 编译与独立包 smoke 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 移植无 codemode 的 MCP adapter 源码

- Status: done
- Owner: mcp-adapter
- Objective: 复用固定 main 的连接/OAuth/CLI/管理逻辑，拆除 codemode 耦合，适配现有结果和实例路径。
- Inputs and prerequisites: T-001 的完整 main 快照；本计划结果确定性和白名单约束。
- Scope or files: extensions/mcp/、extensions/tool-search/、必要新增 UI/输出小辅助文件和 MCP 单元测试。禁止改已有 core/SDK/main、pi-ai exports、package 元数据/锁文件。
- Expected output: MCP factory 接受 agentDir 与受限配置视图；default deferred；无 codemode/provider-token/CIMD；AgentToolError 适配。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取相关 docs和源码，复用 main current 修复。
  2. 明確 unsupported config 和错误确定性；将 OAuth 页面本地桥接，不依赖缺失 pi-ai export。
  3. 增加本地 adapter/CLI/OAuth 回归，接口依赖就绪后交给集成验证。
- Acceptance criteria:
  - 无绕过 tool hooks 的执行路径，无真实凭据；连接关闭/登录取消/受限配置可测。
- Verification method:
  - MCP adapter/CLI/OAuth 定向单元测试；最终 integration 由 T-003/T-004 完成。
- Validation evidence: 五个 MCP adapter 测试文件 46 项通过，已由 coordinator 最终 163 项组合复跑；包含 OAuth、CLI、输出、连接与收尾；单独打包后的真实 stdio/HTTP 调用通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 会话授权/exposure 与 deferred 恢复接线

- Status: done
- Owner: mcp-session
- Objective: 将通用工具 metadata 接入现有会话，严格过滤、按需声明并从当前分支恢复。
- Inputs and prerequisites: T-001；当前 session 源码和 T-008 公共接口约定。
- Scope or files: core/agent-session.ts 与专用 session/exposure regression tests；禁止修改扩展 API、SDK、adapter 和锁文件。
- Expected output: getToolAccess/getDelegatableToolNames、exposure 过滤、pending discovered names、分支恢复。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取当前 agent-session；保留所有已有 recovery dirty changes，只做精确区域编辑。
  2. 接严格 matcher、工具 metadata、context access getter、deferred discovery/恢复。
  3. 用自定义 fake tools 验证 root权限、动态注册、resume/tree/fork/reload，无需等待 adapter。
- Acceptance criteria:
  - 未授权/hidden 工具在 registry/schema/执行中不可用；发现不扩权；历史恢复只取当前 branch。
- Verification method:
  - faux suite 定向测试和关键变更 diff 审核。
- Validation evidence: coordinator 最终曝光/恢复测试与 MCP 实际调用全过；getToolAccess/getDelegatableToolNames 与 trusted host setter 接线已编译、在生产 root/controller 回归中验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Native child MCP 与产品 loader 集成回归

- Status: done
- Owner: mcp-client
- Objective: 独立补齐 child 与 built-in loader 的功能/权限回归，验证 coordinator 接线。
- Inputs and prerequisites: T-001 和 T-002；已约定的 MCP factory/session API。
- Scope or files: 新建 test/suite/agent-session-mcp-child.test.ts、test/mcp-product-loader.test.ts 和必要专用 fixtures；不修改产品代码或既有测试。
- Expected output: 本地模拟 child 生命周期、严格授权/撤权、无 resource scope、替代 extension/no-mcp 的实际断言。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 读取当前 child host 与现有测试，复用 faux provider 和本地 MCP fixture。
  2. 增加有授权调用、拒绝、撤权、follow-up 和独立关闭断言。
  3. 在集成接口稳定后运行该组文件，报告真实结果。
- Acceptance criteria:
  - 无真实凭据/外部调用；断言真实 transport/调用行为，不只看 schema。
- Verification method:
  - 定向 Vitest；coordinator 复跑与 diff 审核。
- Validation evidence: coordinator 最终复跑 child/product-loader 两文件 12/12 通过，包括真实 bindNativeSession/registerPiCollaborationRoot/controller 调用，不仅依赖注入的测试 callback。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 生命周期与移植安全回归修正

- Status: done
- Owner: coordinator, mcp-core-api, mcp-session, mcp-adapter
- Objective: 修复独立审阅和集成测试实际暴露的生命周期/授权边界问题，不降低验收断言。
- Inputs and prerequisites: T-001；独立只读 mcp-safety-review 与 coordinator 定向测试证据。
- Scope or files: runner 的一次性 session_shutdown、session shutdown/工具二次授权、MCP runtime/index 迟到回调与当前配置视图，以及专用回归。
- Expected output: SDK shutdown 真实等待 cleanup；hidden/撤权不能被迟到注册/已 prepare 调用绕过；child 配置来自 root 当前 runtime 而不是重读新文件。
- Dependencies: T-001.
- Execution steps:
  1. 对每个问题确认真实触发路径，再在原 owner 文件中最小修正。
  2. 保留 unknown-outcome 与副作用次数断言；查明 latest task 为独立核验 successor 时，回归按 original task ID 检查 suspended 未知记录及重复调用拒绝，不移除现有自动核验机制。
  3. 单测和全链回归验证后接受，不能用放宽断言替代修复。
- Acceptance criteria:
  - shutdown 不双发且所有 caller 等待同一 drain；迟到注册/准备调用不能扩权。
  - 远端已发送失败的原任务保持 needs_reconciliation/unknown；不得重放。现有 native driver 可以启动独立核验任务，不能将最新核验任务的完成误认成原操作已确认。
- Verification method:
  - fake slow/disconnected server、deferred events、直接 SDK关闭、多 caller/child 的定向回归。
- Validation evidence: 完整 163 项 MCP 组通过；SDK shutdown 7 项（外部触发重入/跨实例/异常/真实 transport）、deferred/hidden→direct、注册移除迟到 close、expired client 所有权与 stale notification、生产 child bootstrap/approved config 均有回归。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — 用户授权的最终测试类型适配

- Status: done
- Owner: mcp-core-api
- Objective: 只修复全仓检查中的十个测试类型错误，不改恢复行为或削弱断言。
- Inputs and prerequisites: 用户已通过 structured question 选择「限定修复并完成提交（推荐）」；task-15 的全仓类型诊断。
- Scope or files: agent/test/harness/io-certainty.test.ts、ai/test/retry.test.ts、coding-agent/test/suite/regressions/b824062c-io-certainty.test.ts 和 b824062c-recovery-driver-contract.test.ts；只改必要类型/假数据。
- Expected output: 精确类型适配、真实检查结果、相对原 dirty 基线的 ownership patch。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取四个测试和实际类型签名，快照编辑前状态。
  2. 精确修复类型与假数据构造；不使用 any/ts-ignore 或删除断言。
  3. 运行四个定向测试与 tsgo；其余行为失败只报告，不擅改。
- Acceptance criteria:
  - 十个类型错误消除；既有测试含义不变；其他会话代码保留。
- Verification method:
  - 全仓 tsgo、四个定向测试、ownership diff审核；coordinator 最终 npm run check。
- Validation evidence: 四个文件合计 10 TS 错误已精确适配，未修改任何断言/恢复行为；tsgo 通过；coordinator 全仓 npm run check 通过；agent 定向 2+2+12+176=192 项测试全通过，ownership diff 已审核。类型适配保留在相应并行测试工作文件，未混入 MCP 代码提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

本轮只验证方案事实与文档结构，不声称功能已验证。后续最低测试矩阵：

1. 协议：stdio 初始化/分页/progress/abort/process-tree cleanup；HTTP session/SSE 响应流重连（不是 legacy SSE transport）、auth、过期 session。
2. 配置与信任：仅有 .pi/mcp.json 也触发 project trust；override/collision/非法条目；SDK 自定义 agentDir；env/headers/!command 不从未信任项目执行。
3. 授权：tools/exclude/hidden/动态注册/tool_search/历史恢复/child ancestry；不采纳 main 允许 unnamed MCP 的测试期望。
4. 确定性：业务 isError 为已确认错误；发送前失败与发送后断线/timeout/abort 分类不同；无保证 MCP 副作用不自动重放。
5. 恢复：发现 → compact → resume，发现 → tree/fork，reload 时延迟连接注册；只恢复当前 branch 且重新核验授权。
6. 子 agent：root 和两个 child、受限工具和资源服务、follow-up、root 撤权、preserved prefix、独立 dispose；未授权 server 不出现在搜索/资源列表。
7. OAuth：issuer mismatch/缺 metadata + iss 拒绝、PKCE/state、轮换 token 并发刷新、权限升级、Esc/quit、回调及刷新锁清理；全用本地 fixture。
8. 产物：workspace 外加载 pi-mcp、许可证、--no-mcp、mock stdio/HTTP；授权后再构建，不借真实 API 证明正确。

依仓库规则按 package root 执行定向 Vitest；编码后 npm run check 会自动改文件，须核对范围并保留他人改动。构建/全 npm test 非默认操作；真实模型/凭据不在本计划授权内。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 用户已授权实施；codemode 仍不在一期，child 通用资源工具在没有明确 server scope 的 API 前默认不授予。
- core recovery 与 collaboration 文件正在被其他会话修改；实施需先固定新基线，再重新核对本方案接口，不在共享 cwd 做大块覆盖。
- 上游 1.1.0 版本号不能证明包含 Unreleased 安全修复；按 SHA 选取代码，再适配 easy-pi 内部版本。
- stdio 进程默认继承 host 环境，具有进程权限；MCP roots 是告知而不是文件系统隔离。不能把工具白名单宣传成系统 sandbox。
- readOnlyHint 等只是远端声明；服务 instructions/description/results 属于不可信数据，不成为 host 权限或重试保证。
- 一期不带 codemode 是刻意范围裁剪，不能宣传与 upstream 默认配置完全兼容。
- 每 session 自有 transport 可能增加子进程/连接数量；当前无测量，不预设共享池优化。
- 协议/本地模拟服务器/产物验证已通过；真实第三方互通、人工 TUI 和 Bun binary 仍未验证。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 功能提交 d22113e47 完成；按 HEAD+MCP 暂存树构建并重新打包 commit-package（shasum 58752a12da3e0e6cd3945b3bd584c8b6254bcbce），隔离重新安装后 CLI/SDK stdio/HTTP/清理 smoke 再次通过。所有 T-001 至 T-013 完成；最终文档校验通过后提交收尾文档。其他会话工作和授权测试类型适配留在工作区，未混入功能提交。

- 2026-10-11: T-013 精确类型/假数据适配经审核接受；全仓 check 全通过、192 项授权测试全过。暂存只含本任务 MCP/new tests/metadata；AgentSession 与 pi-collaboration-tools 按 ownership patch 从 HEAD 合成，排除并行恢复改动。纯 index 快照（补齐已忽略模型 JSON）tsgo 与 163 项 MCP 定向测试通过。新增两条已验证 LEARNS，仅暂存本任务追加，未包含其他会话日记。

- 2026-10-11: 用户确认限定处理四个测试文件的类型/假数据以完成检查和提交；T-013 开始，未授权改变恢复行为或弱化断言。Node 包外 CLI/SDK stdio+HTTP smoke 通过；独立 browser smoke、pack 3/3、diff --check 通过。

- 2026-10-11: 原计划实现 T-003/T-004/T-005/T-006/T-008/T-009/T-010/T-011/T-012 经 coordinator 163 项组合回归和编译/包外 smoke 接受，标 done；T-007 标 blocked（全仓 10 TS errors 均位于既有并行恢复测试，未修改它们）。隔离安装第一次 offline cache miss 后正常安装成功，全程 ignore-scripts；无真实凭据/付费 API。
- 2026-10-11: 新 MCP 文档按真实 product-identity 明确默认目录 .epi；功能配置统一使用 CONFIG_DIR_NAME。npm run check 自动格式化的 tracked 漂移仅本任务负责的七个文件，既有 tracked 恢复/AI/harness diff 未被格式器更改。

- 2026-10-11: 协议 T-002 经 coordinator 43 项测试与源码比对接受；T-011 child/product-loader 回归开始。pack 测试补 MCP/许可证后 3/3 通过；npm lock 更新产生的无关 pi-codex-accounts 裁剪已恢复，只保留 MCP metadata。当前 session 存在外部并行恢复接线不完整，记录 `_taskRecovery.rebindQueuedReceipts` 尚无实现，不删除调用或冒充 MCP 故障。
- 2026-10-11: 独立审阅触发 T-012：当前 mcp 注册定义表未更新为 hidden，直接 SDK关闭漏 extension shutdown、等待期 prepared-call 撤权风险；另确认 child 配置重读与 root runtime 可漂移，改为当前 runtime 受限视图。协议 build 通过、pack fixture 3/3。集成 8/9 通过；唯一 unknown-drop 失败已证明 adapter outcome=unknown，journal hook 后为 needs_reconciliation，随后被改 completed，正在定位 native continuation 首分歧。
- 2026-10-11: unknown-drop 失败根因是测试误把 latest task 当 original：日志显示原任务 suspended needs_reconciliation/no result，完成的是 task-interruption-recovery successor。已纠正验收对象并增加重复副作用拒绝断言；没有修改 adapter 确定性或用户现有恢复机制。真实 production child 回归另定位 bootstrap循环：controller child live getter仅看已注册工具，导致已授予但尚未连接的 MCP 名称被撤权；仅对 child 的具体未注册 MCP grant 保留 bootstrap，仍交集所有祖先/root。
- 2026-10-11: 用户授权实施；复核 HEAD/main 未变，已有恢复相关 dirty files 已记录，不纳入本任务提交。Mode 改 execute；T-002/T-008/T-009 开始并行，coordinator 独占共享接线和锁文件。
- 2026-10-11: 将会话通用机制拆为 T-010 并开始；mcp-session 独占 agent-session 的本任务修改，保留原 recovery 补丁。root 先接 MCP 包映射/build/bundle 元数据，避免与其重叠。

- 2026-10-11: 确认 analysis/plan 模式；读取 pi/AGENTS.md；观察现有并行未提交改动。
- 2026-10-11: 核验远端 origin/main 为 e37cdc420；定位 8562bcf66 与后续 MCP 修复。
- 2026-10-11: 多 merge base 的三点 diff 给出警告；改为提交详情与指定文件 tip 对照，不据此扩大合并范围。
- 2026-10-11: 读取 main MCP 分层实现与当前 registry/recovery/child/pack；确认 strict allowlist 冲突和 resource server 参数范围。
- 2026-10-11: 创建并填写本文档；T-001 完成，其余任务待授权；没有实现、安装、产品测试、构建或子 agent 执行。
- 2026-10-11: 文档校验发现 Overall status 不接受 partial，已改为 pending（尚未开始实施）；final Result 保留 partial。随后 task_document.py validate 通过；main/HEAD SHA 复核未变。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 协调端协议 43/43、MCP 集成 163/163、pack fixture 3/3 均通过；offline build 通过。独立 tarball 位于 `/tmp/easy-pi-mcp-delivery.cGjc3r/commit-package/easy-pi-0.1.0-beta.1.tgz`，npm 安装到包外 install，CLI help/version/add/list 和 SDK stdio/HTTP 实际执行及退出清理 smoke 通过。验证日志 task-15（全仓 check）、task-16（build）、task-17（163 tests）、task-18（pack）、task-20（install）、task-21（smoke）均为真实工具输出。
- Limitations: 全仓 check 的 10 个测试类型错误已按用户授权修正，检查通过；MCP 功能提交 d22113e47 已完成，其他会话代码仍未提交；Bun 未安装，Bun binary 未验证；真实第三方 MCP/OAuth/付费 provider 与人工 TUI 操作未运行。MCP 第一阶段实现、Node 产物、全仓检查、纯暂存树验证与功能提交已完成。
