# Background task 端到端测试报告

结论：确认 **3 项端到端缺陷**：并发准入绕过上限、取消后子进程残留、`wake` 模式漏唤醒。另确认 1 项模块级日志截断异常。未修改产品实现。

## 环境与证据

- 2026-10-10，macOS，Node v24.15.0，HEAD `b325d5cf8a2f78fa33ab4f597aafc85b24e90dd9`。共享工作树已有其他改动，全部保留。
- 真实 `openai-codex/gpt-6.1-sol`，thinking=low；16 个生产 SDK AgentSession 会话及 4 个 `pi-test.sh --mode rpc` CLI 会话。未使用 faux provider。
- SDK 使用生产 ModelRuntime、AuthStorage、工具和进程执行器；会话/设置隔离。CLI 在临时目录运行，测试设置为该目录 `.epi/settings.json`。凭据来自现有 `~/.epi/agent/auth.json`，未输出或复制凭据。
- 真实 API 显式由 `PI_REAL_MODEL_EVAL=1` 启用。SDK 记录 `turn_start`、工具输入/结果、进程终态及 `onProviderContext` 请求边界；这些边界计数不是计费 API 请求数。保留消息和输出，剔除不透明推理签名。
- [证据目录](../../.artifacts/background-task-e2e-2026-10-10/)、[17 项运行记录断言](../../.artifacts/background-task-e2e-2026-10-10/checks.json)。下述时序均为各场景启动后的相对时间。

## 已覆盖场景

| 场景 | 实际结果 | SDK 模型回合数 |
|---|---|---:|
| 自然委派耗时命令，同时计算另一结果 | 自动后台执行一次；cwd、命令、`CTX_BG_1042` 和总和 71 完整；结果正确 | 4 |
| 简单算术 | 无工具调用、无后台任务 | 1 |
| 两任务重叠运行，一成功一失败 | 状态分别 succeeded/failed；退出码 0/7、stdout/stderr 正确，无重试 | 5 |
| 单进程忽略 SIGTERM 后取消 | stopping→5 秒宽限→SIGKILL→stopped；wait_for 返回终态 | 5 |
| 前台 timeout=1 后转后台 | promoted=true；PREFIX 与 PROMOTED_DONE 均被主 agent 消费 | 3 |
| wait_for(timeout=1) 后再次等待 | 首次 timedOut=true、任务仍 running；再次等待成功，无轮询 | 4 |
| 中断正在执行的 wait_for，再恢复 | 返回 ABORTED；后台任务继续运行，恢复后消费同一任务，无重复启动 | 5，含中断尝试 |
| 显式后台运行时限 2 秒 | timed_out/SIGTERM；只输出 HARD_READY | 3 |
| 默认 nextRequest，空闲后完成 | pending=1；下一次用户请求投递一次，再发 ACK 未产生新通知 | 2+2+1 |
| wake，空闲时完成 | 完成后约 4ms 进入模型请求；通知含输出，无额外查询 | 2+1 |
| wake，前台工作期间完成 | 能返回结果，但推迟到额外 follow-up 回合 | 4 |
| 并发启动，上限=1 | **两个均启动**；SDK、CLI 均复现 | 3 |
| 带忽略 SIGTERM 子进程的取消 | **stopped 后子进程仍存活**；SDK、CLI 均复现 | 5 |
| wake，最后一次模型请求期间完成 | **通知滞留**；SDK 3/3，CLI 1/1 | 每次 2，缺少应有结果回合 |

已有指定测试也执行了：agent 3 文件/36 项，coding-agent 3 文件/23 项，合计 59 项通过。它们未覆盖下述失败时序，不能代替真实运行结论。

## 确认缺陷与复现

### B1：并发准入不是原子操作

复现：设置 `backgroundBashMaxTasks=1`，要求模型在同一个 assistant 消息里发出两个后台 bash 调用：`sleep 12; echo CAP_A`、`sleep 12; echo CAP_B`，不重试。

预期：只接纳一个，另一个返回 limit_reached。实际：SDK 在 **4.790s/4.791s** 发出两次调用，均返回 task ID，并同时运行约 12 秒；CLI 用 sleep 8 也接纳了两个。模块补充实验同样 **3/3** 复现，而顺序启动第二个会被拒绝。

原因：[BackgroundTaskManager.start](../../packages/agent/src/harness/env/background-task-manager.ts:167) 在 `await access()` 和 shell 获取之前检查数量，之后创建任务时未预留或重新检查名额。两个请求都读到零。应把名额预留与检查做成同一个同步步骤，并在启动失败时释放。

证据：[SDK trace](../../.artifacts/background-task-e2e-2026-10-10/cap/cap-parallel/trace.jsonl)、[CLI trace](../../.artifacts/background-task-e2e-2026-10-10/baseline/cli-rpc-cap/trace.jsonl)、[模块对照](../../.artifacts/background-task-e2e-2026-10-10/baseline/boundaries/trace.jsonl)。

### B2：取消过早宣告终态并撤销 SIGKILL

复现：后台运行下列命令；前台 sleep 1 后 task_stop，再 wait_for；用 child.pid 的 PID 检查真实存活，宽限期后再检查。

```bash
python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print(os.getpid(),flush=True); time.sleep(45)' & child=$!; echo $child > child.pid; wait $child
```

预期：进程组在宽限期后被 SIGKILL，终态与实际停止一致。实际：模块实验 **约 102ms** 就返回 stopped/SIGTERM，5.5 秒后子进程仍存活，两次相同结果；真实 SDK 和 CLI 也复现。CLI 子 PID **98561** 在启动后 **20.201s、25.703s** 均存活，尽管 wait_for 已返回 stopped。测试结束后由测试驱动清理残留子进程。

原因：[observeChildProcess](../../packages/agent/src/harness/env/node-process-executor.ts:187) 在 shell 退出且管道空闲 100ms 后完成观察；[finalize](../../packages/agent/src/harness/env/background-task-manager.ts:579) 随即清除 stopGraceId 并标记终态。shell 收到 SIGTERM 退出，子进程忽略 SIGTERM，原定进程组 SIGKILL 被取消。应让进程组清理与 shell 输出观察分离，完成清理前保持 stopping；不能用增加模型查询来补偿。

证据：[SDK 存活读回](../../.artifacts/background-task-e2e-2026-10-10/descendant/cancel-descendant/trace.jsonl)、[CLI 存活读回](../../.artifacts/background-task-e2e-2026-10-10/baseline/cli-rpc-descendant/descendant-observations.json)。

### B3：wake 在最后一次模型请求期间完成时漏唤醒

复现：设置 `backgroundBashCompletionDelivery="wake"`，后台执行 `sleep 1; echo WAKE_TAIL_DONE`，本轮只回复“已启动”，不等待、不查询。持续保持实例运行。

预期：当前轮次结束后自动消费完成结果。实际：SDK **3/3** 在空闲后仍 pending=1、只有“已启动”；CLI 额外观察 5 秒，仍只有 2 个 turn、0 条完成通知。任务本身 succeeded。

第一轮 SDK 轨迹：**4.695s** 最后请求边界 → **5.700s** 任务完成 → **6.397s** agent_end → **8.899s** idle=true、pending=1。另两轮相同；sleep 12、空闲后完成的对照则正常唤醒。

原因：[完成回调](../../packages/coding-agent/src/core/agent-session.ts:3733) 只在 terminal 事件调用 wake；[wake 方法](../../packages/coding-agent/src/core/agent-session.ts:861) 遇到活动轮次直接返回。任务完成晚于最后的 transformContext，通知还没转成 follow-up；[收尾逻辑](../../packages/coding-agent/src/core/agent-session.ts:1980) 仅检查 agent 消息队列，不检查 background pending。应在安全收尾边界重新检查 pending，合并为一次 continuation，并保留显式取消语义。

证据：[三轮 SDK 结果](../../.artifacts/background-task-e2e-2026-10-10/wake-tail/summary.json)、[首轮时序](../../.artifacts/background-task-e2e-2026-10-10/wake-tail/wake-tail-1/trace.jsonl)、[CLI trace](../../.artifacts/background-task-e2e-2026-10-10/baseline/cli-rpc-wake/trace.jsonl)。这是等待停滞；当前证据不支持称为结果永久丢失。

### B4：日志截断后仍追加后续小块（仅模块级确认）

设置 maxLogBytes=16，真实执行 `printf 12345678901234567890; sleep 0.2; printf END`。预期截断标记后文件停止增长；实际文件为截断标记加 END，内存 tail 完整。原因是 [writeLog](../../packages/agent/src/harness/env/background-task-manager.ts:518) 只在再次超预算时检查 logTruncated；被丢弃的大块没有增加 logBytes，后续小块又通过检查。建议截断后直接停止文件写入。证据见上述模块 trace 的 `log-budget`，未做真实 provider 端到端复核。

## 减少不必要 agent turn

| 运行依据 | 具体建议 | 可省回合及边界 |
|---|---|---|
| 自然委派 4 回合：启动→Bash 算 125×8→wait_for→最终答复 | 简单算术在主 agent 内完成；保留一次阻塞 wait_for | 预计 4→3；仍读取真实后台输出 |
| 两任务场景 5 回合，启动和等待各分两次；cap 场景已实际做到同轮双启动、同轮双等待 | 独立调用批量发出，已有 ID 的 wait_for 同轮发出 | 可 5→3；**先修 B1**，容量拒绝不可重试风暴 |
| wake-busy：7.728s 完成，15.160s 新请求仍看不到通知，21.274s 才在 follow-up 中看到 | 已到达的通知在下一请求边界直接投影；空闲时才新起回合 | 可 4→3，且减少一次“尚未收到结果”的答复；保持一次性投递 |
| 默认成功通知只给路径，消费阶段另调用 task_output | 对简短必要输出使用有界 tail/always；通知已足够时不再查任务 | 本次消费 2→1 属优化目标，尚未在 nextRequest 下实测；不能因此省略完整结果所需读取 |
| wait_for 已携带终态和 tail，通知抑制正常 | 优先一次有足够时限的 wait_for；超时才按任务需要续等 | 本次无 task_list/task_output 无效轮询、重复确认或重复委派；不要新增轮询来修 B2/B3 |

## 待验证风险与限制

- followUp 独立模式、完成通知发送失败后的重试、重启/切换会话、真实 provider 请求失败、长时间高负载及多任务集中唤醒未覆盖。上述结论限于本机和本模型。
- 多任务批量通知不内联每项输出（即使选择 always），可能增加 task_output 回合；目前仅代码定位，未做该策略的专项运行，列为待验证优化风险。
- 默认 nextRequest 空闲等待属于现有设计，不能算 B3；需要及时主动返回时应选择 wake，并先修复 B3。
- 本次以 Bash 后台任务为范围，未验证 subagent 委派，也未覆盖交互 TUI 面板。没有网络/凭据阻塞；未覆盖项属于本轮边界，不宣称整体测试通过。
