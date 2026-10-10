# Task Plan: TUI 性能审查与优化

- Created: 2026-10-10
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户「审查并优化 easy-pi tui 性能」

<!-- task-doc-section:background-goal -->
## Background and goal

审查实际渲染路径，复现离线长会话负载，优化有测量支持的 CPU 热点；区分组件帧测量与真实终端延迟。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：packages/tui 共享渲染路径及必要回归测试。本轮以仓库已有 fullscreen render-churn 负载定位。
不修改模型调用、依赖、生产配置或其他人的文件；不运行真实 API、全量测试或构建。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | regular/fullscreen、pi/grok 都使用 pi-tui 底层渲染 | interactive-mode.ts createInteractiveTui；grok-tui-runtime.ts |
| F-002 | 已有长历史模拟帧基准，600 组件、1900/4800 行、100x30 与 80x24 | packages/tui/test/render-churn-bench.ts |
| F-003 | baseline profile 中 visibleWidth、graphemeWidth 自耗时突出；该次启用 heap sampling | /tmp/easy-pi-tui-performance/baseline.cpuprofile；baseline-churn.txt |
| F-004 | 开始时有其他任务的 LEARNS.md 修改与未跟踪文件 | git status --short；不暂存这些文件 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 现有长历史基准可代表底层渲染成本，但不代表所有用户会话；用无采样独立进程 A/B 确认组件收益。
- Open question: 真实终端 paint/传输延迟和用户主要卡顿场景尚未提供，不阻塞共享计算热点的有界优化。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 热点归因有 profile、静态因果链及单变量验证。
- 候选不改变 ANSI、Unicode、tab、宽字符换行与输出行为；定向测试通过。
- 多次独立进程同负载 A/B，记录 wall/CPU/输出校验；不夸大为真实终端收益。
- npm run check 与 diff 审查；只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003；T-002 -> T-004 -> T-005（不依赖提交）。
- Parallel batches: T-001 内 coordinator 测量与 tui-static-review 只读审查可并行。
- Serialization constraints: 代码、测试、文档仅 coordinator 编辑；审查 child 只有 read 权限。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 归因与基线

- Status: done
- Owner: coordinator + tui-static-review（只读）
- Objective: 找到有证据支持、可安全消除的渲染成本。
- Inputs and prerequisites: AGENTS.md；runtime adapter；现有基准。
- Scope or files: packages/tui/src、packages/grok-tui/src/grok-tui-runtime.ts、临时测量脚本。
- Expected output: baseline 与 ranked hypotheses。
- Dependencies: None.
- Execution steps:
  1. 读取路径与现有测试；执行 profile 与无采样基线。
- Acceptance criteria:
  - 测量范围、环境、局限、因果候选可复现。
- Verification method:
  - CPU profile + 相同输入输出 oracle。
- Validation evidence: baseline.cpuprofile 自耗时 visibleWidth 429.7ms / graphemeWidth 272.6ms；无采样 baseline-plain-1.txt resize 5.627 wall ms/frame、6.044 CPU ms/frame；输出 SHA256 已记录。单字符 ASCII 仍走 Unicode regex/数组分配，拟单变量短路试验。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 最小优化与回归

- Status: done
- Owner: coordinator
- Objective: 消除已归因的多余工作，保持语义。
- Inputs and prerequisites: T-001 热点证据。
- Scope or files: packages/tui/src/utils.ts 及必要定向测试。
- Expected output: 有界 diff 与回归验证。
- Dependencies: T-001.
- Execution steps:
  1. 单变量试验，选择有价值的干预，添加测试。
- Acceptance criteria:
  - Unicode/ANSI/宽度输出一致，性能效果超过重复测量波动。
- Verification method:
  - 独立 A/B + node --test 定向测试。
- Validation evidence: 五次交错 fresh-process A/B：mixed resize 5.7323 -> 4.6262 wall ms/frame、6.1474 -> 5.0434 CPU ms/frame；ASCII resize 5.7484 -> 1.9604 wall ms/frame。每 workload 十份输出摘要一致。432 定向测试全部通过；2000 确定性输入 x 5 函数与 baseline 相等。详见下方最终测量。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 复核、全局检查与交付

- Status: in_progress
- Owner: coordinator
- Objective: 验证正确性与资源，报告局限并提交。
- Inputs and prerequisites: T-002 候选。
- Scope or files: 本任务 diff、报告、计划。
- Expected output: 检查结果、最终测量、独立审查与 commit。
- Dependencies: T-002.
- Execution steps:
  1. 定向测试、重复 A/B、复测 profile、独立审查、npm run check、核对 diff 与提交。
- Acceptance criteria:
  - 全部要求有真实验证证据，未验证范围清楚。
- Verification method:
  - task_document validate + 定向测试 + npm run check + git diff。
- Validation evidence: 独立 read-only 审查无可行动问题；432 TUI 定向测试通过，新增测试强化精确文本比较后重跑 3/3 通过；tsgo --noEmit、Bi​​ome 两文件、shrinkwrap、install-lock、browser-smoke 通过；全局 Biome 1532 files No fixes applied；npm run check 两次在 pinned-deps 失败，独立 check:ts-imports 在同批 untracked 参考材料的 .js imports 失败。检查结果与最终 diff 已复核，尚未提交。
- Blocker: None. 用户已授权干净工作树正常检查/提交hook后推送easy-pi/main；不移动原诊断材料。
- Unblock condition: None. 发布过程中若HEAD漂移、检查或非fast-forward推送失败，停止/重新验证，不force push，不覆盖他人修改。

### [x] T-004 — 长历史滚动锚点测量

- Status: done
- Owner: coordinator
- Objective: 用户选择继续性能调查、不提交；验证批量删除历史时的锚点恢复复杂度及应用触发条件。
- Inputs and prerequisites: T-002 当前补丁与先前静态审查，scroll-view.ts、layout.ts 和 layout.test.ts。
- Scope or files: 工作树只读；允许 /tmp 测量与单变量实验副本；仅此任务文档写入状态/结果。
- Expected output: 按历史规模、删除比例、follow-end/阅读模式的 frame wall/CPU 与锚点成本归因；应用相关性与剩余证据缺口。
- Dependencies: T-002.
- Execution steps:
  1. 测量 unchanged / surviving anchor / deleted anchor 规模曲线，定位第一成本分歧。
  2. 临时副本只改变缺失锚点后的身份查找，检查输出语义；不应用新的源码补丁。
  3. 追踪实际 transcript 重建路径，记录产品相关性和后续动作。
- Acceptance criteria:
  - 结论基于至少三次 fresh-process 相同负载，不夸大合成极端场景为真实用户卡顿。
  - 实验新旧 frame、scrollTop、scrollRevision、follow state 一致；源码未新增改动。
- Verification method:
  - CPU/wall 规模曲线、独立进程临时 A/B、输出与锚点断言、工作树 diff。
- Validation evidence: 三次 fresh-process baseline/eager/lazy 轮换、三种规模六种场景，行为 digest 九份一致。10000 组件 replace-all 布局 wall 91.6875 -> lazy 0.8515ms/op，锚点 91.3540 -> 0.5037ms/op；remove-one 反例暴露 eager 建表额外成本，lazy 避免首邻居命中时的建表。两种试验各 3000 随机组与显式 first-miss/duplicate/parent fixtures、clamp 前后状态比较通过。临时实验独立 read-only 审查无可行动语义问题。实际 modern compaction 不重建，settings rebuild 可触发但真实用户性能未测。git diff/cmp 证实 scroll-view.ts 未改、现有 utils.ts 补丁未漂移。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 实际消息流水线验证与最小优化

- Status: done
- Owner: coordinator
- Objective: 用户要求继续验证优化；以实际 UserMessage/AssistantMessage/TurnTranscript 组件及完整 fullscreen 渲染验证 lazy-index 的相关性和资源，证据充分后应用最小补丁；维持不提交。
- Inputs and prerequisites: T-004 的三版实验、应用重建路径及已有差分验证。
- Scope or files: packages/tui/src/components/scroll-view.ts、必要回归测试、此计划；/tmp 实际组件离线测量和验证副本；不修改其他文件或诊断材料。
- Expected output: 实际组件重建与小删除/嵌套布局的可复现 A/B，输出一致、资源成本、候选去留和回归结果。
- Dependencies: T-004.
- Execution steps:
  1. 使用 Node 临时 module-resolution hook 统一实际消息组件与baseline/candidate的TUI源码，避免误测旧dist；无项目构建、无API调用。
  2. 多进程 A/B 实际组件重建→renderNow，补小删除、follow-end、嵌套及sampling allocation；区分终端解析与绘制限制。
  3. 若验证通过，最小落地lazy索引与回归测试，定向测试、独立审查、原目录check及隔离check；不提交。
- Acceptance criteria:
  - 目标操作总时间与锚点/CPU一致改善，差异大于重复样本波动；不宣称真实TTY产品延迟。
  - 小删除、邻居和父级回退、重复identity正高度、reading/follow状态保持；没有可接受范围外的已测退化。
  - 修改前后输出oracle相同，代码diff仅本任务路径；未验证资源/平台诚实记录。
- Verification method:
  - 实际消息源码A/B、100x30输出hash/viewport、差分fixture、node:test、npm run check、独立read-only审查。
- Validation evidence: 已落地scroll-view.ts最小lazy Map索引和8回归用例；原版complexity用例90301 reads失败，候选线性上界通过；440指定TUI测试及3000差分通过，独立源码审查无可行动问题。canonical三进程A/B目标与follow-end控制完成；后续更代表性的同一TUI+固定消息对象池、50ms事件间隔，5000消息wall324.809→220.037ms、CPU353.500→247.007ms、anchor105.005→0.379ms；peakRSS572624→573008 KiB（约0.07%），GC后activeUIheap83219432→83220584 bytes，六份输出摘要相同。多UI批量压力峰值+121.59MiB仍记录为残余场景风险，不能推断全局内存无回归。decoder预期header/reading/dock/follow assertions通过，隔离完整check通过，原目录check仍因他人材料失败；不提交。
- Blocker: None. 多UI批量压力的RSS增量继续作为残余风险记录；代表性单UI/固定消息池复核未见相同峰值变化。
- Unblock condition: None. 已在原有验证授权内完成单UI复核，不更改生产GC策略或提交意图。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

无 heap sampling 的稳态组件帧 A/B（相同负载、预热、fresh starts），记录 wall ms/frame、CPU ms/frame、output digest；heap sampling 单独比较 churn。
定向 Unicode、ANSI、tab、wrap、layout、alt-screen 渲染测试；npm run check 按仓库规则运行后立即核对其他文件变化。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

真实终端及用户 workload 未测；主机共享负载无固定 CPU/power；heap sampling 扰动 timing，因此不用它单独证明收益。
宽度计算关系到 wrap/cursor，不用改变 Unicode 算法或无限缓存来换速度。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-10: 已读取规则与 learnings；识别 pi-tui 共享入口；并行委派 read-only layout 审查。
- 2026-10-10: 运行现有 churn benchmark + CPU profile，结果在 /tmp/easy-pi-tui-performance；下一步无采样 A/B。
- 2026-10-10: T-001 基线完成，T-002 开始。baseline 源码复制到 /tmp，A/B 同环境运行，不切换 worktree；先只优化已分段的单个 printable ASCII grapheme。
- 2026-10-10: T-002 完成：两个守卫严格的 ASCII fast paths、回归测试、五次交错 A/B，T-003 进入复核。独立只读审查未发现可行动 correctness 问题。
- 2026-10-10: T-003 校验已执行；全局 check 在他人 untracked computer-native 参考材料目录失败，不能修改这些文件或绕过 gate 提交。剩余校验拆开执行并记录。
- 2026-10-10: Grok 测试最初误用 Vitest（No test suite found），读 manifest 确认 node:test 后用 node --test 重跑 10/10 通过；其导入现有 dist，只作为 wrapper smoke，不证明本轮源码收益。
- 2026-10-10: 临时 dirty-file hash snapshot 超过 execFileSync 默认 maxBuffer，未形成前置快照；未声称 hash 验证成功。Bi​​ome 两次明确 No fixes applied，git diff 确认 tracked 改动仅原有 LEARNS.md 与本任务 utils.ts。
- 2026-10-10: T-003 转 blocked：最后一次 check 同样被既存材料阻断；保留代码、测试、此计划，不暂存、不提交、不清理他人文件。
- 2026-10-10: 用户要求继续；复核 HEAD、diff 和未跟踪材料均无漂移。为区分补丁与工作区阻断，将 HEAD tracked files 复制至 /tmp/easy-pi-tui-validation-aAYkm0，仅叠加本轮 utils.ts/测试，使用现有依赖运行完整 check；原目录不改动。T-003 提交部分仍 blocked（pre-commit 会在原目录重新运行 check）。
- 2026-10-10: 临时副本第一次 check 因缺少 gitignored 的本地 providers/data JSON 出现模型类型 never/unknown；从原目录复制同一份已生成数据（无下载、无 API 调用）后，完整 npm run check exit 0，1532 files No fixes applied。证明本轮补丁通过完整 gate，原工作区提交仍须解决材料路径；不跳过 pre-commit。
- 2026-10-10: 用户明确选择继续性能调查、不提交；保持材料原位和当前两个源码/测试文件，新增 T-004 进行长历史锚点的临时副本测量。
- 2026-10-10: T-004 pilot 暴露 V8 tiering 在 10000 行场景中途改变耗时，追加同路径的大规模预热，pilot 不用于最终收益结论。
- 2026-10-10: 第一轮 baseline/eager 三进程 A/B 证实批量丢失锚点的 repeated find 热点；独立审查要求检查小规模删除反例。新增 remove-one 和 lazy-index 实验，三版轮换比较，不混用前一轮数据。
- 2026-10-10: 连续审查指出固定 fixtures 未强制 first-neighbour miss；补显式 miss→重复正高度 survivor 和 all miss→重复 parent cases 后，两版差分再次通过。T-004 done；按用户选择无新源码补丁、无暂存/提交，T-003 继续 deferred/blocked。
- 2026-10-10: 用户继续验证优化，T-005开始：实际 UserMessage/AssistantMessage/TurnTranscript 源码 + full renderNow，Node hook统一源TUI，使用固定虚构消息、隔离agent目录，不调用API。先前启动的 timing批次与parser校验并行，整批停止并归档为 overlap-calibration，不用于结论；正式 timing/resource/parser 分开执行。
- 2026-10-10: 实际组件临时副本 A/B 支持目标改善；独立基准审查要求预期viewport断言和限制“实际组件+合成dock”口径。补header/reading sentinel、Thinking label、next prompt、末尾response及三行dock断言，两版decoder通过。
- 2026-10-10: 新 complexity 回归在原版失败（90301 identity reads）；应用最小lazy索引后通过。补parent-only、所有range消失与clamp；440定向测试、3000差分通过，独立补丁审查无可行动问题。隔离完整check通过，原目录仍因既有诊断材料失败且Bi​​ome无修改。
- 2026-10-10: 已落地源码的正式重复A/B目标仍改善，但follow-end冷重建约6–7%负向信号。T-005尚未标done；新增canonical单变量loader，仅替换ScrollView模块且其Container/layout-node依赖仍用工作树，其余TUI模块路径完全一致，单独follow-end和rebuild进程以区分源码复制/JIT/GC与补丁因果。
- 2026-10-10: canonical未复现follow-end退化。修正harness在操作之间不轮转事件循环、可能留住退役UI的queued nextTick问题；setImmediate drain置于timing/sampling之外，旧批次归档pre-drain，重跑完整canonical三进程矩阵，不混用旧数值。
- 2026-10-10: 默认GC重建批次RSS稳定出现约122MiB增量；更小的Set身份集合同样出现，未替换工作树Map。诊断性expose-gc在setup前和全部UI结束后执行fullGC，peak差额降至约3MiB，清理后的heapUsed相近，支持GC/heap cadence解释但不证明真实用户无峰值代价；没有把GC参数或调用加入产品。
- 2026-10-10: T-005暂转blocked记录资源权衡疑问，候选代码与测试保留未提交。不能把速度/正确性通过等同整体资源通过。
- 2026-10-10: 在原验证范围内追加更贴近app的同一TUI+固定消息对象池、50ms间隔偏好事件复核，期间保持default-GC，只在全部计时结束后GC测active UI heap。三进程A/B：324.809→220.037ms、peakRSS572624→573008 KiB、active heap83219432→83220584 bytes，六份输出digest一致。T-005恢复in_progress用于整合最终证据；多UI压力增量不删除，也不推断所有负载无回归。
- 2026-10-10: T-005 done，完成代表性单UI资源与延迟复核并保留最小Map补丁，不替换为无资源收益的Set。最后仅修正注释“no index”口径（不改变执行逻辑），源文件/测试与隔离check副本cmp一致，原目录check仍为同一材料阻断；git index为空，不提交。
- 2026-10-10: 用户要求push，并明确选择“干净工作树提交并推送”至配置上游easy-pi/main。T-003恢复in_progress；仅包含两个src、两个test和此计划，不移动诊断材料或提交LEARNS.md等他人文件。
- 2026-10-10: 发布前fetch观察到其他会话已推进HEAD/上游至e2296e848；原TUI差分仍在且index为空。查明实际core.hooksPath未设置、.git/hooks仅sample，没有已安装pre-commit；此前只读了跟踪的.husky/pre-commit而未核验安装，关于原目录hook会运行的表述是推断，不是实测。临时工作树将显式启用该跟踪脚本作为正常Git pre-commit，不能用配置缺失跳过检查。
- 2026-10-10: 用独立Git fixture验证“先stage匹配目标commit的owned路径再ff-only merge”保留其他dirty/untracked文件且不会留下owned staged差分；实际整合仍须检查HEAD和文件hash。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001、T-002、T-004、T-005 已完成；最小锚点优化在实际消息/完整renderNow和代表性单UI生命周期验证通过，440定向测试、差分、独立审查及隔离完整check通过。多UIburst的内存峰值风险保留，不宣称全部产品场景验证。T-003提交按用户选择暂停，原目录检查仍有他人材料阻断。
- Limitations: 没有真实设置事件/OS终端paint端到端测量，也没有实际用户会话、Grok业务布局、Bun、其他OS或真实API验证。不能推断全局TUI加速或全部内存场景无回归；多UIburst的RSS增量未被代表性单UI复现，但仍是残余风险。

### Performance contract

- Baseline revision: `0acd47f7dafd85a2cdb2addc643f9f7d5bfe8dbd`，分支 `my-pi`；原有 dirty 状态在上述范围外。
- Platform: Apple M5，arm64，Darwin 27.0.0，Node v24.15.0；没有固定 CPU affinity/power/frequency，主机可能有其他任务。
- Execution: Node 直接 strip TypeScript，无构建；baseline 复制 `packages/tui/src` 到 `/tmp/easy-pi-tui-performance/baseline-src`，candidate 使用工作树源码，同一运行时与依赖。
- Workload: 现有 `test/render-churn-bench.ts` 的 600 组件、collapsed 1900 行 / expanded 4800 行布局。包含 styled Latin、中文、emoji、Markdown、tool logs；ASCII 对照仅替换历史示例中的中文/emoji 文本，边框与主题保留。
- Measurement: 无 inspector 的 100 预热帧 + 每场景 300 测量帧；五次 fresh-process A/B，次序 AB/BA/AB/BA/AB；每帧测 renderNow + update，输出仅 NullTerminal SHA256 消费，无真实 TTY/transport/paint。editor 为缓存的模拟组件，连续增加字符；resize 每 10 帧在 80x24 和 100x30 交替。
- Targets/invariants: 降低相同组件负载的 wall ms/frame 与进程 user+system CPU ms/frame；不改变 Unicode/ANSI/宽度/输出，不增加无界缓存。没有用户给定 SLA，未宣称满足产品延迟预算。

### Baseline and bottleneck

MEASURED：现有 heap-sampling 基准附 CPU profile，自耗时 visibleWidth 429.7ms、graphemeWidth 272.6ms；该数据含 profiler 扰动，只用于定位。无采样基线 resize p95 约 56ms，平常缓存帧不到 0.1ms。

SUPPORTED INFERENCE：改变宽度使 Text/Markdown 的 width-keyed 渲染缓存失效，历史重新换行；visibleWidth 清理 ANSI 后仍分段 ASCII，graphemeWidth 对分段 ASCII 仍运行 Unicode regex、base replacement 与数组分配。成本在重排/width 计算边界集中，而非终端传输。

INTERVENTION：先只给已分段的单 printable ASCII cluster 返回 1，mixed resize 单次 5.627 -> 4.466ms/frame、输出 digest 一致；再对清理完 ANSI/tabs 的全 printable ASCII 字符串用长度计宽，保持 cache key/capacity/eviction 和所有 Unicode 分支不变。最后完整 A/B 确认下表变化。

未采用扩容缓存、跨帧 layout cache、共享 snapshot metadata、worker 或降低渲染频率：这些不是本轮证明的主因，且引入 retention/invalidation/行为风险。

### Optimization

仅修改 `packages/tui/src/utils.ts` 两个 fast paths，新增 `packages/tui/test/visible-width-ascii.test.ts`。95 个 ASCII 字符均覆测；combining、keycap、CJK、emoji、tab、control、malformed escape 保留原算法。未改依赖、公开 API、布局与渲染调度。

### Verification

下表为五个进程样本中位数，不是全部帧的产品延迟；wall/CPU 单位均为 ms/frame。

| Workload / scenario | Wall baseline → candidate | CPU baseline → candidate | Wall 变化 |
| --- | --- | --- | --- |
| mixed / collapsed | 0.0731 → 0.0764 | 0.1073 → 0.1348 | +4.4% |
| mixed / expanded | 0.0687 → 0.0674 | 0.1022 → 0.1011 | -1.9% |
| mixed / editor | 0.0958 → 0.0802 | 0.1027 → 0.0870 | -16.3% |
| mixed / resize | 5.7323 → 4.6262 | 6.1474 → 5.0434 | -19.3% |
| ASCII / collapsed | 0.0772 → 0.0663 | 0.1335 → 0.1219 | -14.0% |
| ASCII / expanded | 0.0683 → 0.0768 | 0.1024 → 0.1166 | +12.4% |
| ASCII / editor | 0.0949 → 0.0759 | 0.1014 → 0.0936 | -20.0% |
| ASCII / resize | 5.7484 → 1.9604 | 6.1552 → 2.3036 | -65.9% |

- mixed resize 各进程 wall 平均范围 B 5.6539–5.7900 / C 4.6054–4.6434；frame p95 的进程中位数 56.2445 → 45.1900ms。
- ASCII resize 平均范围 B 5.7261–5.7781 / C 1.9362–1.9775；frame p95 56.5065 → 18.9165ms。
- resize 效果大于这些重复样本的波动；未删除异常样本，未估计跨机器置信区间。
- 未变内容场景结果不一致，尤其 mixed collapsed CPU 及 ASCII expanded 有上升；wall 绝对差均 <0.01ms/frame。没有把它们描述为收益，也未证明差异完全来自噪声；如果用户主要关注 idle 重复帧，应单独扩大该负载的预热/时长分析。
- 每 workload 的十份 output digest 一致：mixed `d6b8b146c5dee2b24671b7e134bddceca7ba21a282553e0846c584b815fd113c`，ASCII `242665d8015faf536d5eb70474cd8f4528b630f323a023203f38f0219ba5bba3`；输出长度一致。原NullTerminal计数使用data.length（UTF-16 code units），不作为精确UTF-8字节数；T-005另用Buffer.byteLength。
- 单独 heap sampling 同 mixed 负载 resize churn 9776.0 → 7444.1 KiB/frame；只一次 sample，不用它证明精确资源下降幅度。重测 profile graphemeWidth self 272.6 → 58.5ms，符合减少分类/分配预测。未测 peak RSS/retained heap/功耗。
- `node --test` 15 个指定 TUI 测试文件：432/432 pass；强化新增断言后重跑新增文件 3/3 pass。覆盖 editor、Markdown、ANSI、Unicode、tab、layout、snapshot、alt-screen、regular renderer、overlay 与输出安全。
- `/tmp/easy-pi-tui-performance/differential.mjs`：2000 确定性 mixed 输入，对 visibleWidth/sliceWithWidth/getGraphemeCellRange/truncateToWidth/wrapTextWithAnsi 共 10000 项与原版相等。
- 独立 child `ascii-fastpath-verify` 仅 read，无可行动 correctness 问题；结论已由 coordinator 的差分测试与源码 diff 复核。
- `tsgo --noEmit`、定向 Bi​​ome、shrinkwrap check、install-lock check、browser-smoke 均 exit 0。原工作区 `npm run check` 不通过，见 T-003 blocker；没有为提交绕过检查。
- 继续阶段在 `/tmp/easy-pi-tui-validation-aAYkm0` 对 HEAD tracked files + 本轮两个源码/测试文件 + 相同本地依赖/生成 catalog data 执行完整 `npm run check`，exit 0，Bi​​ome No fixes applied，pinned-deps / ts-imports / shrinkwrap / install-lock / tsgo / browser-smoke 全通过。原文件与参考材料未移动，原工作区 pre-commit 仍阻断。

原始 samples、profile、脚本保留在 `/tmp/easy-pi-tui-performance/`，不纳入 worktree。复跑（不要重跑 prepare-bench 覆盖 baseline）：

```sh
node /tmp/easy-pi-tui-performance/run-ab.mjs
node /tmp/easy-pi-tui-performance/summarize.mjs
node /tmp/easy-pi-tui-performance/differential.mjs
# 原有 profiling/churn 基准，含采样扰动：
cd packages/tui
node --cpu-prof --cpu-prof-dir=/tmp/easy-pi-tui-performance test/render-churn-bench.ts
```

定向测试的完整命令与输出可对应 `/tmp/easy-pi-tui-performance/tests.txt`：

```sh
cd packages/tui
node --test test/visible-width-ascii.test.ts test/truncate-to-width.test.ts test/regression-regional-indicator-width.test.ts test/tab-width.test.ts test/wrap-ansi.test.ts test/truncated-text.test.ts test/markdown.test.ts test/editor.test.ts test/layout.test.ts test/layout-snapshot.test.ts test/tui-alt-screen.test.ts test/tui-render.test.ts test/tui-overlay-style-leak.test.ts test/regression-overlay-cjk-boundary.test.ts test/terminal-output-safety.test.ts
```

### Residual risks and bounded review findings

静态审查还观察到以下候选，均未在本轮证实为产品瓶颈，未修改：

1. `layout.ts` measureHeight/renderCached 与 `scroll-view.ts` render：auto-basis ScrollView 可能先渲染自身、随后按 child 身份再次渲染；数值 basis 不走该重复路径。下一步：auto-basis 长历史计数 + 同帧 child cache 试验，覆盖 always scrollbar。
2. `tui.ts` Container.render 与 `layout.ts` 的 snapshot 捕获：所有历史行遍历与嵌套 metadata 拷贝；不能直接共享可变 maps，因为 layout-snapshot.test.ts 要求外部 render 不能改变已显示几何/handler。下一步：按深度/历史长度扫描分配，不破坏 snapshot 边界。
3. `scroll-view.ts` updateContentRanges：anchor 删除后邻居循环反复 ranges.find，极端候选 O(NM)；follow-end 跳过此逻辑。下一步：批量移除/重排长历史的规模扫描与身份索引对照，保留优先顺序和零高度语义。

产品端到端收益、终端 parser/paint/网络背压以及真实 streaming 卡顿仍 UNKNOWN。下一轮应先获取用户实际 session/模式/终端及响应性目标，再选择最早成本分歧，而不是盲目扩展此 patch。

### T-004 继续调查结果：丢失阅读锚点的复杂度

本阶段按用户选择只调查、不提交。工作树没有新增性能代码；baseline/eager/lazy 三个版本均复制到 `/tmp/easy-pi-tui-performance/anchor-*-src`。baseline 含先前 ASCII 补丁，另外两版只改变缺失锚点后的身份查找。

**Contract**：同一 M5 / Node v24.15.0，100x30 viewport，一行一个缓存 Row 组件的 Container；N=1000/5000/10000。setup、初始两帧、滚动、内容变更、最终断言与 digest 均不计入计时；只测一次 `renderLayoutFrame`，内部包裹 `updateContentRanges` 定位成本，记录进程 CPU。不是完整 app 操作、真实终端或消息 Markdown 渲染。

每进程先在 600 组件六场景预热15轮，再在10000组件六场景预热10轮；每种规模/场景追加1次未计入样本的执行，然后5样本取中位数，最终再取3进程中位数。三版次序 B/E/L、E/L/B、L/B/E；不删 outliers。预热相同不等于已证明 V8 同一稳态，微小非目标差异不作收益结论。

**MEASURED — v2 最终共同负载**（单位 ms/布局操作；CPU 为 user+system）：

| 组件数 / 场景 | Baseline wall | Eager-index wall | Lazy-index wall | Baseline CPU → Lazy CPU |
| --- | --- | --- | --- | --- |
| 1000 / 全部替换 | 0.8764 | 0.0815 | 0.0885 | 0.8790 → 0.0910 |
| 5000 / 全部替换 | 23.5252 | 0.4047 | 0.4268 | 23.5040 → 0.4270 |
| 10000 / 全部替换 | 91.6875 | 0.8191 | 0.8515 | 91.8910 → 0.8530 |
| 1000 / 删除前90% | 0.1037 | 0.0323 | 0.0339 | 0.1040 → 0.0380 |
| 5000 / 删除前90% | 2.0059 | 0.1107 | 0.1207 | 2.0070 → 0.1230 |
| 10000 / 删除前90% | 7.5865 | 0.2195 | 0.2285 | 7.5890 → 0.2320 |
| 10000 / 只删除anchor，next立即存活 | 0.4463 | 0.7626 | 0.5022 | 0.4470 → 0.5030 |
| 10000 / anchor仍存活 | 0.0490 | 0.0530 | 0.0540 | 0.0500 → 0.0560 |
| 10000 / 内容不变 | 0.3347 | 0.3832 | 0.3790 | 0.3380 → 0.3800 |
| 10000 / follow-end时全部替换 | 0.3326 | 0.3393 | 0.3407 | 0.3340 → 0.3440 |

**Causal evidence**：5000→10000、全部替换的 baseline 耗时约3.90倍；删除前90%约3.78倍，符合二次规模增长。10000全部替换的锚点阶段 91.3540ms，占布局约99.6%；lazy 该阶段0.5037ms，whole-layout0.8515ms，预测资源与总时间一起移动。单独 CPU profile（第一轮6种场景补充前的5场景负载、含预热）自耗时 `updateContentRanges` 2931.3ms、其 repeated-find callback 874.0ms；profile 只定位，不与无采样 wall 混算收益。

**机制和反例**：`scroll-view.ts:202–253` 在旧anchor失效时，按 next→previous→parent 遍历旧ranges，每个候选 `ranges.find` 扫描新ranges；N个旧候选、M个新range，极端身份全丢失造成 O(NM) 查找。follow-end 跳过恢复；anchor存活时仅线性定位，不是相同热点。临时 eager 版一次构建首个正高度的 component identity Map，消除重复扫描，但 remove-one 反例 wall从0.4463上升到0.7626，锚点0.1280→0.3946；不能直接推广 eager 方案。

临时 lazy 版首个邻居仍用原find，只有该查找 miss 后建表并复用；首邻居命中不建表，锚点0.1352ms接近baseline0.1280ms。整个 remove-one wall仍0.5022vs0.4463ms，未证明无回归；10000内容不变也有0.0443ms差异。因此这只是更合适的候选，并非已验证的产品优化。Map 增加 O(M) 短期索引内存，未测分配/GC/峰值内存，也未评估少量parent、多层嵌套的最坏分布。

**Behavior**：三版九次进程摘要相同：`a43bddeada0caeb5ed6f06f55eef40afdeb6b7ebc4d131923e79234bfb6b764c`。每次操作都断言首屏行、scrollRevision与follow state；摘要包含全部可见行、scrollTop和状态。额外 eager/lazy 各3000确定性range组，对clamp前后状态差分，并显式覆盖 first miss→首个正高度重复identity，以及所有邻居消失→parent fallback。两版通过。独立只读核验与连续lazy复核未发现语义问题；协调者补足其指出的fixture覆盖缺口后重跑。

**应用相关性，SUPPORTED INFERENCE 而非产品复现**：
- `tui-alt-screen.ts:1378–1386` 每次 fullscreen 帧调用 `renderLayoutFrame`；`interactive-mode.ts:954–958,1272` 将继承原生 Container.render 的 TurnTranscriptContainer 放入 document/ScrollView，默认follow=end。
- `interactive-mode.ts:4307–4310` 的 rebuildChatFromMessages 清空旧chat，再渲染新消息组件。hideThinking/cache-miss-notices/output-padding（非streaming）设置路径在5321–5386附近会调用重建；在用户滚动阅读旧消息时，组件身份替换可能触发此成本。
- `interactive-mode.ts:3749–3759` 只有 legacy compaction 清空重建；modern replacement checkpoint 保留用户可见transcript并追加summary。不能把此热点归咎于所有compaction或普通streaming。
- 本轮没有对真实消息树、设置操作或真实session执行上述流程；大量cached单行Rows突出锚点成本，不证明真实用户存在91ms卡顿。

**Next discriminating action**：若后续授权将候选落地，应使用实际消息类型在 fullscreen、scroll-up 状态复现设置重建，测操作到最终viewport的延迟；补少量删除/嵌套/父级-only分布及索引分配、GC；再判断保留lazy index、提前判空或更高层保持组件identity哪项更适合。当前不新增源码补丁，不提交、不移动诊断材料。

原始数据：`anchor-v2-{baseline,index,lazy}-{1,2,3}.txt`、`anchor-v2-summary.json`；代码：`anchor-bench-template.ts`、`prepare-anchor-experiment.mjs`、`run-anchor-v2.mjs`、`anchor-{lazy-,}differential.ts`。全部位于 `/tmp/easy-pi-tui-performance/`，可复跑：

```sh
node /tmp/easy-pi-tui-performance/run-anchor-v2.mjs
node /tmp/easy-pi-tui-performance/anchor-differential.ts
node /tmp/easy-pi-tui-performance/anchor-lazy-differential.ts
```

最终 `cmp` 确认原 scroll-view.ts 与 baseline副本相同，utils.ts 与前阶段通过完整check的副本相同；git index为空。

### T-005 实际组件验证、最小优化与资源复核

范围：真实 UserMessageComponent / AssistantMessageComponent / TurnTranscriptContainer 源码，synthetic dock 的100x30 fullscreen布局，真实TuiAltScreen.renderNow，RecordingTerminal消费终端字节；没有真实设置事件入口、Editor/status业务或OS终端paint/传输。所有消息为固定虚构内容（CJK/emoji/Markdown/code/thinking），不读用户会话、不调用API。Node module hook使消息与TUI类型来自同一源码，instanceof Container断言防止误用dist。

初始actual-component测量在TUI全源码副本和工作树间比较，follow-end出现6–7%反向信号。最终采用canonical hook：两版其余全部TUI模块URL和依赖均相同，仅baseline ScrollView从原版文件加载，并将其Container/layout-node也映射回工作树。该控制未复现相同退化，不能把首批差异定为补丁回归或简单宣称全部只是噪声。

每个case独立进程，仅该case在600消息预热3次；2000/5000消息各1次同规模预热、7次样本；每进程中位数再取三进程中位数，A/B、B/A、A/B顺序。timing从chat.clear+实际组件构造/删除/折叠开始，到完整同步renderNow输出结束；初始UI、校验、decoder、cleanup和event-loop drain不计入。rebuildMs与anchorMs都是总wall子区间，不能相加。没有固定主机power/affinity，保留全部raw samples。

**最终canonical default-GC测量**（ms/操作；RSS为整个进程批次最大值，包含setup与多次UI，不是单次操作的额外RSS）：

| 场景 / 消息数 | Wall baseline → candidate | CPU baseline → candidate | Anchor baseline → candidate |
| --- | --- | --- | --- |
| 重建 / 2000 | 102.545 → 85.769 | 118.227 → 100.998 | 17.548 → 0.265 |
| 重建 / 5000 | 322.827 → 212.153 | 353.277 → 241.747 | 110.027 → 0.432 |
| follow-end重建 / 2000 | 85.087 → 85.104 | 99.140 → 99.798 | 0.002 → 0.002 |
| follow-end重建 / 5000 | 211.579 → 211.212 | 240.911 → 240.174 | 0.001 → 0.001 |

5000目标wall下降34.3%，CPU下降31.6%；baseline三进程wall中位数316.897–322.887ms，candidate211.087–214.128ms；移除二次查找的预测子成本和总成本一起移动。follow-end两版范围重叠，没有索引分支收益主张。全矩阵的先前control显示600/2000消息删除和折叠差异<0.03ms/op，但GC-heavy 5000消息control不稳定，未用它声称普遍加速。

**多UI批量压力的资源警示（后续单UI复核见下文）**：
- default-GC重建批次：peakRSS baseline457712 KiB（446.98MiB）→candidate582224 KiB（568.58MiB），增量121.59MiB，约27.2%。三次baseline457632–458976 KiB，candidate581920–582416 KiB，不能丢弃或说没有变化。
- 同一baseline的临时Set版只缓存正高度组件身份，命中后沿用原find取首个正高度range；速度321.538→215.720ms（5000），但peakRSS458176→582976 KiB，未解决上述权衡。Set仅/tmp，不改源码。
- 诊断性full-GC在操作setup之前与全部虚拟UI结束后执行，timing以外；相同三进程对照peakRSS367056→370144 KiB（差3.02MiB），清理后heapUsed23188248→23347632 bytes（约22.11→22.27MiB）。该有限生命周期未显示同量级保留堆增加，支持GC/heap scheduling参与峰值变化的推断；不是生产配置证明，不能替代default-GC结果，也不能证明所有工作负载无泄漏。
- 600消息三进程4096-byte heap allocation sampling，包含已GC对象，重建中位数54662.9→54546.8 KiB/op；其他cases约3.2MiB/op相近。是churn估计，不是精确总量或retention。此阶段sampling与普通timing分开运行。

**候选实现和正确性**：已将Map lazy索引写入 `packages/tui/src/components/scroll-view.ts`：只有replacement缺失且首个neighbour查找miss后建表，忽略零高度，同identity只存首个正高度range；后续neighbour和parent复用。排序、next→previous→nearest-parent与clamp保持原样；没有跨帧缓存、公开API或新持久字段。

`packages/tui/test/scroll-view-anchor.test.ts` 新增8个node:test用例。原版complexity测试失败，90301次new-range identity reads；候选通过线性上界，并保护first-neighbour hit无额外索引、重复/零高度、稳定ties、nearest parent、parent-only、全消失以及viewport clamp。16个指定TUI测试文件440/440通过；3000确定性range组与显式miss/duplicate/parent fixtures的工作树差分通过。独立源码审查没有可行动语义问题（先审6用例，协调者据其缺口补2用例并重跑）。

另外，decoder独立运行（不作为性能采样）回放initial+delta到xterm/headless，断言header、阅读thinking sentinel/局部行、collapse标签、删除后的next prompt、follow-end最后response与三行dock；baseline/candidate完整viewport digest相同。只验证文字/字节及scroll state，未验证硬件cursor、styles属性或OS绘制。

完整check：工作树原命令已跑两次，Biome1533 files No fixes applied，仍因既有computer-native材料pinned-deps失败；同一源码/两个新测试叠入原隔离目录 `/tmp/easy-pi-tui-validation-aAYkm0` 后完整npm run check exit0（pinned-deps、ts-imports、locks、tsgo、browser-smoke全部通过）。不绕过hook、不提交、诊断材料原位不动。初期两文件局部formatter修正只作用本任务路径。

**代表性单UI复核与最终决策**：先前burst每次创建新TUI并新建虚构消息数据，不等同于app保留同一renderer/session消息池的偏好切换。补测一个持续存活TUI、固定5000条消息对象池，每次仅重建显示组件并toggle thinking，操作间50ms间隔并轮转事件循环；3次预热+7个测量操作，三进程交错A/B。处理过程采用default-GC，只有全部计时结束后才收集active UI的GC后heapUsed；peakRSS包含该进程全生命周期。没有给生产加入GC调用或参数。

| 单UI5000消息 | Baseline | Candidate |
| --- | --- | --- |
| Wall ms/操作 | 324.809 | 220.037 |
| CPU ms/操作 | 353.500 | 247.007 |
| Anchor ms/操作 | 105.005 | 0.379 |
| Peak RSS KiB | 572624 | 573008 |
| Active UI heapUsed after GC bytes | 83219432 | 83220584 |

目标wall下降32.3%、CPU下降30.1%；baseline各进程wall中位数324.403–325.169ms，candidate219.377–220.397ms，效果超过这些重复样本波动。代表性peakRSS中位数仅差384 KiB（约0.07%），baseline571648–573264 / candidate572272–574816 KiB范围重叠；活跃UI堆中位数差1152bytes、各进程范围重叠。没有观察到burst中的同量级内存增量或持久索引留存；这不证明长期无泄漏或所有场景peak相同。

六个进程在十次操作的完整delta输出、scrollTop、scrollRevision上digest一致：`6ac4fec3569e5d822c2ede30ee8ba616eb6fbceb350ab76444f898b16f00e04a`。每次断言失去旧组件身份后仍按原策略回到header/local fallback、保留非follow与revision；候选没有改变用户阅读/导航语义。

**状态**：T-005 done，保留最小Map索引和8个回归测试，未提交。速度、正确性和代表性单UI资源验证通过；多UIburst的+121.59MiB压力结果仍记录，不能外推全局内存安全。没有执行真正settings入口、真实Editor/status业务或TTY paint；下一步若针对burst/模式切换，应使用实际应用单UI/生命周期和明确内存上限，而非用GC诊断代替默认配置验收。先前ASCII优化保持不变。

Artifacts（均在 `/tmp/easy-pi-tui-performance/`）：`canonical-summary.json`与12份canonical-case raw、`canonical-set-summary.json`、`canonical-gc-summary.json`、`real-allocation-summary.json`、`real-parser-assert-{baseline,lazy}.txt`、`t5-tests.txt`、`t5-final-root-check.txt`；复制/JIT/旧lifecycle矩阵只作校准记录，位于`real-production-summary.json`和`pre-drain/`，不与最终数值混算。代表性资源最终补测：`single-ui-summary.json`及六份`single-ui-{baseline,candidate}-{1,2,3}.txt`，代码`single-ui-bench.ts`、`run-single-ui.mjs`。

复跑最终canonical/default-GC：`node /tmp/easy-pi-tui-performance/run-canonical-control.mjs`；诊断性GC：`node /tmp/easy-pi-tui-performance/run-gc-diagnostic.mjs`。代表性single-UI复跑：`node /tmp/easy-pi-tui-performance/run-single-ui.mjs`。这些是组件/渲染层实验，不是完整真实设置事件或产品端到端预算验证。
