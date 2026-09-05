# 统一工具链：有界真实 provider 配对测试

## 结论

2026-09-05，使用 **openai-codex/gpt-5.6-luna，thinkingLevel=max**，原生四工具与当前 v2 均通过 **4/4 个新合成任务**。8 个会话只运行一次，40 个请求的出站 payload 均验证 `reasoning.effort=max`，没有降级、重试、缺失样本或未知 usage。

这证明了本轮覆盖链路的可用性，**不证明 v2 普遍更快、更省或优于原生四工具**：v2 的工具结果更小，但总 tokens、完整 payload bytes 和目录价费用更高。

| 指标（4 个会话合计） | 原生 legacy | 当前 v2 |
| --- | ---: | ---: |
| 独立验收通过 | 4/4 | 4/4 |
| 模型请求 | 20 | 20 |
| 工具调用 | 19 | 20 |
| 工具错误 | 1 | 1 |
| 非预期工具错误 | 0 | 0 |
| 非缓存输入 tokens | 27,922 | 27,803 |
| 缓存读取 tokens | 7,168 | 30,720 |
| 输出 tokens（含 provider 计入的 reasoning） | 1,666 | 2,808 |
| 总 tokens | 36,756 | 61,331 |
| 工具结果 bytes | 8,595 | 5,104 |
| 累计出站 payload bytes | 244,812 | 405,108 |
| 目录价费用（USD，非实际账单） | 0.00772696 | 0.00954460 |
| 会话耗时合计（秒） | 153.980 | 147.390 |
| 平均会话耗时（秒） | 38.495 | 36.848 |

- 两个工具错误均为要求首先执行的语法检查失败：`exitCode=1 → Read → Edit → Bash exitCode=0`。普通 Agent 工具消息中的退出状态未丢失。
- 本轮 v2 工具结果 bytes 比 legacy 少 **40.6%**，但总 tokens 多 **66.9%**、目录价费用多 **23.5%**。不能用工具结果体积替代端到端成本。
- 耗时差约 **−4.3%**，只是单次、同宿主、交替顺序运行的描述性数据。没有重复采样或显著性检验，不视为稳定提速。
- 总用量 **98,087 tokens / 40 请求 / $0.01727156 目录价费用**。真实测试主体约 301.60 秒；包含此前本地验证的预算时钟在结束时约 13.55 分钟。未触发停止条件，也未为用完预算追加调用。

`总 tokens = input + output + cacheRead + cacheWrite`；本轮 cacheWrite=0。`toolResultBytes` 是工具 content 序列化后的 UTF-8 bytes（含包装），不是 tokens。`payloadBytes` 是出站 payload 序列化后的累计 bytes，不等同于计费输入。费用来自 provider usage 按目录价格换算，Codex 订阅的实际结算可能不同；缓存命中差异也限制了费用比较的可推广性。

## 固定场景与可见轨迹

所有任务都在独立临时目录重新生成相同输入；顺序为 U-01 legacy/v2、U-02 v2/legacy、U-03 legacy/v2、U-04 v2/legacy。没有复用旧开发集或 held-out 输入，也没有将本轮样本声称为历史 held-out。

| 新场景 | 验证范围 | 原生 / v2 请求 | 原生 / v2 工具调用 | 结果 |
| --- | --- | ---: | ---: | --- |
| U-01 | 在重复候选中定位 live worker 设置，保留 48 个示例、preview、注释与文档 | 6 / 5 | 5 / 5 | 均通过 |
| U-02 | 两个明确路径的受控更新，保留 retry 与示例 | 5 / 5 | 5 / 6 | 均通过 |
| U-03 | 先观察真实语法失败，修复，再检查；保留原有行与行为 | 5 / 5 | 4 / 4 | 均通过 |
| U-04 | JSON 更新及文件创建，使用 Bash 的显式子目录 cwd 验证 | 4 / 5 | 5 / 5 | 均通过 |

- U-01：legacy 使用两次 Bash 发现、一次 Read、一次 Edit、一次 Bash 验证；v2 使用一次 Search、两次 Read、一次 Edit、一次 Bash 验证。v2 工具结果为 1,664 bytes，legacy 为 6,967 bytes。
- U-02/U-04：给定了目标路径，v2 仍各调用两次 Search。该轨迹提示可能存在冗余，但结果不保留查询参数或内容，不能据此确证内部原因；本轮未修改提示或重跑以改善分数。
- 所有最终状态都经过独立文件集合、内容/JSON、文件权限与无旁路修改检查，并重新运行可信检查。模型自述不参与成功判定。U-03 另要求观察到非零退出、其后的真实修改及成功复验。

## 冻结边界与限制

- 产品基线：`9fbba6fceabd126a0ea3d53822385c4d4464eaf3`。这是**同一 revision 的 profile 比较**，不是与旧 Run revision 比较，也不能单独归因于 Bash 名称或合并。
- legacy 模型可见工具：`read/bash/edit/write`；v2：`search/read/edit/bash`。均使用生产 SDK schema/guidance 与统一 Bash 核心；legacy 保留 native raw-byte capture，v2 使用 ExecutionEnv capture。测试通过宿主适配施加相同固定命令边界。
- 无模型采样 seed 控制；场景和交替顺序固定，不代表服务端响应逐字确定性。
- 仅新合成数据；无 embedding、私有源码上传、扩展/skills/context-file 自动发现、HF/自动 compaction、自动重试或磁盘会话记录。结果不含 prompt、参数、命令、路径、源文件、工具/model 输出或凭据。
- Bash 只允许明确列出的发现/检查命令，使用清洗后的子进程环境，并保护检查脚本。检查脚本只读取数据/匹配内容，不执行模型编写的代码；语法场景使用真正的 `node --check`。这不是 OS sandbox，也不代表任意 shell、远程宿主、PTY、Windows 或复杂公开仓库工作流均已验证。
- 预算为 $15、80 请求、800,000 tokens、150 分钟；每会话最多 10 请求/10 分钟。Codex 当前 request body 不传 `maxTokens`，因此请求前按目录完整容量预留 **400,000 tokens / $0.3664**，再结算实际 usage；不能把未落实的输出选项当硬上限。unknown usage 将保留 pending 并停止。

## 可核验证据

- 原始数值与无内容轨迹：[unified-tools-real-eval-results.json](./unified-tools-real-eval-results.json)
- 固定新场景、oracle、预算与 SDK 适配：[unified-tools-real-eval.ts](./unified-tools-real-eval.ts)
- 本地回归：[unified-tools-real-eval.test.ts](./unified-tools-real-eval.test.ts)
- 显式双 opt-in 执行器：[unified-tools-real-eval.real.test.ts](./unified-tools-real-eval.real.test.ts)
- 权威任务：[2026-09-05-unified-tools-real-provider-eval-task.md](../../../../docs/tasks/2026-09-05-unified-tools-real-provider-eval-task.md)

真实调用前已冻结源码、场景、顺序、模型、两个 profile 的 schema/system-prompt；调用后源码 SHA-256 与冻结值完全一致。离线独立审计核对了每次不可覆盖记录、账本合计、实际最终 fixture、40 个 max payload、预期失败恢复与内容边界。

本地复核（不调用真实 provider）：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/tool-profile-eval/unified-tools-real-eval.test.ts \
  test/tool-profile-eval/unified-tools-real-eval.real.test.ts
```

默认真实测试必须 skipped。只有明确授权并同时设置 `PI_REAL_MODEL_EVAL=1`、`PI_REAL_UNIFIED_TOOLS=1`、独立 `PI_UNIFIED_EVAL_DIR` 才能进入真实模式；执行器还要求匹配固定基线、预检 freeze、未开始过的运行和原时钟。**不要为了提高结果重跑此矩阵。新的实验应另立合同与新样本，不更改本文件、既有 frozen results 或旧 held-out。**
