# Task Plan: Codemode E2E 实施

- Created: 2026-10-12
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户授权实施上一轮 E2E 设计。

<!-- task-doc-section:background-goal -->
## Background and goal
补足真实 CLI/RPC 进程链路测试，避免仅依靠预设 AgentSession 单元响应证明产品行为。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
新增离线进程 E2E 和 opt-in 真实模型 E2E；不修改产品功能。初始实施不调用付费 API；用户后续明确授权运行指定真实模型用例，允许测试进程使用已有认证，不输出凭据。现有集成测试承担复杂撤权、未知结果、子 agent 场景；新增进程测试优先覆盖默认配置、编排产物、权限、MCP 和持久化。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | codemode 默认启用且不额外授予目标工具 | packages/coding-agent/docs/codemode.md |
| F-002 | 已有真实 QuickJS/MCP、未知结果与 child 集成覆盖 | test/suite/agent-session-codemode-{extension,mcp,child}.test.ts |
| F-003 | 真实 API 必须另获明确许可且 opt-in | AGENTS.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: 本地受控 provider 可驱动源码 CLI；T-001 验证。
- Open question: None. 用户已明确授权真实模型测试，默认 gpt-6.1-sol / medium，限定指定文件一次运行。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 离线进程用例通过且验证实际 provider 声明、工具事件及副作用。
- 真实模型测试默认跳过，不使用真实 API 完成默认验证。
- npm run check 通过；只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001 与 T-002 独立，T-003 依赖二者。
- Parallel batches: T-001 / T-002 同时实施，T-003 串行验收。
- Serialization constraints: T-001 独占 codemode-e2e.test.ts 与其 fixture；T-002 独占 codemode-real-provider.test.ts；任务文档仅协调者编辑。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 离线 CLI E2E
- Status: done
- Owner: offline-e2e
- Objective: 实现真实源码 CLI/RPC + 本地 provider 的确定性测试。
- Inputs and prerequisites: 产品 codemode 文档与现有 CLI 测试。
- Scope or files: packages/coding-agent/test/codemode-e2e.test.ts 及专属 fixture。
- Expected output: 默认/关闭、编排、权限、only、MCP、恢复测试及可行的故障测试。
- Dependencies: None.
- Execution steps:
  1. 核对源码 CLI 与本地 provider 接入。
  2. 实现并运行针对文件。
- Acceptance criteria:
  - 用实际产物和审计断言，不仅检查模型文字。
- Verification method:
  - 从 package 根运行指定 vitest 文件。
- Validation evidence: 协调者已审查两个交付文件，并运行新增两文件与已有三个 suite：35 passed / 3 skipped，其中离线 E2E 11 passed。包括两调用 barrier、RPC abort、effect 后断线未知结果和恢复不重放；node --check fixture 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — opt-in 真实模型测试
- Status: done
- Owner: real-e2e
- Objective: 实现真实模型编排、发现、部分失败验收。
- Inputs and prerequisites: 现有真实 provider 测试模式。
- Scope or files: packages/coding-agent/test/codemode-real-provider.test.ts 及专属 fixture（如需）。
- Expected output: 默认跳过、明确 opt-in、默认 gpt-6.1-sol medium 的测试。
- Dependencies: None.
- Execution steps:
  1. 实现真实模型测试与独立产物断言。
  2. 默认环境执行验证跳过。
- Acceptance criteria:
  - 无 opt-in 不读取凭据、不联网；不实际运行付费测试。
- Verification method:
  - 指定文件 vitest 默认环境执行。
- Validation evidence: 协调者运行 env -u PI_REAL_MODEL_EVAL node ../../node_modules/vitest/dist/cli.js --run test/codemode-real-provider.test.ts：3 skipped；node --check test/fixtures/codemode-real-mcp.mjs 通过。已审查 gate、产物和 parentToolCallId 断言；未执行付费模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成验收与提交
- Status: done
- Owner: coordinator
- Objective: 审查并验证两项交付。
- Inputs and prerequisites: T-001/T-002 结果。
- Scope or files: 本任务新增文件及本文档。
- Expected output: 通过的验证结果与本任务提交。
- Dependencies: T-001, T-002
- Execution steps:
  1. 审查 diff，运行目标用例和 npm run check。
  2. 核对文件范围，提交。
- Acceptance criteria:
  - 无未说明验证缺口。
- Verification method:
  - 指定 vitest、npm run check、git diff、文档 validator。
- Validation evidence: 目标 5 文件 35 passed / 3 skipped；npm run check 通过（首次发现并修正 NodeJS.ProcessEnv 注解）；两份 fixture node --check 通过；git diff --check 通过。工作区仅本任务 5 个新增文件，显式路径提交。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 真实模型执行验收
- Status: blocked
- Owner: coordinator
- Objective: 按用户新增授权运行 3 项真实模型 E2E。
- Inputs and prerequisites: 用户明确授权，T-002 已完成。
- Scope or files: packages/coding-agent/test/codemode-real-provider.test.ts 与本文档。
- Expected output: 实际测试结果，失败时诊断证据或明确阻塞。
- Dependencies: T-002
- Execution steps:
  1. PI_REAL_MODEL_EVAL=1，显式 gpt-6.1-sol / medium 运行指定文件。
  2. 记录实际结果，不自动重复付费用例。
  3. 用户后续明确授权补充诊断并将两个失败用例各重跑一次；保留安全事件与 stderr，失败保留产物但删除认证/model 链接。
- Acceptance criteria:
  - 3 项通过；否则诚实记录失败或阻塞。
- Verification method:
  - 指定 vitest 实际退出结果。
- Validation evidence: 首轮完整文件 85.26s，1 passed / 2 failed。用户授权诊断后仅 -t 'batches reads|discovers an undeclared' 复跑一次，119.41s，批量 passed，MCP failed，部分失败用例 skipped。MCP message_end 为 stopReason:error、Codex request processing error，工具事件为空、stderr 为空，但 CLI exit0；请求 ID 83df9228-0649-4510-a2fa-fdc8cdfa1638。npm run check 通过。诊断信息保留在临时 diagnostic.json，认证/model 链接已删除。
- Blocker: 本次 MCP 模型请求在工具执行前失败；服务端内部原因不可见，原首轮详细事件已删除，无法证明首轮同因。
- Unblock condition: provider 请求问题解决或另获授权进行受控实验；本轮授权次数已用完，不再调用 API。

<!-- task-doc-section:validation-plan -->
## Test and validation plan
运行新增文件、已有 codemode 三个 session 集成文件，再运行 npm run check（可能改写文件，需复核范围）。真实模型默认跳过。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
实际模型首轮运行 1 passed / 2 failed；当前证据不足以区分模型行为、provider 或测试 harness 问题。进程测试的超时与清理必须有界，避免留下子进程。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-10-12: 已核对仓库规则和现有覆盖，启动两项互不重叠的实现。
- 2026-10-12: 现有 codemode extension/mcp/child 三个 suite 24/24 通过。
- 2026-10-12: T-002 实现经审查且默认 skip 验证通过；实际模型验证仍待额外授权。
- 2026-10-12: T-001 经审查，补充真实并发 barrier、RPC 取消和未知副作用断线恢复；11 项通过。
- 2026-10-12: T-003 启动，首次 npm run check 发现新增真实模型测试 env 类型错误，已修正；最终目标测试 35 passed / 3 skipped、全仓检查通过，仅修改本任务文件。
- 2026-10-12: 最终文档验证并显式路径提交。
- 2026-10-12: 用户明确授权真实模型运行，恢复本文档，启动 T-004；不自动重试付费用例。
- 2026-10-12: T-004 首轮 85.26s 完成，1 passed / 2 failed，未重试；缺乏保留的详细事件，阻塞通过验收。
- 2026-10-12: 只读检查确认 JSON 模式退出码不检查 assistant error/abort，测试未保留失败证据。用户授权诊断修改和两个失败用例各复跑一次；诊断代码 npm run check 通过，启动定向复跑。
- 2026-10-12: 复跑批量通过，MCP 在工具执行前发生 Codex 请求错误；新 assistant error 断言正确捕获，JSON exit0 掩盖错误路径已由运行观察确认。未修改产品功能，未再次重试。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: failed
- Evidence: 目标 5 文件 35 passed / 3 skipped；npm run check、fixture 语法检查、git diff --check 和任务文档 validator 通过。
- Limitations: 首轮 1 passed / 2 failed；授权诊断复跑批量通过、MCP 请求失败。已定位本次失败在 provider response 前于工具调用，无法解释服务端内部错误或证明首轮同因。live child/ancestor 撤权和兄弟分支隔离由既有 suite 验证，未复制为 CLI 进程用例；显式脚本 deadline 未新增独立进程用例，已验证 RPC abort。
