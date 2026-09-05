# Task Plan: 修复 V2 工具范围、策略、分页与 overlay 隔离缺陷

- Created: 2026-09-06
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户在四项已复现审查发现后授权“执行修复”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复 V2 工具间的范围授权、访问策略、分页完整性与 overlay 隔离契约。不继续 Native/V2 对比或历史 usage 恢复。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：Read/Edit 可见范围绑定、Read 目录续页、Search 后代符号链接策略、Node overlay 链接映射；永久本地回归测试、定向集成验证与提交。
不修改历史 tool-profile-eval 文件或结果，不启用真实 provider/embedding，不改变默认工具 profile，不扩大到其他推测性审查发现。用户后续授权 T-005：仅在本地修复新包检查阻塞，将已有开发依赖固定为仓库现有版本、离线同步根锁文件，不升级其他依赖。阻塞包与锁文件改动不纳入 V2 提交，其他未跟踪文件保持不动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 基线为 5de490989，tracked/index 无修改 | 开工 git status/diff |
| F-002 | 字节读取第 2 行可授权修改重复的第 1 行，部分行视图可修改未展示后缀 | 前轮 3 项本地复现；read-v2.ts:749、edit-v2.ts:274 |
| F-003 | deny-outside 策略下 Search 跟随后代链接仍返回外部文本，Read 拒绝该路径 | 前轮 2 项本地复现；search-v2.ts:669 |
| F-004 | 12 个长文件名、limit=10/maxBytes=512，游标遍历只返回 4 个 | 前轮分页复现；read-v2.ts:641 |
| F-005 | overlay 的内部绝对目录链接仍指向 base，pending_acceptance 前已写 base，discard 无法撤销 | 前轮绝对/相对链接对照；node-overlay-mutation-backend.ts:303 |
| F-006 | 现有 19 个定向测试文件、198 项通过仍未覆盖上述缺陷 | 前轮本地 Vitest 输出；8 项补充观察断言确认缺陷 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 在现有 best-effort pathname（非 OS sandbox）边界内修复稳定链接场景；不承诺消除恶意并发换链竞态。
- Open question: 无阻塞性产品决策。保留可安全实现的片段编辑与工作区内链接功能，不以简单删除能力代替修复。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 原始四项缺陷有永久失败前/通过后的回归证据；合法相邻行为保持。
- View-bound Edit 仅修改实际展示范围，字节偏移不产生虚假行授权。
- Search 不返回禁止的后代路径/文本，策略覆盖跟随链接的遍历；不把被跳过范围冒充完整无匹配。
- 目录续页不跳过预算裁掉条目，最终无遗漏；保留 scope/provider/generation 与过期约束。
- overlay apply/失败/discard 在接受前不改变 base；内部链接仍可安全使用，越界目标拒绝。
- 定向功能与集成测试、根 npm run check、diff 与任务文档验证通过；只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 / T-002 / T-003 / T-005 -> T-004；T-005 为用户追加授权的本地检查解阻任务。
- Parallel batches: 三个边界清晰的实现任务同一 DAG；协调者串行整合和验收。
- Serialization constraints: Read/Edit/目录分页共享 read-v2.ts，由同一 Writer 处理；Search 与 overlay 独立 owned paths。任务文档只由协调者修改，根检查与提交由协调者统一执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 修复可见范围绑定与目录分页

- Status: done
- Owner: read-edit-recover
- Objective: 修复 F-002/F-004，保持合法范围编辑。
- Inputs and prerequisites: F-001/F-002/F-004；已授权实施。
- Scope or files: Agent Read/Edit、tool-state/read-provider 与必要环境范围类型；专属回归测试。
- Expected output: 可见范围授权与无遗漏游标实现、永久回归。
- Dependencies: None.
- Execution steps:
  1. 阅读完整模块，添加原始缺陷失败测试，实施最小修复并运行定向验证。
- Acceptance criteria:
  - 片段编辑不修改未展示字节或错误行；目录输出预算不跳过条目。
- Verification method:
  - 定向 Vitest 回归、Read/Edit/ledger 和 provider 相邻测试。
- Validation evidence: 子任务原实现 runtime 回归 6 failed，unit 回归 9 failed/1 passed（/tmp/pi-t001-{runtime,unit}-red.log）；主仓库复测新增 16 项及相邻测试全部通过，见 V2 执行记录。合法片段编辑覆盖三个 dialect、UTF-8/BOM/CRLF、显式 range 收窄；目录覆盖跨页/最终页/零条目适配、过期与 scope。源文件在隔离根检查通过副本中逐个 cmp 相同。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 修复 Search 工作区策略

- Status: done
- Owner: search-policy-recover
- Objective: 修复 F-003 的后代链接访问绕过。
- Inputs and prerequisites: F-001/F-003；已授权实施。
- Scope or files: Search core/provider/workspace-policy 与本地 Search provider、必要 structured provider、专属测试。
- Expected output: 遍历及结果受策略约束、永久回归。
- Dependencies: None.
- Execution steps:
  1. 阅读完整相关模块，添加失败回归，落实策略并验证合法链接、拒绝边界与覆盖信息。
- Acceptance criteria:
  - 策略禁止的文本不可返回；跟随链接不能放宽外部读取权限。
- Verification method:
  - 合成目录 Node runtime 回归、Search/schema/local/FFF/structured 定向测试。
- Validation evidence: 子任务原实现两项 runtime 链接策略回归失败；主仓库新增 10 项及 Search/schema/local/FFF/index 相邻测试通过。直接检查 provider 结果为空，非仅核心事后过滤；合法内部链接、rg/fd 特殊字符路径、结构化文档策略均覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 修复 overlay 链接隔离

- Status: done
- Owner: overlay-recover
- Objective: 修复 F-005 的接受前 base 写入。
- Inputs and prerequisites: F-001/F-005；已授权实施。
- Scope or files: node-overlay-mutation-backend.ts 及专属测试。
- Expected output: 内部链接正确重映射、越界写拒绝、回归测试。
- Dependencies: None.
- Execution steps:
  1. 阅读完整 backend，失败前回归，修复映射/包含性检查并验证 apply/discard/accept。
- Acceptance criteria:
  - 绝对/相对内部链接都维持 pending 前 base 不变；拒绝危险目标无外部写。
- Verification method:
  - Node overlay 与 runtime 本地回归，邻接后端测试。
- Validation evidence: 子任务原实现 15 failed/7 passed；主仓库 overlay backend 18 项、runtime 4 项及 journal/profile 相邻测试通过。绝对/相对/绕父目录内部链接覆盖 apply/discard/accept 与 validation failure；外部/悬空/循环链接及各类写端点失败关闭。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 整合审查、验收与提交

- Status: done
- Owner: coordinator
- Objective: 独立检查实现与原始复现，验证跨工具契约并提交。
- Inputs and prerequisites: 三个实现任务的 diff、测试证据。
- Scope or files: 本任务变更及本 authority document。
- Expected output: 经验证的有限修复提交和诚实结论。
- Dependencies: T-001, T-002, T-003, T-005.
- Execution steps:
  1. 审查差异并复核原始场景，运行定向集成测试、根检查和文档校验。
  2. 核对无无关修改，显式 staging 并提交。
- Acceptance criteria:
  - 所有接受条件有运行证据，未验证边界明确列出。
- Verification method:
  - 定向 Vitest、npm run check、git diff --check、task_document.py validate。
- Validation evidence: 主仓库 24 文件 / 271 passed / 1 既有 Windows skipped；隔离工作树完整根检查通过、15 项源码/测试逐个 cmp 相同。T-005 解阻后主工作区 npm run check 全部通过（含 tsgo/browser smoke）；git diff --check 与文档 validator 通过。15 个源码/测试已提交为 65832396ee1b93513dd8be2da364384304646138；普通 git commit 无跳过检查参数，根检查为提交前手动实际执行，不声称 hook 自动运行。包/锁文件未 staging，提交后只剩许可的本地解阻变更及既有无关文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 仅在本地解除新包检查阻塞

- Status: done
- Owner: coordinator
- Objective: 固定未跟踪 accounts 包已有开发依赖，解决必要检查错误，不纳入 V2 提交。
- Inputs and prerequisites: 用户两次明确授权处理阻塞包、离线同步根锁文件但仅保留在本地。
- Scope or files: packages/pi-codex-accounts/ 与 package-lock.json（仅解阻所需）。
- Expected output: 主根检查可通过；V2 提交不包含此包与锁文件。
- Dependencies: None.
- Execution steps:
  1. 固定到仓库已有 24.12.4 / 7.0.0-dev.20260120.1，离线 package-lock-only、ignore-scripts；检查无其他升级。
  2. 运行该包的针对性无网络测试与根检查，修复仅必要的检查错误。
- Acceptance criteria:
  - 不使用真实凭据/登录/远端调用、不升级其他依赖；本地解阻改动保持 unstaged。
- Verification method:
  - 锁文件 diff、该包定向 node tests、主根 npm run check、提交范围检查。
- Validation evidence: 两个开发依赖固定为仓库已有版本。npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund 成功；根锁文件仅新增该 workspace/link 与复用版本的嵌套类型条目，共 35 行，无其他升级。该包三个特定 Node test 文件 5/5 passed，主根 npm run check 全链通过。许可范围内保留其 3 个测试的 Biome 格式修正；包/锁文件均不 staging、不纳入 V2 提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

V1：每个 Writer 在旧实现上运行对应失败回归，再在修复后运行该文件与相邻测试。只运行列出的特定文件，不运行历史评测。
V2：协调者运行 Agent 核心 Search/Read/Edit/ledger/foundations/网关与 coding-agent profile/host/local/FFF/Node Read/index/journal/overlay/Bash/queue/网关，以及全部新增测试。
V3：根 npm run check（完整输出）；检查自动格式化没有触及无关文件；git diff --check 与任务文档 validator。
不运行 build、npm test、全量 Vitest 或真实远端服务。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 字节与 UTF-8/CRLF/BOM 坐标转换必须有相邻测试，不能以虚假行号绑定片段。
- 搜索策略不能只在泄露后过滤；被策略跳过的范围应明确标记。
- Overlay 是文件隔离而非命令沙箱，不扩大原有保证。
- 子任务报告须由协调者查看 diff 与复测后验收，不能自批准。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-06: 基于前轮四项已复现缺陷与用户明确授权建档；确认工作树无 tracked/index 修改，保留全部无关未跟踪文件。T-001/002/003 开始，准备同一 DAG 并行实施。
- 2026-09-06: DAG bf9791ee 中断，未合入任何产品变更。隔离 workspace 实际位于 easy-pi，ownedPaths 应带 pi/；旧任务发生路径审计拒绝，Search 子任务还遇到调用额度限制。Read/Edit 的报告及 overlay 临时验证副本只作待复核证据，不计完成。用户 continue 后恢复，纠正 ownedPaths；新增无关 packages/pi-codex-accounts/ 保持不动。
- 2026-09-06 01:40 +0800: DAG 83d747f3 完成，候选 ad79b519 的 15 个文件经 diff 审查和 git apply --check 后整合；主仓库 Agent 10 文件 133 passed/1 skipped，coding-agent 14 文件 138 passed。T-001/002/003 经协调者复核为 done；T-004 开始根验收。
- 2026-09-06 01:43 +0800: 主根 npm run check 在 pinned-deps 阶段失败（无关未跟踪 accounts 包）；Biome 自动格式化该包 3 个测试。以 DAG 启动前 snapshot 原件在临时同构配置重放 Biome，确认格式化输出逐字节等于现场后，恢复原件；cmp 确认 3 个文件与原 snapshot 相同，无无关修改保留。
- 2026-09-06 01:45 +0800: 仅 HEAD + 本任务 15 个源码/测试的 detached worktree 根 npm run check 全部通过（1221 files，No fixes applied，含 tsgo 与 browser smoke）；与主仓库文件逐个 cmp 相同。因主根 hook 仍受无关包阻塞，T-004 标记 blocked，未提交，等待最小授权决策。既有 LEARNS 已覆盖 nested workspace/ownedPaths 与自动格式化教训，不重复新增。

- 2026-09-06: 用户两次授权处理阻塞包及离线锁文件同步，仅本地保留；加入 T-005，T-004 恢复。固定已有开发依赖版本后离线更新锁文件仅新增 35 行。主根 check 通过，解阻包三个 Node test 文件 5 项全部通过，T-005 done。准备仅提交 V2 的 15 个源码/测试文件与本任务文档。

- 2026-09-06: 15 个 V2 源码/测试显式 staging 后提交 65832396ee1b93513dd8be2da364384304646138；确认 index 清空、V2 文件无残余修改。T-004 done，任务结论 passed；本地账号包与 35 行锁文件增量按授权保留不提交。任务记录另行收尾提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 四项修复与 42 项新增永久回归已提交为 65832396ee1b93513dd8be2da364384304646138；主仓库定向 271 passed/1 Windows skipped；追加本地解阻包 5/5 passed。隔离与主工作区根完整检查均通过，15 文件一致、diff/文档验证通过。V2 提交不含账号包或根锁文件。
- Limitations: 未运行真实 provider/embedding、Windows 或真实 SSH；pathname 检查仍非对抗换链沙箱。Search 策略预检有 100,000 条目/约 1,000 排除项上限，超出要求缩小范围；字节读取真实行号需要有界内存的前缀扫描（O(byteOffset) I/O）。本地解阻包与锁文件修改按用户要求留在工作区、不纳入 V2 提交。
