# easy-pi runtime 改造：Agent 启动与接续提示词

配套执行规格：`EASY_PI_RUNTIME_REFACTOR_PLAN.md`。

先把这两个文件放到实施 Agent 能读取的位置，例如 easy-pi 的 `docs/runtime-refactor/`。下面的绝对路径需要替换为本地真实路径；不要让 Agent 假定云端已访问你的克隆。

推荐第一轮只做 P00—P01，先建立实际基线并验证取消竞态；后续逐阶段推进。完整计划覆盖 P00—P08，其中 P00—P04 是第一批核心运行时改造。

## 1. 首轮实施提示词

```text
你负责实施 easy-pi runtime 改造，不是继续做泛化方案讨论。

路径：
EASY_PI_DIR=<本地 easy-pi 绝对路径>
CODEX_DIR=<本地 codex 绝对路径，只读参考>
PLAN_FILE=<EASY_PI_RUNTIME_REFACTOR_PLAN.md 的绝对路径>
EXECUTION_SCOPE=P00-P01

先读取 PLAN_FILE、easy-pi 根及目标目录的 AGENTS.md 和测试规则。
校准本地 HEAD、未提交修改、实际主调用链与已有测试；不能把参考提交
或上一轮分析当成本地事实。不要 checkout 回参考 SHA，不修改 Codex。

按计划执行 P00 和 P01：
先建立实际仓库回归测试，再做取消最终准入的最小修复。
如果本地已修复，则记录源码和测试证据，不重复修改。
测试必须走真实 agent loop，不另写一份简化 loop 充当被测对象。

保持当前公开 API、Pi 扩展行为、Full Access、原生子代理和压缩能力。
不重写 runtime，不引入旧 DAG、新审批 UI、OS sandbox 或真实模型调用。
不新增依赖或修改锁文件；不得用跳过测试或降级类型来掩盖失败。

本轮只在自己拥有的隔离工作区修改。注意 npm run check 会写文件。
禁止清理或暂存其他 Agent 的修改，禁止 git add -A、stash、hard reset、
绕过提交检查、push、发布。按本地规则仅提交自己已验证的明确路径。

使用计划要求的 faux provider、barrier、隔离测试环境与定向命令。
不读取真实用户认证、不调用真实 API、不消耗付费 token。
每个改动过的测试都要运行，记录命令、退出码和完整失败证据。

维护 runtime-refactor-baseline.md、runtime-refactor-progress.md、
runtime-refactor-test-matrix.md。阶段通过后给出实际 diff/commit 和验收结果。
本轮完成 P01 后停止，不自动进入 P02。
遇到范围、所有权或兼容性冲突，记录 blocker 并保留可审查结果。
最终列出已完成、未完成、测试结果和下一轮精确入口，不写“全部完成”
来代替未运行的验证。
```

## 2. 下一阶段接续提示词

将 `NEXT_PHASE` 改为已经满足依赖的下一阶段，例如 P02。必须指定具体阶段，不默认批准剩余全部改动。

```text
继续 easy-pi runtime 改造，本次只执行 NEXT_PHASE=<P02 等具体阶段>。

EASY_PI_DIR=<本地实施工作区绝对路径>
CODEX_DIR=<本地 Codex 绝对路径，只读>
PLAN_FILE=<完整计划绝对路径>
PROGRESS_DIR=<P00 确定的进度文档目录>

先读完整计划中本阶段及依赖的验收要求，再读 baseline、progress、
decisions、test-matrix，并核对当前 git HEAD 与实际 diff。
不要只凭上一轮聊天总结认为前置阶段已经通过。

确认依赖阶段有实际源码和测试证据后，完成本阶段的最小实现、
定向测试、相关回归和 npm run check。继承首轮所有安全、兼容和提交约束。
发现前置阶段回归时先修复或记录 blocker，不能跳过后继续叠加实现。

保持现有核心状态单一所有者。任何计划与本地代码的差异都记录在 decisions。
本阶段验证通过后，按仓库规则提交本轮拥有的文件并更新 progress。
到阶段边界停止；最终给出 commit/diff、测试证据、未覆盖平台和下一步。
```

## 3. 独立审查 Agent 提示词

```text
你是 easy-pi runtime 改造的独立 reviewer。本轮只读审查，不编辑源码。

EASY_PI_DIR=<实施工作区绝对路径>
CODEX_DIR=<Codex 只读参考绝对路径>
PLAN_FILE=<完整计划绝对路径>
REVIEW_RANGE=<实际 base commit>..<实际 head commit>

先阅读 AGENTS.md、计划中的不变量和相应阶段，再检查真实 diff、调用链、
测试实现与命令记录。不要只依据实施 Agent 的总结或测试名称判断通过。
只运行符合仓库规则、隔离环境且不使用真实 API 的定向测试。

优先检查：
1. 最终准入与真正 execute/spawn 之间是否又 await，或遗漏受管入口。
2. 取消是否覆盖已完成结果，错误是否导致工具重复执行。
3. StepSnapshot 是否只是 shallow readonly，schema 和 handler 是否来自同一计划。
4. 快照是否误冻结祖先授权；扩展重载是否提前销毁仍在用的绑定。
5. shutdown 是否等待进程/output/writer，失败或超时是否被假装成功。
6. parent/child、control queue、workspace lock、file queue 是否形成循环等待。
7. sequential batch、steer/follow-up、agent_end/settled 等兼容契约是否改变。
8. 缓存关联是否混入认证或请求身份，日志是否包含敏感字段。
9. 回归是否走真实主链，是否靠 sleep、过度 mock 或 skip 掩盖问题。

输出按严重度排序的具体 finding：文件/符号、触发时序、影响、建议的最小修复
和需要补的测试。没有发现问题时说明审查范围、实际跑过的测试和残余风险，
不能把“未发现”写成“已证明不存在竞态”。
```

## 4. 范围说明

用户明确授权连续实施时，可把首轮执行范围改为 `P00-P08`，但仍须逐阶段满足门槛并维护进度，不能一次性大改后才运行测试。需要优先交付 P0 时使用 `P00-P04`。

上述提示词不授权真实 API、依赖升级、远程推送、发布、重置用户工作区或改变权限产品。相关例外需单独、明确的用户授权。
