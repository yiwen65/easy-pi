# Task Plan: 修复 Agent Desktop 枚举并验证桌面闭环

- Created: 2026-10-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求修复已定位的桌面验证阻塞。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 agent-desktop 0.9.4 遇到无效 NSRunningApplication PID 后拒绝整个应用列表的问题，并验证已注册 MCP 的实际桌面观察/操作闭环。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

在临时目录编译上游固定版本，在 pi/tools/agent-desktop-mcp 保存最小补丁、回归及重建说明。安装独立 patched 二进制并更新现有全局 MCP 的二进制路径。使用专用测试 App，不关闭其他应用、不操作用户文档、不改变系统权限、不改 easy-pi 内核。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 原始 0.9.4 snapshot/list-apps 超时 | 前次真实 stdio MCP 调用，当前 CLI Finder snapshot 复现 |
| F-002 | Device Hub 的 NSRunningApplication PID=-1 导致 bridge status=2 | 前次原样 bridge 与仅跳过 PID<=0 的诊断对照；过滤后 status=0 |
| F-003 | 固定上游版本可获取 | v0.9.4 对应 a4a695fdd1f673426579696c7e17074910e799fc；本地 Cargo 1.95.0 |
| F-004 | MCP 当前注册全局且支持七个工具 | ~/.epi/agent/mcp.json；tools/agent-desktop-mcp/server.mjs |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 修复 bridge 后下游可能暴露更多问题；用实际 CLI/MCP 逐层验证，未通过不得标记完成。
- Open question: 无待用户决定事项；外部网络或构建阻塞将记录并报告。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 无效 PID 回归在原始 source 失败、patched source 通过，其他有效 PID 校验不放宽。
- 原始二进制保留；新二进制应用枚举和真实 snapshot 成功。
- 新注册配置通过 stdio MCP 完成专用窗口 snapshot、click、type、press、batch，并读取真实 UI 状态验证。
- 保存复现方式，针对性测试和仓库 check 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；源码补丁、编译、注册、共享桌面依次执行。
- Serialization constraints: coordinator 独占任务文档及桌面操作；独立审查只读。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 最小上游补丁与回归

- Status: done
- Owner: coordinator
- Objective: 排除无效 PID 的非运行应用条目，不放宽其他检查。
- Inputs and prerequisites: 固定 v0.9.4 source 与已证明的无效 PID 因果链。
- Scope or files: tools/agent-desktop-mcp/patches 及针对性回归。
- Expected output: 可重现的 unified patch 和确定性回归。
- Dependencies: None.
- Execution steps:
  1. 保存最小补丁，在临时上游源码应用；执行前后回归。
- Acceptance criteria:
  - 原始失败，patched 成功，有效条目仍在列表。
- Verification method:
  - 原生 AppKit bridge 的无效/有效记录输入对照。
- Validation evidence: clang 编译 patches/workspace-inventory.test.m：原始 v0.9.4 在无效 PID case 断言失败 exit 134；应用 patch 后 PASS exit 0，覆盖 PID -1/0、有效应用保留、live identity 缺失及重复 PID 仍拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 编译安装并更新注册

- Status: done
- Owner: coordinator
- Objective: 运行修复后的 engine，保留原始可回退版本。
- Inputs and prerequisites: T-001 的 verified patch。
- Scope or files: 独立 ~/.local/share/agent-desktop 目录；现有全局 MCP env；README。
- Expected output: patched CLI 和 helper；配置指向新 CLI。
- Dependencies: T-001.
- Execution steps:
  1. Cargo locked 构建 CLI/helper；验证 list-apps 和 snapshot；更新注册。
- Acceptance criteria:
  - 新 CLI 实际枚举成功，原始二进制未被覆盖。
- Verification method:
  - CLI status/list-apps/snapshot 和后续真实 registered MCP。
- Validation evidence: cargo build --locked --release -p agent-desktop -p agent-desktop-macos --bin agent-desktop --bin agent-desktop-macos-helper 成功；独立 0.9.4-epi-pidfix CLI status/list-apps Finder/snapshot Finder 均 ok=true，75 refs；仅更新全局现有 AGENT_DESKTOP_BIN，原始 0.9.4 保留。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 桌面端到端闭环与收尾

- Status: done
- Owner: coordinator
- Objective: 通过真实 MCP 验证所有暴露工具的关键路径。
- Inputs and prerequisites: T-002；可控制的专用测试窗口。
- Scope or files: tools/agent-desktop-mcp 专用测试 App / opt-in E2E 脚本；README；本任务文档。
- Expected output: 实际 UI 状态证明、回归测试、提交。
- Dependencies: T-002.
- Execution steps:
  1. 创建隔离 App；MCP observe/action/verify；关闭自有 App；运行 check 和审查。
- Acceptance criteria:
  - 点击反馈、输入值、键盘行为与 batch 结果有实际 UI 读取证明。
- Verification method:
  - 真实 stdio MCP 与专用窗口；针对性测试；npm run check；diff。
- Validation evidence: AGENT_DESKTOP_E2E=1 node tools/agent-desktop-mcp/e2e/run.mjs 两次通过所有七个 registered stdio MCP 工具；真实 UI 验证 Clicks:1、中英文输入值、Shortcut:1、batch Clicks:2。node --test server.test.mjs 5/5；cargo test --locked -p agent-desktop-macos --lib system::appkit_bridge::tests 3/3；npm run check 通过无格式改写；缺失 swiftc 的故障注入验证临时目录清理；epi mcp list --json 显示 connected/errors=[]，无遗留测试 App。独立只读审查补丁无 actionable finding；E2E 审查发现 setup cleanup gap 已修正并故障验证。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

确定性 bridge 前后对照 -> locked Cargo 构建 -> CLI 原触发器 -> 真实 MCP 专用 App 闭环 -> node --test server.test.mjs -> npm run check -> 文档验证与 scoped commit。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

新签名路径可能触发权限缺失；不自动授权。默认 headless AX 并非所有输入都支持，必要时仅在专用 App 显式 headed。独立 transports 不隔离共享桌面，禁止并发控制。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-15: 创建执行文档；取得固定上游 source；开始 T-001。
- 2026-10-15: T-001 原始失败/补丁通过；完成 T-001。开始 T-002，cargo build --locked --release 正在后台执行（task-10）。
- 2026-10-15: T-002 构建与原触发器验证通过，完成并更新注册；开始 T-003 专用桌面窗口验证。
- 2026-10-15: T-003 首次闭环全通过；独立审查发现测试 setup cleanup gap，已将编译/启动纳入 finally 并注入缺失编译器证明清理；第二次闭环全通过。
- 2026-10-15: 完成 T-003；Node 5/5、Rust 邻近 3/3、仓库 check 及注册状态均通过，任务文档进入最终验证。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 原始失败/补丁通过，T-002 locked 构建及原触发器恢复，T-003 两次实际桌面闭环及 Node/Rust/check 全通过；任务文档验证通过。
- Limitations: 当前 macOS 主机和专用 AppKit App；不代表所有第三方应用或 headed/其他平台支持。修复仅 inventory rows，frontmost branch 不变。macOS 测试启动有非致命 sandbox_extension_issue_file_to_process 日志，但所有真实 UI postcondition 均验证通过；未改变系统权限。
