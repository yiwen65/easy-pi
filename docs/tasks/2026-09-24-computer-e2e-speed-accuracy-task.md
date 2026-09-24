# Task Plan: Computer E2E 速度与准确性精简

- Created: 2026-09-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求执行速度、准确性优先的 E2E 和逐项精简对照。

<!-- task-doc-section:background-goal -->
## Background and goal

建立从首次工具加载到业务结果与关闭的真实 UI 测量，依据同任务对照决定精简，不用减少断言伪造提速。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅 pi Computer 测试、测量与已授权实验；原始记录保留。默认不调用付费模型、不改变系统权限、不删除租约、不操作业务文档。生产检查的删除需独立证据与确认。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 已有真实保存、正常替换和失效全选 fixture | native/computer/desktop/fixtures/save-panel |
| F-002 | 已有基准排除了 discovery/readiness | docs/implementation/computer/general-benchmark-results.md |
| F-003 | 本轮 120 次真实 UI 尝试中，保存重开 34/40，正常替换 40/40，失效全选正确拒绝 40/40；全部完成关闭 | /tmp/epi-e2e.mHUqs8/paired-20/{contract.json,samples.jsonl,summary.json} |
| F-004 | 一次独立计时中 ax_readiness 的窗口检测消耗 1024.481ms，实际 call 0.480ms | /tmp/epi-e2e.mHUqs8/phase-trace.log |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 当前 macOS/Node 安装作为首个基线平台；运行时记录版本和二进制指纹。
- Open question: 真实模型额度与生产权限精简尚未单独授权，不阻塞本地工具/UI 对照。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 同一业务 oracle、全量失败样本、冷加载和关闭独立计时；禁止失败自动重跑。
- 合并/拆分选择观察使用同一二进制，按对交错执行；不声称固定脚本代表真实模型 E2E。
- 后续覆盖浏览器、纯视觉、焦点/取消干扰和连续会话后才判断全链路完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-004 -> T-002 -> T-003.
- Parallel batches: 无；同一 fixture、记录格式及桌面串行。
- Serialization constraints: 同一桌面禁止并发；文档由 coordinator 维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 测量与首批真实 UI 对照

- Status: done
- Owner: coordinator
- Objective: 可重复的三种 fixture 基线与选择观察 A/B。
- Inputs and prerequisites: 已安装原生包及保存 fixture。
- Scope or files: native/computer/desktop/fixtures/save-panel。
- Expected output: 有界 runner、原始 JSONL、分段计时、汇总与定向单测。
- Dependencies: None.
- Execution steps:
  1. 复用真实工具路径，加入计时、独立结果和关闭判定。
  2. 交错运行 split/combined，先小样本确认，再扩大。
- Acceptance criteria:
  - 三种模式真实执行；失败不丢弃；未证明排空则停止整批。
- Verification method:
  - 定向 node:test、真实 GUI、npm run check、文档校验。
- Validation evidence: node --test native/computer/desktop/fixtures/save-panel/metrics.test.mjs：3/3；npm run check 通过；120 次真实 UI 对照完整记录并正确以非零退出报告 6 次业务失败。测量任务完成不等于产品基线通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 扩展业务与干扰覆盖

- Status: pending
- Owner: coordinator
- Objective: 浏览器、纯视觉、连续会话、焦点变化和取消。
- Inputs and prerequisites: T-001 的测量与 oracle。
- Scope or files: native/computer/desktop/fixtures。
- Expected output: 可重复任务与扰动结果。
- Dependencies: T-004.
- Execution steps:
  1. 增加每种独立执行机制的最小任务，不复制相同流程。
- Acceptance criteria:
  - 正常成功与正确拒绝分开统计，无错误输入和遗留占用。
- Verification method:
  - 实际 UI 与独立结果读回。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 成本归因与精简决策

- Status: pending
- Owner: coordinator
- Objective: 逐项决定合并、缓存、保留或删除。
- Inputs and prerequisites: 完整本地基线与干扰覆盖。
- Scope or files: native/computer 与测量报告。
- Expected output: 有证据的 A/B 决策，待授权项明确列出。
- Dependencies: T-002.
- Execution steps:
  1. 优先实测多余往返，再追踪校验和权限检查成本。
- Acceptance criteria:
  - 业务结果等价，收益大于噪声，尾延迟和错误率不劣化；无证据不删除。
- Verification method:
  - 单变量交错对照及必要的真实模型 E2E（须另行授权）。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 保存焦点失败定位及回归

- Status: pending
- Owner: coordinator
- Objective: 解释并修复保存流程中 foreground_focus_unproved 的首次分歧，不绕过焦点校验。
- Inputs and prerequisites: T-001 的 6 次失败原始日志；现有 owned fixture。
- Scope or files: native/computer/desktop/fixtures/save-panel 与相关原生焦点路径。
- Expected output: 焦点前后状态证据、单变量复现、最小修复及相同业务 oracle 回归。
- Dependencies: T-001.
- Execution steps:
  1. 在失败的 Return 前后记录 fixture 的前台应用、key window 和 native 目标状态，区分 fixture 未就绪、真实焦点变化与保护误拒绝。
  2. 先形成可证伪复现，再实施授权范围内修复；不得重放 inputCommitted 的动作。
- Acceptance criteria:
  - 失败原因有直接证据；保存、正常替换和失效全选保护回归均通过，无遗留占用。
- Verification method:
  - 原始失败 trace 对照、独立文件与重新打开读回、串行重复 GUI 回归。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

逐层执行纯汇总单测、三种真实 fixture 冒烟、交错 A/B。记录来源版本、原生指纹、耗时边界；不使用同步日志时间冒充原生执行时间。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

模型延迟尚未计入；共享桌面的焦点与负载会影响结果；小样本不能证明低失败率或稳定 p95。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-24: T-001 开始；先实现确定性工具/UI 基线，不更改生产安全策略。
- 2026-09-24: T-001 完成。6 次冒烟通过后执行 120 次正式对照；不同 probe 版本的冒烟未混入正式统计。补充汇总器拒绝缺失关闭证明或非法耗时的单测。
- 2026-09-24: 发现保存焦点失败，新增 T-004，并置于覆盖扩展和生产精简之前。当前未删除生产校验、权限或焦点保护，未调用付费模型。

### 首批实测与决策

环境：macOS Darwin 25.5.0 arm64，Node 24.15.0；原生 SDK SHA256 `b3ac211594001c05c5020f87e753a64f44fd5786b3701f6117eb9422b377e7d0`。每个任务每组 20 次，按 pair 交替 AB/BA，均为新进程冷加载与新 owner。计时起点包括 bridge 加载；fixture 已预先打开，启动时间另列；结束含独立业务读回，关闭另列。不包含模型与应用启动性能。

| 场景 | split 成功/尝试 | combined 成功/尝试 | 成功 P50 split/combined (ms) | 成功 P95 split/combined (ms) | 调用数 split/combined |
| --- | --- | --- | --- | --- | --- |
| 保存重开 | 18/20 | 16/20 | 2184.6 / 2176.5 | 2443.6 / 2432.8 | 11 / 9 |
| 正常替换 | 20/20 | 20/20 | 1446.9 / 1443.9 | 1525.9 / 1482.0 | 5 / 4 |
| 失效全选正确拒绝 | 20/20 | 20/20 | 1612.5 / 1616.8 | 1632.4 / 1658.7 | 4 / 3 |

失败不计入成功耗时，但保留在全部尝试分母。不能据此宣称 combined 更快或准确性非劣；本地耗时差小，真实模型往返收益尚未测量。

6 次保存失败对应 pair 7 combined/split、10 combined、12 combined、13 combined、16 split。名称填充已确认，Return 的结果为 `foreground_focus_unproved`，`inputCommitted: true`、`recoveryAttempts: 1`，随后独立 saved 事件等待到期。不能把 inputCommitted 当作 Return 已完成，也不能从拒绝码直接认定用户抢焦点或校验错误。120 次均完成 native close、fixture 正常退出与 clean lease；未自动重跑失败动作。

分段诊断另行运行，不混入对照：`ax_readiness` 总计 1028.106ms，`detectUs=1024481`、`callUs=480`、`callbackDrainOk=true`。`tools/computer.rs` 的 `with_focus_cleanup` 丢弃 `snapshot.detect()` 返回值；`window_change_detector.rs` 默认检测 1000ms，但 snapshot 同时持有 wildcard 焦点抑制 lease。因此这是高价值待实验项，不是已证实可直接删除的空等待。下一步需要保留回调排空与焦点约束的独立候选对照；目前未替换安装包。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 仪器与单测通过；正式产品基线 114/120（含 40 次预期拒绝），6 次保存失败完整保留。详细数据及版本见上表和本地原始记录。
- Limitations: T-004 焦点根因/修复、T-002 浏览器/视觉/干扰/连续会话、T-003 精简资格验证未完成；模型层尚未执行；无生产提速或彻底修复结论。
