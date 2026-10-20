# Task Plan: 旁聊继承父会话完整工具权限

- Created: 2026-10-20
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户明确确认移除旁聊只读限制，继承父会话全部已授权工具，保留父策略、缓存、独立内存对话和关闭清理；离线验证并提交，不自动push。

<!-- task-doc-section:background-goal -->
## Background and goal

实施前/side、/btw仅开放标准本地只读工具，不符合用户期望的Codex式等权旁聊。改为继承父会话完整工具权限，包括写入、命令、MCP、子代理；不是绕过父会话限制。共享工作区的写入可见性和并发冲突已向用户说明并确认。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：旁聊执行注册表、父策略传播、工具资源归属及必要接线、回归测试、UI/用户文档与changelog。保留冻结provider前缀、独立session/request identity、内存transcript、无自动对话合并、hide/abort/close语义。非目标：绕过父策略、真实付费API、缓存命中承诺、自动push、任意修改用户配置。保留AI包三项现存外部改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户确认等权继承全部父授权，不绕过父限制；允许共享工作区变更。 | 结构化确认confirm_full_side_permissions |
| F-002 | 实施前白名单仅read/grep/find/ls及本地codemode；旧boundary明确禁止写入/MCP/子代理。 | 基线packages/coding-agent/src/core/side-conversation.ts |
| F-003 | AgentSession已提供getToolDefinition、getDelegatableToolNames及liveToolAccessCheck接口。 | packages/coding-agent/src/core/agent-session.ts及sdk.ts |
| F-004 | 开始时分支main，工作区仅AI provider/CHANGELOG/新测试三项外部改动。 | 初始git status --short |
| F-005 | 全权限旁聊实现已提交aec45be1d，仅包含11个自有源码/测试/用户文档路径。 | task-13 git commit成功，无push |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已确认：完全权限指与父会话等权，不是绕过父授权；不自动push。
- 已验证：扩展工具从已批准factory重新绑定，MCP独立连接继承批准配置，团队为旁聊独立内存root；不复用父会话执行包装。
- 显式限制：SDK函数及扩展factory外部/module级闭包仍属宿主，不能自动克隆。父策略最终执行，本地和父owner hooks可能重复变换，未知/不匹配情形保守拒绝，不宣称任意扩展均语义透明。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 旁聊可执行父会话允许的write/edit/bash、自定义/MCP及子代理工具；codemode遵守同一权限。
- 父策略仍执行；撤销授权（含异步hook等待期间）后不得执行，未授权/新出现的能力不得自动扩权。
- 工具执行不改变父消息、队列或原生身份；旁聊自有后台工作与输出在关闭时drain，用户工作区成果不删除。
- provider instructions/tools/messages继承前缀与cache routing仍保持既有约束，无付费预热或真实API测试。
- 修改测试、定向邻近测试、npm run check及diff检查通过，仅提交自有文件，不push。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 依赖串行；T-001可分派只读文档/架构核查，协调器独占代码与计划。
- Serialization constraints: 不并发编辑共享文件；独立审查在实现冻结后进行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 核查工具继承与资源边界

- Status: done
- Owner: coordinator
- Objective: 确定最小完整工具绑定方案，避免父会话状态污染。
- Inputs and prerequisites: 已确认契约、现有side/SDK/工具注册表。
- Scope or files: 只读README/docs/sdk.md/docs/extensions.md及工具/扩展/子代理接线；本计划。
- Expected output: 源码支持的实施边界和测试oracle。
- Dependencies: None.
- Execution steps:
  1. 阅读完整相关文档和拟修改源码，定位原始ToolDefinition及session context绑定。
  2. 明确内置/扩展工具、codemode、后台任务和子代理资源归属。
- Acceptance criteria:
  - 不把父execute闭包错误当作独立session执行。
- Verification method:
  - 源码调用链和离线测试设计核对。
- Validation evidence: 完整读取side/SDK/loader/codemode/MCP源码；只读docs子代理完整读取README、SDK、extensions及相关mcp文档与工具/团队源码。已证明ToolDefinition ctx不能重绑captured pi，团队session-ID保护禁止复用父team闭包。方案：loader保留已批准factory并重新实例化拥有授权工具的扩展；内置工具和codemode独立；MCP保存已批准config及原transport/credential选项，旁聊新实例/连接，不重新发现配置；SDK raw工具闭包仍属embedding，传旁聊ctx。旁聊team独立内存root并关闭自有children，不操作父team。发现后的新schema仅从side tool-search receipts追加，首请求仍冻结前缀。未运行真实API。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现等权旁聊并固化回归

- Status: done
- Owner: coordinator
- Objective: 移除旁聊专属只读限制，保留父权限/缓存/生命周期边界。
- Inputs and prerequisites: T-001方案。
- Scope or files: side-conversation.ts、side-conversation-tools.ts、extensions/loader.ts、extensions/mcp/index.ts及必要工具接线、旁聊测试、UI标签与命令说明。
- Expected output: 最小完整实现和可执行离线回归。
- Dependencies: T-001.
- Execution steps:
  1. 绑定父授权能力至旁聊context，保留live限制和父策略。
  2. 覆盖写入/命令/自定义/MCP/子代理/codemode，以及撤权、身份与关闭。
- Acceptance criteria:
  - 全部确认能力可执行，父策略拒绝仍生效，原provider前缀不改变。
- Verification method:
  - 定向faux/mock工具与真实本地临时工作区测试，不调用付费API。
- Validation evidence: task-3四文件95/95通过；task-4完整npm run check通过；task-5隔离HOME/空环境离线14文件321/321通过。实际临时文件write/edit/bash、codemode写入与策略拒绝、SDK/扩展ctx、独立内存子代理团队与MCP新连接/批准config、后台任务归属、异步read/write撤权均覆盖。首次MCP测试因faux fixture未记录覆盖后的responses请求而失败，改为provider统一记录后通过，不把fixture错误当产品故障。独立review发现MCP服务器撤销及父策略排序缺口，协调器发现工厂失败前订阅泄漏；task-6/task-7四个确定回归在修复前失败。按实际server配置在执行时重检、父策略最后执行、未绑定runtime失败即invalidate修复后task-8两文件78/78通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 验证、文档与提交

- Status: done
- Owner: coordinator
- Objective: 完成风险相称验证与独立审查并提交。
- Inputs and prerequisites: T-002通过。
- Scope or files: 自有diff、side用户文档/README/changelog与本计划。
- Expected output: 已验证提交和明确限制说明。
- Dependencies: T-002.
- Execution steps:
  1. 跑修改测试和邻近测试、完整npm run check；检查外部文件未被改写。
  2. 冻结后独立只读审查并修复有证据问题，显式stage自有文件并提交。
- Acceptance criteria:
  - 不混入外部改动，不push，不把mock使用量当真实缓存命中。
- Verification method:
  - targeted tests、npm run check、计划validator、git diff/status。
- Validation evidence: README/旁聊文档/changelog与UI/命令说明已改为父权限/共享工作区，明确独立内存team、SDK闭包边界及不回滚效果。独立只读review两个阻断问题已红绿修复。task-9首次tsc发现新增guard测试未按toolName收窄input类型，修正后task-10完整check及14文件325项通过。随后增强codemode namespace/search/describe回归，task-11先失败（空结果导致未调用MCP），补齐旁聊codemode metadata接线后task-12完整npm run check及隔离14文件325项再通过。最终side SHA0651026d、MCP SHA f19f82f8的只读复核确认原问题已修复，未发现支持路径新缺陷。外部AI三文件hash与开始一致，git diff --check/计划validator通过；task-13显式stage 11个自有文件并提交aec45be1d成功，未push。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

仅使用faux provider、内存凭据、mock MCP/子代理及临时工作区。验证直接和codemode写入/命令、父hook拒绝与异步撤权、扩展context独立、后台任务关闭、用户成果保留、wire前缀与cache route。修改测试必须定向运行；完整npm run check全输出。不运行npm test/build或完整vitest。

最终执行命令（task-12，均exit 0）：

```bash
# repo root
npm run check
cd packages/coding-agent
env -i PATH="$PATH" HOME=/tmp/pi-side-full-no-auth NO_COLOR=1 PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
  node ../../node_modules/vitest/dist/cli.js --run \
  test/side-conversation.test.ts test/side-conversation-prefix.test.ts \
  test/grok-side-panel.test.ts test/pi-side-conversation.test.ts test/side-owned-shutdown.test.ts \
  test/codemode-extension.test.ts test/codemode-settings.test.ts \
  test/resource-loader.test.ts test/extensions-discovery.test.ts test/extensions-runner.test.ts \
  test/mcp-adapter-lifecycle.test.ts test/mcp-adapter-connections.test.ts \
  test/pi-collaboration-root.test.ts test/suite/agent-session-codemode-extension.test.ts
```

结果：14文件、325测试通过。未运行真实provider、远程MCP或服务端cache-hit评测。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 父扩展可能闭包捕获其自己的session/team/MCP资源；复用函数并传ctx不一定足以独立，必须核实。
- 父侧与旁聊并发修改同一文件可能冲突；契约已接受共享工作区，不引入worktree。
- 固定tool declarations用于缓存，执行注册表与授权要独立，不因扩大执行能力改变provider前缀。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-20: 用户确认等权旁聊契约，T-001 in_progress；未实施代码变更。基线main，AI包三项外部改动保留。
- 2026-10-20: T-001 done，T-002 in_progress。拒绝复用父AgentTool包装/团队闭包；MCP初步借用方案因lazy reconnect/cancellation生命周期共享而放弃，改为基于批准配置新建实例，保留原mock transport注入与父策略。SDK闭包边界明确：host外部状态不自动克隆。

- 2026-10-20: T-002 done，T-003 in_progress。实现全部父授权能力，task-3四文件95通过、task-4完整check通过、task-5离线14文件321通过。独立review指出父策略必须在本地hooks之后执行和MCP generic-resource撤销漏洞，协调器另发现factory失败前eventbus订阅未失效；新增四个红测（task-6/7）后修复，task-8两文件78通过。最终check/邻近回归/新SHA复核与提交待完成。

- 2026-10-21: task-10完整check及14文件325/325通过。增强namespace发现测试暴露缺失getToolNamespace/getToolGuidelines接线（task-11红），补齐后task-12完整check及同一14文件325/325通过。最终生产SHA冻结，独立review复核两处安全修复及新增测试；准备显式stage自有路径提交，不push。

- 2026-10-21: 最终只读复核确认父策略排序/MCP撤销/预绑定runtime清理/codemode metadata修复，未发现支持路径新缺陷；协调器核对最终SHA与测试版本一致。task-13提交aec45be1d成功，未push。T-003 done；本交付记录单独提交。长寿命TUI需完整重启/resume加载核心改动，/reload不足。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003均done。task-12完整npm run check与14个明确文件325项隔离离线测试通过；五处确定边界红绿回归通过。最终只读复核无新增问题，git diff --check及计划validator通过；实现提交aec45be1d，未push。
- Limitations: 不允许真实API测试，不自动push；共享工作区不回滚工具效果；SDK/扩展外部闭包状态不自动克隆。
