# Task Plan: Computer Use 延迟实测与优化

- Created: 2026-09-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求继续实测优化；会话 ses_01M38MR9CET5PD58。

<!-- task-doc-section:background-goal -->
## Background and goal

降低 Computer Use 的串行模型往返成本，保留证据、取消和禁止重放边界；以实际测量决定改动。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅 pi 内 Computer 工具与定向性能验证。禁止放宽原生安全检查、操作用户业务窗口、调用网站 API；用户已授权最多 6 次真实模型 A/B，不执行模型返回动作。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 37 次工具调用合计 7.375 秒，模型阶段 652.604 秒 | 原会话 10:53:40–11:06:39 时间戳分析 |
| F-002 | select 与后续 observe 分成模型轮次 | native/computer/desktop/tool.ts；原会话 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 合并不依赖新信息的选择与观察可省去一轮模型请求；通过工具回归和本地计时验证。
- Open question: PID 91484 已退出，仍需重查桌面租约并完成 GUI 验证。用户已确认启用快速截图模式；6 次真实模型 A/B 全部完成。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 用真实调用边界报告时间；新路径减少一轮往返且保持旧路径及安全测试通过。
- 历史截图精简先测后决定；无端到端证据不宣称加速比例。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-003 -> T-002。
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

- Status: in_progress
- Owner: coordinator
- Objective: 验证收益和边界，更新本地运行产物。
- Inputs and prerequisites: T-001；真实模型实验需用户授权。
- Scope or files: 定向测试脚本、本文档、打包产物。
- Expected output: 真实窗口证据与诚实的性能边界。
- Dependencies: T-003.
- Execution steps:
  1. 运行本地窗口对照；获授权后最多 6 次模型请求，否则保留该验证缺口。
- Acceptance criteria:
  - 原生动作与引用安全未退化，给出实际往返减少量，不虚构端到端收益。
- Verification method:
  - 独立 fixture 与已有模型日志对照，检查 scoped diff。
- Validation evidence: bridge 打包校验成功（1428 files），候选位于 /tmp/easy-pi-computer-latency.WQKu7w/computer；未安装候选。PID 91484 仍运行，未干预桌面。6 次真实模型请求成功；独立 tsgo 构建检查失败于 src/extensions/index.ts:12 和 pi-child-session-host.ts:210 的源码/已安装 dist ExtensionAPI 类型不一致，未以失败输出覆盖安装。
- Blocker: None; 后续由 coordinator 重查租约并继续 bridge 安装与 GUI 验证。
- Unblock condition: None.

### [x] T-003 — 可选精简历史截图上下文

- Status: done
- Owner: coordinator
- Objective: 根据已完成 A/B 实现最近两组 Computer 截图策略，默认仍保留全部，启用需用户确认。
- Inputs and prerequisites: T-001；6 次 ABBAAB 固定请求回放结果。
- Scope or files: core/computer/context.ts、sdk.ts、settings-manager.ts、对应测试与设置文档。
- Expected output: 请求上下文投影，不改会话存储、文本、用户图片或当前图片字节。
- Dependencies: T-001.
- Execution steps:
  1. 增加可选设置和纯投影；验证原图留存、跨窗口双图整组保留、最新引用安全。
- Acceptance criteria:
  - all 默认不变，recent 保留最近两组；SDK 接线及安全回归通过。
- Verification method:
  - 单元/SDK faux/Computer 边界测试和 root check；原会话离线投影与实测载荷对照。
- Validation evidence: Computer 和 settings 定向 vitest 11 files / 191 passed，包含 7 项新测试；npm run check 通过，恢复其无关格式改动。A 23.588/29.043/33.368 秒；B 11.816/6.296/9.529 秒；6 次均返回 observe，未执行；实验为 SSE 固定历史回放，不是完整任务 A/B。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

定向 native SDK fixture 测试、desktop typecheck、仓库 check；独立原生窗口对照，不执行真实模型返回的桌面动作。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

模型延迟受服务端和网络波动影响；滚动省略旧截图可能破坏缓存前缀，用户已接受视觉回看代价并启用。117.5 秒间隔仍缺细分遥测。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-24: 建立串行任务；T-001 开始，等待付费请求授权期间先处理本地可验证路径。
- 2026-09-24: T-001 回归、类型和仓库检查通过，标记 done；保留原生检查和历史截图，恢复仓库检查的无关格式改动。
- 2026-09-24: T-002 开始；完成候选打包，发现桌面被 PID 91484 占用并请求正常退出，随后标记 blocked。模型测试授权亦待回复。
- 2026-09-24: 用户批准最多 6 次真实请求，T-002 恢复 in_progress；ABBAAB 比较全历史与仅最近两张结果图片，固定任务/模型/低思考/传输，不执行返回动作。
- 2026-09-24: 六次请求全部完成；新增 T-003 开始实现可选投影，T-002 的最终交付依赖 T-003。桌面占用仍未解除。
- 2026-09-24: T-003 测试与仓库检查通过，标记 done；重新运行 desktop 全部定向测试，113 passed / 1 GUI skipped。T-002 等待桌面和设置选择，标记 blocked。独立构建发现源码与旧 dist 声明冲突，未安装。

### 固定请求 A/B 证据

最新安装状态：用户确认后已将 `/Users/w/.epi/agent/settings.json` 的 `images.computerHistory` 设置为 `recent`，原配置备份在 `/tmp/easy-pi-computer-latency.WQKu7w/settings-before-recent.json`。使用项目已有 `tsconfig.product-build.json` 联合编译通过，确认 sdk.js/settings-manager.js 差异仅为本次功能后，仅安装这两组产物及新 context 模块；旧产物备份在同目录 installed-backup。安装后真实 SettingsManager 读取 recent、SDK import 和 3 图存档/2 图投影断言通过，无模型或桌面调用。原独立构建配置的声明环依赖不再作为交付阻塞。运行中的旧进程需完整重启；select+observe bridge 候选仍未安装。T-002 恢复 in_progress，下一步是租约核验和 GUI 验证。

同一原会话截止 03:05:42.658 UTC 的历史，gpt-6-astra / low / SSE，maxTokens 1024、maxRetries 0；按 ABBAAB 顺序请求，A/B 各自独立缓存键、同组重复相同载荷。每组仅 3 次，不提供可靠尾延迟或完整任务质量结论。

| 指标 | A 全部截图 | B 最近两组 |
| --- | --- | --- |
| 图片数 | 15 | 2 |
| 单次原始耗时（秒） | 23.588 / 29.043 / 33.368 | 11.816 / 6.296 / 9.529 |
| 平均耗时（秒） | 28.666 | 9.214 |
| 请求字节 | 10,285,111 | 654,384 |
| 输入 token（含缓存） | 61,506 | 28,922 |
| 返回动作 | 3 次 observe | 3 次 observe |

固定请求平均耗时降低 67.9%，请求体降低 93.6%。首个请求两组均无缓存；后续两组均命中缓存，A 的缓存命中并未消除等待。序列化均低于 1.6ms，等待主要在流首事件之前；无法仅凭此区分上传、网络与服务端排队/处理。投影滚动时缓存边界和任务成功率尚未实测，不能外推整体任务速度。旧图片仍存档，模型失去旧图片视觉细节是明确代价，默认 all 未改。

原始无凭据指标：`/tmp/easy-pi-computer-latency.WQKu7w/model-ab-results.jsonl`；实验脚本：同目录 `model-ab.mjs`，真实调用由 `PI_REAL_MODEL_EVAL=1` 门控；6 次额度已耗尽，未经新授权不重跑。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 与 T-003 本地测试通过；6 次模型对照完成；快速截图设置及对应本地产物已安装验证。T-002 仍待 bridge 安装与真实窗口验证。
- Limitations: 不能把减少一轮调用换算成已证明的端到端加速；未补齐 117.5 秒间隔的遥测。
