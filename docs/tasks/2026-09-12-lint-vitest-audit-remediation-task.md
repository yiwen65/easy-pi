# Task Plan: 清理遗留 lint 与 Vitest audit 问题

- Created: 2026-09-12
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户选择“两组都处理”并确认 Vitest 4.1.11 与三处 lint 整改契约。

<!-- task-doc-section:background-goal -->
## Background and goal

消除上一轮发现的三处 `lint/style/useTemplate` info 和 npm audit 的三个 moderate package findings；保持测试语义及产品运行时依赖不变。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 修复 `packages/subagent/test/collaboration-contract.test.ts` 中三处字符串拼接。
- 将九个 workspace 的直接 `vitest` 固定版本及两个 `@vitest/coverage-v8` 固定版本统一从 4.1.9 升到 4.1.11；刷新和审查根锁文件，只有必要时才刷新产品 shrinkwrap/install-lock。
- 复核官方 advisory/release 信息，运行目标测试、coverage 冒烟、完整仓库 check 和 npm audit。
- 不执行 `npm audit fix --force`，不改变运行时依赖或产品 API，不运行或修改 `packages/coding-agent/test/tool-profile-eval/**`。
- 不发布、推送、打 tag、使用真实 provider API 或重启 live session；保留既有 `README.md` 和 `assets/readme/architecture.svg`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 三处 lint info 位于同一个测试，拼接 JSON fence/prose fixture。 | `packages/subagent/test/collaboration-contract.test.ts:169-171`；上一轮 `npm run check` 输出。 |
| F-002 | 全量 audit 为三个 moderate package findings，属于同一条 Vitest 依赖链。 | `npm audit --json`：`vitest`、`@vitest/mocker`、`@vitest/coverage-v8`，GHSA-82fw-gwwq-j7x9，修复版本 4.1.11。 |
| F-003 | 生产依赖 audit 为零。 | `npm audit --json --omit=dev`：total 0。 |
| F-004 | 所有直接 Vitest/coverage 依赖均锁定 4.1.9。 | `rg` manifests 与 `npm ls vitest @vitest/coverage-v8 @vitest/mocker --all`。 |
| F-005 | 开始时只有 README 和 architecture SVG 为无关 dirty work。 | `git status --short --untracked-files=all`；HEAD cb97e93a1。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 4.1.11 修复已报告 advisory 且无需产品逻辑修改；通过官方 release 信息、安装后 audit 和目标测试验证。
- Open question: None. 用户已确认两组整改、升级版本、锁文件和验证范围。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 三处 lint info 消失，测试 fixture 的字符串字节与断言语义不变。
- 所有直接 Vitest/coverage 版本统一为 4.1.11，依赖树中没有残余 4.1.9 mocker。
- 全量和生产 `npm audit` 均为零；不引入运行时 dependency 变化。
- 修复的测试、各受影响 workspace 代表性测试及 coverage 冒烟通过。
- `npm run check`、锁文件检查和 diff 范围检查通过；无关 dirty work 保持不变。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003`。
- Parallel batches: None. 先验证 fixture 修改，再升级共享 test runner，最后验证依赖图，避免同时改变测试输入和执行器导致归因不明。
- Serialization constraints: 所有 workspace 共用根 lockfile/node_modules；install、lockfile 生成和仓库 check 串行执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 消除三处 lint info 并保持测试语义

- Status: done
- Owner: coordinator
- Objective: 使用 template literal 替代三处字符串拼接。
- Inputs and prerequisites: 用户确认；已完整读取目标测试。
- Scope or files: `packages/subagent/test/collaboration-contract.test.ts`。
- Expected output: 最小三行 diff，无断言和生产代码变化。
- Dependencies: None.
- Execution steps:
  1. 修改三处 fixture 字符串构造。
  2. 在升级 test runner 前运行目标测试及目标 lint 检查。
- Acceptance criteria:
  - 原测试通过；三处 useTemplate info 消失。
- Verification method:
  - 目标 Vitest 文件和只读 Biome 检查。
- Validation evidence: 修改前后目标 Vitest 文件均为 40/40 passed；目标 Biome check passed with no fixes after the three template-literal changes.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 将 Vitest 开发依赖升级到安全补丁版本

- Status: done
- Owner: coordinator
- Objective: 消除 GHSA-82fw-gwwq-j7x9 及其传播到 coverage 的 audit findings。
- Inputs and prerequisites: T-001 done；当前 advisory 和依赖树证据。
- Scope or files: 九个受影响 workspace `package.json`、根 `package-lock.json`；必要的生成锁文件。
- Expected output: Vitest/coverage/mocker 4.1.11 依赖树；没有运行时依赖版本变化。
- Dependencies: T-001.
- Execution steps:
  1. 查看官方 release/advisory 和升级影响。
  2. 更新所有直接精确版本，使用 `npm install --package-lock-only --ignore-scripts` 及 `npm install --ignore-scripts` 刷新。
  3. 检查 lockfile diff，保留与升级无关的既有元数据；核验生产 shrinkwrap/install-lock。
- Acceptance criteria:
  - 全量 audit 与 production audit 为零，依赖树没有旧 Vitest/mocker。
- Verification method:
  - `npm ls`、`npm audit`、manifest/lockfile diff、生成锁文件 --check。
- Validation evidence: 官方 v4.1.11 release notes 明确包含 `mocker` fs allowlist 修复；9 个 workspace 的 direct Vitest pins 与 2 个 coverage pins 已更新；`npm ls` 全部收敛至 4.1.11；全量和 production `npm audit` 均为 0；lockfile JSON 有效且仓库 lock checks 已通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 验证 test runner/coverage 和仓库检查并提交

- Status: done
- Owner: coordinator
- Objective: 证明升级后测试和覆盖率接线仍工作，按显式文件范围提交。
- Inputs and prerequisites: T-002 done。
- Scope or files: T-001/T-002 输出及本任务文档。
- Expected output: 当前验证证据与只包含本任务文件的本地 commit。
- Dependencies: T-002.
- Execution steps:
  1. 为九个 workspace 选择少量现有代表性测试，覆盖 mock 和两个 coverage 消费方，不运行付费/e2e/冻结路径。
  2. 运行目标测试和 `npm run check`，立即撤回仅由 formatter 引入的非任务文件变化。
  3. 运行 diff/任务文档检查，记录结果，仅 stage 本任务路径并本地提交。
- Acceptance criteria:
  - 验证通过，无 publish、push、tag 或 session 操作；README/SVG 保持基线。
- Verification method:
  - 目标测试/coverage、`npm run check`、`git diff --check`、状态检查、任务文档 validator。
- Validation evidence: 代表性测试全部通过：subagent 40、agent 26 + coverage 131、ai 2、client 4、protocol 16、server 7、telemetry 5、sqlite coverage 1、coding-agent 89、evals 6；`npm run check` 通过且无 lint info；两种 `npm audit` 均为 0；`git diff --check` 和 task-document validator 通过。仅恢复了 formatter 对两个无关 collaboration 源文件的改动。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 基线与修改后单文件：从 subagent 包根运行 `node ../../node_modules/vitest/dist/cli.js --run test/collaboration-contract.test.ts`。
- 升级后：按包选择代表性测试；agent 和 sqlite-node 另外跑有界 coverage 冒烟，coverage 输出仅放临时目录。
- `npm audit --json` 与 `npm audit --json --omit=dev`；`npm ls vitest @vitest/coverage-v8 @vitest/mocker --all`。
- `npm run check` 及生产生成锁文件 --check；`git diff --check`、任务文档 validator、dirty-file hash 对照。
- 不执行根 `npm test`、全量直接 Vitest 或受保护 tool-profile-eval。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- npm registry/release 信息或新版本安装可能不可用；若不可用，记录 blocker，不使用强制升级或禁用安全门。
- 4.1.11 是 test runner 补丁升级，不等于所有测试已被证明无回归；用跨 workspace 目标测试及 coverage 限定验证范围。
- 根 lockfile 预存已不存在的 pi-codex-accounts workspace 元数据；npm install 可能顺带修改，必须与本次 Vitest 升级 diff 分离。
- 根 check 的 formatter 会修改两处现有 collaboration 源码格式；若发生，仅恢复其无关 formatter diff。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-12: 用户确认两组整改。审计确认生产依赖零漏洞，三项报告来自 Vitest 开发依赖链。
- 2026-09-12: 创建本任务文档，T-001 由 coordinator 开始。
- 2026-09-12: T-001 完成；基线与修改后目标测试均为 40/40 passed，目标 lint 检查不再报告 useTemplate info。
- 2026-09-12: T-002 开始；已将所有直接 Vitest/coverage manifest pin 更新为 4.1.11，待刷新锁文件并验证 audit。
- 2026-09-12: npm install 首次保留了旧 root peer Vitest；运行 `npm dedupe --ignore-scripts` 后依赖树全部收敛到 4.1.11，手工恢复了其顺带变更的无关 lock 元数据。
- 2026-09-12: 官方 v4.1.11 release notes 确认 mocker fs allowlist 修复；全量/生产 audit 均为 0。
- 2026-09-12: 代表性 Vitest/coverage 测试通过；eval workspace 首次使用默认配置无测试文件，改用 `vitest.test.config.ts` 后 6/6 通过。
- 2026-09-12: T-003 完成；完整仓库 check、双 audit、lock 检查和 diff 检查通过，未运行冻结测试路径。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 3 处 useTemplate info 已修复；Vitest/coverage 直接 pin 全部为 4.1.11；`npm ls vitest @vitest/mocker @vitest/coverage-v8 --all` 无 4.1.9 残留；全量和 production `npm audit` 均为 0；代表性跨 workspace 测试与两个 v8 coverage 冒烟通过；`npm run check`、锁文件检查、`git diff --check` 和任务文档 validator 均通过。
- Limitations: 未运行完整全仓库测试、任意第三方插件矩阵或真实 provider API；本次不发布 npm、不推送、不打 tag。
