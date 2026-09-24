# Task Plan: Computer Use 延迟实测与优化

- Created: 2026-09-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求继续实测优化；会话 ses_01M38MR9CET5PD58。

<!-- task-doc-section:background-goal -->
## Background and goal

降低 Computer Use 的串行模型往返成本，保留证据、取消和禁止重放边界；以实际测量决定改动。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅 pi 内 Computer 工具与定向性能验证。禁止放宽原生安全检查、操作用户业务窗口、调用网站 API；付费模型 A/B 等待单独授权。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 37 次工具调用合计 7.375 秒，模型阶段 652.604 秒 | 原会话 10:53:40–11:06:39 时间戳分析 |
| F-002 | select 与后续 observe 分成模型轮次 | native/computer/desktop/tool.ts；原会话 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 合并不依赖新信息的选择与观察可省去一轮模型请求；通过工具回归和本地计时验证。
- Open question: 是否批准最多 6 次真实模型 A/B 请求，已异步询问；未批准不得调用。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 用真实调用边界报告时间；新路径减少一轮往返且保持旧路径及安全测试通过。
- 历史截图精简先测后决定；无端到端证据不宣称加速比例。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002。
- Parallel batches: 无，协调者串行执行。
- Serialization constraints: 工具契约、实现和验证共用状态，串行修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 测量并减少选择观察往返

- Status: done
- Owner: coordinator
- Objective: 验证 select 加观察的合并路径，减少不必要模型决策。
- Inputs and prerequisites: 原会话、Computer 工具和现有 fixture。
- Scope or files: native/computer/desktop/ 契约、工具及测试。
- Expected output: 向后兼容的可选合并路径、回归和测量。
- Dependencies: None.
- Execution steps:
  1. 检查路径，先建立测试，再实现并比较调用数和本地成本。
- Acceptance criteria:
  - 一次工具调用完成选择与观察；当前引用有效、旧引用失效，取消后不发布。
- Verification method:
  - Computer 定向测试、类型检查、npm run check。
- Validation evidence: 新增 2 例先失败后通过，另加观察期间撤销测试；desktop 共 113 passed / 1 GUI skipped / 0 failed。desktop typecheck 与 npm run check 通过。fixture 确认一次 select(observe:true) 完成 select 和 observe，返回引用可供下一次输入；不经过第二轮工具调用。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 实测验收与交付

- Status: blocked
- Owner: coordinator
- Objective: 验证收益和边界，更新本地运行产物。
- Inputs and prerequisites: T-001；真实模型实验需用户授权。
- Scope or files: 定向测试脚本、本文档、打包产物。
- Expected output: 真实窗口证据与诚实的性能边界。
- Dependencies: T-001.
- Execution steps:
  1. 运行本地窗口对照；获授权后最多 6 次模型请求，否则保留该验证缺口。
- Acceptance criteria:
  - 原生动作与引用安全未退化，给出实际往返减少量，不虚构端到端收益。
- Verification method:
  - 独立 fixture 与已有模型日志对照，检查 scoped diff。
- Validation evidence: 打包校验成功（1428 files），候选位于 /tmp/easy-pi-computer-latency.WQKu7w/computer；未安装候选。lsof 确认 PID 91484 持有 D 0318，未干预运行中的会话。未调用真实模型。
- Blocker: 真实窗口由当前 easy-pi 会话占用；付费模型 A/B 尚未获得单独授权。
- Unblock condition: 用户正常退出持有者；明确允许最多 6 次模型请求或选择仅本地验证。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

定向 native SDK fixture 测试、desktop typecheck、仓库 check；独立原生窗口对照，不执行真实模型返回的桌面动作。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

模型延迟受服务端和网络波动影响；删除旧截图可能破坏缓存前缀，因此不直接启用。117.5 秒间隔仍缺细分遥测。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-24: 建立串行任务；T-001 开始，等待付费请求授权期间先处理本地可验证路径。
- 2026-09-24: T-001 回归、类型和仓库检查通过，标记 done；保留原生检查和历史截图，恢复仓库检查的无关格式改动。
- 2026-09-24: T-002 开始；完成候选打包，发现桌面被 PID 91484 占用并请求正常退出，随后标记 blocked。模型测试授权亦待回复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 本地测试通过；候选打包校验通过，T-002 待真实窗口及模型对照。
- Limitations: 不能把减少一轮调用换算成已证明的端到端加速；未改变生产截图策略，未补齐 117.5 秒间隔的遥测。
