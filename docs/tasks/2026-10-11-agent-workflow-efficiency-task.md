# Task Plan: 保留 xhigh 的流程调度优化

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户选择「保留 xhigh，只优化流程」并确认实施范围。

<!-- task-doc-section:background-goal -->
## Background and goal

针对 session 2b0e1c53 的大量串行模型调用，精简既有调度提示，减少重复取证、无效状态查询及不可用交互能力的反复探查；保留正确性和验证要求。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅修改 pi 默认 system prompt 的流程指导和对应离线回归测试。当前分支为 my-pi，依仓库规则不修改 changelog。保留自定义 system prompt 替换行为。不得修改用户 settings、thinking 档位、压缩阈值、权限或工具执行机制；不增加分类器、调度层或真实模型调用。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 原任务 72分30秒中，主模型请求区间约63分54秒，共103次调用 | /tmp/session-2b0e1c53-final-metrics.txt；原 session 消息时间戳 |
| F-002 | 用户要求保留 xhigh，仅优化流程并确认实施 | 当前会话两次结构化选择 |
| F-003 | 默认 prompt 已有正确性、证据、最小验证规则；工具指南会去重 | packages/coding-agent/src/core/system-prompt.ts |
| F-004 | 仓库默认档位为 medium，本机 settings 为 xhigh | packages/coding-agent/src/core/defaults.ts；用户 settings 只读检查 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 更直接的流程提示有望减少冗余往返，但离线测试不能证明真实模型提速。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 默认 prompt 指导批量独立只读取证、直接执行已明确的下一步、复用仍有效的证据和停止已确认不可用能力的重复探查。
- 有可用阻塞等待工具时优先等待，不进行无信息增量轮询；不得提示调用不存在的等待工具。
- 保留依赖/写入顺序、必要重验证、最小有效验证和自定义 prompt 替换语义。
- 定向离线测试和 npm run check 通过；只提交本任务改动，不声称实测提速。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 独立。
- Parallel batches: None; 单一提示入口由 coordinator 串行修改。
- Serialization constraints: 代码、测试和此文档均由 coordinator 独占。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 精简内置调度指导并验证

- Status: done
- Owner: coordinator
- Objective: 将已确认流程优化接入默认 prompt，保留现有安全与功能边界。
- Inputs and prerequisites: 用户确认范围；既有 prompt 与工具贡献测试；工作区初始干净。
- Scope or files: packages/coding-agent/src/core/system-prompt.ts；packages/coding-agent/test/system-prompt.test.ts；此任务文档。
- Expected output: 最小提示差异、等待工具可用性及自定义替换回归、验证后提交。
- Dependencies: None.
- Execution steps:
  1. 添加流程指导及条件化等待提示，不修改工具执行机制。
  2. 运行 system-prompt 与 tool-system-prompt-contributions 定向测试及 npm run check。
  3. 核对 diff/用户设置未改，更新验证结果并提交本任务文件。
- Acceptance criteria:
  - 全部整体 acceptance criteria 满足。
- Verification method:
  - 从 coding-agent 包根运行 node ../../node_modules/vitest/dist/cli.js --run test/system-prompt.test.ts test/tool-system-prompt-contributions.test.ts；仓库根 npm run check；git diff --check。
- Validation evidence: 定向 vitest 两文件 22/22 通过（684ms）；完整 npm run check exit 0（Biome、依赖固定、TS imports、shrinkwrap/install-lock、tsgo、browser smoke）；git diff --check 通过。独立只读复核无可行动发现。用户 settings 的 SHA256 前后相同；仅源代码/测试/本任务文档变化。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

验证生成的默认 prompt 内容、不同等待工具集合的提示边界、自定义 prompt 不被插入默认指南，以及内置工具指南对齐。离线回归只证明接线正确，不作为真实模型减少调用/延迟的证据。不运行完整测试或真实 API。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

提示是软约束，模型仍可能过度思考；减少读取不得削弱任务要求的完整审阅，复用证据必须保留外部状态变化后的重验证。npm run check 会自动格式化，运行后核对共享 worktree。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 用户确认仅优化流程；只读核对设置、默认 prompt、工具指南和测试；T-001 开始。
- 2026-10-11: 完成默认指南及 6 项新增回归；首轮类型检查发现空数组用例与 string[] 联合导致 includes 参数为 never，改为 some 后复跑通过。
- 2026-10-11: 定向 22 tests、完整 check 及独立只读复核通过；设置 hash 未变、无旁路改动。T-001 完成，准备只提交三份任务文件。
- 2026-10-11: 本轮仅常规测试迭代，且范围限定为提示/测试，不另写 LEARNS.md。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 定向 22/22 tests；npm run check exit 0；git diff --check；独立只读复核无可行动发现；用户设置 SHA256 未变。任务文档最终 validator 作为提交前门禁。
- Limitations: 无真实模型对照测试，不能量化提速；提示为软约束。未构建/部署或重启现有进程，新指南需由使用更新代码的运行实例加载。
