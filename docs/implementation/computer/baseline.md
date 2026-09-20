# Computer P00 基线

日期：2026-09-18。状态以 [任务记录](../../tasks/2026-09-18-computer-native-implementation-task.md) 为准。本文件不是 native 集成或性能通过声明。

## 已确认授权

| 项 | 值 |
| --- | --- |
| EASY_PI_DIR | `/Users/w/Projects/easy-pi/pi`，当前工作树 |
| EASY_PI_BASE_REF | `89b56ee70f86c98e0a81b8b7b90c09410b3ff772`，分支 `my-pi` |
| CUA_SOURCE_DIR | `/Users/w/Projects/easy-pi/cua`，只读 |
| CUA_BASE_REF | `05f29785b508a4441ec3aa06c556a8e8b26c1d71`，分支 `main` |
| TARGET_PLATFORM | macOS arm64；本机 macOS 26.5.1 (25F80) |
| ALLOW_DEPENDENCY_CHANGES | `false`，无安装/升级/锁文件修改授权 |
| ALLOW_GUI_TESTS | `false`，不操作当前桌面、权限面板、已登录 browser |
| ALLOW_REAL_APIS | `false`，仅 faux provider/本地 mock |
| EXECUTION_SCOPE | P00→P08，逐门禁推进；遇到不可满足条件标 blocked |

用户已通过结构化输入确认以上边界及当前脏工作树。Node `v24.15.0`，npm `11.12.1`，rustc/cargo `1.95.0`。未发现 PATH 中可用 Bun；不宣称 Bun Computer 支持。

## 实际快照，而非仅 HEAD

首次检查有 22 个已有修改/删除路径；准备期间共享工作树继续变化，快照捕获时为 **26 个**，包括用户修改的 `sdk.ts`、包 manifest、provider/telemetry/启动界面文件。没有覆盖、回退或修复这些修改。

本地完整证据根：`.artifacts/computer/p00/`（gitignore，不进入发布产物）。

- `ref.txt`：基线 HEAD。
- `status-before.txt`：快照时工作树状态。
- `baseline.patch`：当时 `git diff --binary HEAD`，包含用户已有变更。
- `tracked-before.json`：1789 个 tracked 路径的 SHA-256、符号链接或缺失状态。
- `copied-materials.json`：28 个已有 node_modules/dist/provider-data 目录；复制不是安装。
- `workspace/`：仅从本地仓库 clone 元数据，复制当前 tracked 内容并核对哈希；没有 fetch 远端、复制用户 HOME 或私有项目配置。
- `snapshot-after-check.json`：check 自动修改的 2 个路径，仅存在于副本。
- `worktree-current.json`：后续对原工作树的漂移检测；其他并行工作产生的变化不是本任务产物。

`npm run check` 实际包含 `biome check --write`。在副本运行后，只有副本中的 `packages/ai/src/auth/oauth/oauth-page.ts` 和 `packages/coding-agent/src/migrations.ts` 被格式化；未回写原工作树。

本地快照不是 OS sandbox：运行权限仍是原有 Full Access。其作用是防止构建/格式化碰到用户文件；凭据由独立 HOME、空环境及已审计测试入口隔离。

## P00 实测

根 cwd：`.artifacts/computer/p00/workspace`。隔离助手：`.artifacts/computer/run-isolated.sh`，完整采用 `test.sh` 的 HOME/env/npm/git 隔离逻辑，将最后的 `npm test` 替换为显式 `"$@"`，并关闭网络启动配置和本任务三项开关。`test.sh` 本身未修改；没有传入无效筛选参数。

| ID | 实际命令（cwd 见下） | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| B01 | `bash /Users/w/Projects/easy-pi/pi/.artifacts/computer/run-isolated.sh npm run build:offline` | 0 | 完整 offline 构建通过；复用已有 provider JSON | `build-offline.log` |
| B02 | `./test.sh` | 1 | agent 559 通过/1 skipped；ai 4 失败；coding-agent 23 失败；其余工作区命令继续执行 | `test-sh.log` |
| B03 | `bash /Users/w/Projects/easy-pi/pi/.artifacts/computer/run-isolated.sh node ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-tool-gateway.test.ts test/suite/agent-session-runtime.test.ts` | 0 | **2 文件、13 测试通过**，真实 AgentSession/faux provider 与 runtime 工厂 | `faux-session.log` |
| B04 | `bash /Users/w/Projects/easy-pi/pi/.artifacts/computer/run-isolated.sh npm run check` | 2 | TS2339；browser-smoke 被前序失败短路，未运行 | `check.log` |

B03 cwd 为根 cwd 下的 `packages/coding-agent`。每条日志另有同名 `.exit`；`*.readable.log` 仅去掉 ANSI 和纯进度点，原始日志完整保留。命令顺序：B01→B02；B03 在 coding-agent 全套件结束后执行；B04 在测试结束后执行。

### 既有失败（Computer 产品代码尚未改动）

- check：`test/sdk-openrouter-attribution.test.ts:96` 使用已被用户改动移除的 `SettingsManager.setEnableInstallTelemetry`。
- ai（3 文件/4 测试）：`anthropic-auth-token` 1、`openai-codex-stream` 1、`xai-responses` 2。前后两类显示 `pi`/`easy-pi` UA 断言差异；Codex SSE 的 `sawTextDelta` 为 false，原因未调查，不归因本任务。
- coding-agent（10 文件/23 测试）：`changelog` 2、`first-time-setup-fork` 1、`first-time-setup` 1、`model-runtime-auth-options` 1、`pi-user-agent` 1、`radius` 3、`sdk-openrouter-attribution` 9、`version-check` 1、`suite/regressions/5943-session-start-notify` 3、`suite/regressions/startup-session-rebind-duplicate-subscription` 1。
- runtime UI regression 的 4 个失败显示 `this.subscribeToBackgroundTasks is not a function`；这些 UI fixture 未在本任务修改。

既有失败只记录，不删除测试、不恢复用户功能、不把基线失败写成新增 Computer 回归。P00 门禁要求的是能区分失败且有真实 faux 入口，不要求伪造全仓绿灯。

## 工具与生命周期事实

- `AgentTool` 的 `contract` / `executionResource` 已存在（`packages/agent/src/types.ts`）。
- `core/tools/tool-definition-wrapper.ts` 双向显式列字段，当前均未传递上述字段；`core/extensions/wrapper.ts` spread 包装并处理 `addedToolNames`，底层透传修复后应保留行为。
- `packages/agent/src/tool-plan.ts` 深拷贝并冻结 schema、contract、resource；`step-snapshot.ts` 每个 provider step 创建绑定。
- `agent-loop.ts:executePreparedToolCall` 调用宿主 `admitToolCall`，通过后才 acquire resource，最终再检查 abort / `admitEffect`，`execute` 收敛后 finally 释放 lease。
- 普通 Agent loop 不自动执行完整 durable ToolContract 策略。P01 必须测试宿主准入读取最终 frozen contract 后实际拒绝及 scheduler 实际串行，而不能把对象含字段当策略已生效；不能承诺此处具备 durable timeout/retry/approval 的全部能力。
- `createAgentSession` 的 `customTools` 可显式注册 Computer；默认工具仍是当前 coding 集合及 bash task 管理工具，不增加默认 Computer schema。P01 不必修改用户正在编辑的 `sdk.ts`。
- `createAgentSession` 未给 Agent 配置共享 `executionScheduler`；P01 测试宿主必须显式注入该已有接口。不能把字段透传称为默认 root/child 已共享桌面调度。
- 宿主/native 所有权及 root/child 撤权不是本次源码审计的运行时证明；P03 需要独立 barrier 测试，不能绑到随 cwd 重建的 services 上。

## 性能证据边界

现在仅有 fake/model-runtime 测试入口，没有 Cua/native/桌面测速。观察到的 test duration 不是桌面 latency，也不是优化收益。A/B 任务集及冻结规则见 [benchmark-spec.md](benchmark-spec.md)；native 依赖结论见 [dependency-review.md](dependency-review.md)。
