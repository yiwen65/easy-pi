# Task Plan: easy-pi 图片输入、处理与传输整体方案

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户先要求制定方案，现明确要求“开始实施，完成交付”；按方案推荐的安全取舍实施仓库内改动。仍不默认授权真实付费模型、凭据操作、公网上传或外部服务变更。
- Baseline: `0ba5721ec461cb10b7f0558b1a22d1b716fd0502`；开始规划时工作区干净。
- Status authority: 本文是本方案唯一任务与验收记录。参考仓库只读；后续实施继续更新本文，不另建竞争性清单。

<!-- task-doc-section:background-goal -->
## Background and goal

### 1. 问题与目标

本次暴露的是两类不同问题，必须分开解决：

1. **已实测根因：网关协议错误。** 原图完整进入 easy-pi，但本机 9router 的 Qoder 上传接口签名使用了错误的输入。相同原图、账号、接口，只把签名输入从 multipart 内容改成 multipart 字节长度字符串，上传从 HTTP 403 变成 200；重启后真实模型正确识别原图。该修复在外部运行时，不是 easy-pi 缩图修复。
2. **easy-pi 设计缺口：图片保护不一致。** 不同入口是否经过校验/缩放不一致；工具图片处理失败时保留原块；历史中的坏图可能反复进入请求；当前缺少统一请求级图片预算和本地附件身份。

目标是建立可验证的闭环：**原附件可追溯、所有入口一致、画质决策明确、资源使用有界、实际发送可解释、坏图不污染后续请求、持久化与恢复不破坏会话语义。** 不以“文件变小”冒充“模型收到并理解图片”。

### 2. 设计原则与明确取舍

- 先修统一边界和错误契约，再做存储、画质和性能优化；不先建设上传平台。
- 沿用 Node/Bun 与 Photon/worker 的现有体系；不因 oh-my-pi 使用 `Bun.Image` 就更换运行时或新增原生依赖。
- 复用现有编辑器附件编号、工具 hook、模型运行时、会话写入/恢复约束；不建立第二个 prompt 驱动器或终端粘贴解析器。
- 原图与派生图分离；同一输入及完整策略应得到稳定派生结果，不在每轮随机改变历史图片和提示。
- 图片接收、准备、请求序列化、远端接收、远端视觉识别是不同证据等级，禁止混报。
- Codex 的 patch 预算、oh-my-pi 的 1568px/500 KiB、公网图床链只作为参考，不作为全 provider 通用事实。
- 接受收益明确的边界抽象；不引入通用媒体框架、全局对象存储、万能 schema walker 或大规模目录重构。

### 3. 分期结果

| 里程碑 | 结果 | 是否首批必须 |
| --- | --- | --- |
| M1：可靠发送 | 统一准入、分类失败、可取消处理、历史坏图兜底、实际 endpoint 策略、出站预算与基本报告 | 是；可独立交付，不依赖图片存储格式变更 |
| M2：附件与会话 | 原始附件来源、本地内容寻址存储、版本化物理图片编码、导出/分支/恢复闭环、附件查看 | 是整体目标；须先确认存储格式决策 |
| M3：质量与发布验收 | 图像保真、稳定坐标映射、性能对照、跨运行时/客户端回归、经批准的真实识图验收 | 发布前按适用范围完成 |
| 后续可选：网络引用 | provider 专属 file_id/URL 上传、账号隔离缓存及安全降级 | 本轮不实施；有明确收益与授权后再增加任务 |

### 4. 目标架构

```text
剪贴板 / 明确文件路径 / CLI @file / RPC / SDK / 用户与工具扩展
        │
        ▼
统一准入（扩展输入变换后；提交、steer、follow-up 使用同一契约）
  有界读取 → 严格 Base64/真实 MIME → 解码/像素检查 → 不可变源身份
        │
        ├── 本地原附件 + 来源关联（M2；不自动发布到网络）
        ▼
共享图片准备
  策略解析 → 方向/透明度 → 缩放/按需编码 → 有界缓存/并发合并
        │
        ▼
逻辑消息 + 稳定图片事实 → 原有会话/任务恢复写入
        │
        ▼
每次请求的临时 Context
  扩展 context 处理 → 实际模型/endpoint 解析 → 历史坏图/格式修复
  → 请求级图片预算 → 原有 provider 序列化
        │
        ▼
原有 before_provider_request hook
        │
        ▼
最终 wire guard（已支持的 API 精确提取图片；复核 hook 后改变的载荷）
        │
        ▼
网络请求 → provider 响应 → 处理报告；可选真实识别 oracle
```

这是三个必要职责，不是三套重复处理：准入阻止坏用户图和无界载荷进入逻辑历史；工具已经执行的事实按下文两阶段规则保留；请求准备处理模型切换和历史问题；最终 wire guard 防止序列化或原始 payload hook 绕过前面的结论。相同字节/策略通过摘要和已验证结果复用，不能每层重新完整解码一次。

### 5. 类型与模块边界

以下名称为拟议契约，T-001 冻结后才能作为代码接口；不是声称这些类型已经存在。

| 契约 | 必要信息 | 不负责 |
| --- | --- | --- |
| ImageSource | 源字节 SHA-256、真实 MIME、源尺寸、字节数、来源类别；M2 增加受控本地引用 | provider 文件 ID、公网 URL、认证信息 |
| PreparedImage | 标准 `ImageContent`、源/输出尺寸、编码字节与 Base64 字节、源到输出坐标变换、策略指纹 | 修改源图片、伪造模型识别成功 |
| ImagePolicy | 源输入上限、解码像素上限、可用格式、尺寸/编码限制、请求数量与字节限制、能力证据来源 | 根据模型名字猜能力、把第三方库常数当协议 |
| ImageDecision | 稳定 image ID、阶段、结果、原因码、源/输出事实、实际模型与 endpoint 类别 | 图片数据、凭据、带密钥 URL、每轮注入动态 system 文本 |

- 首批保持 `packages/ai/src/types.ts::ImageContent` 的 Base64 逻辑契约，不引入 provider-neutral `file_id`。图片事实由 coding-agent 拥有；provider serializer 只接收其理解的字段。
- 在 `packages/coding-agent/src/core/images/` 建立小型应用层边界（拟新增 `types.ts`、`policy.ts`、`pipeline.ts`、`request-guard.ts`；M2 再加 `source-store.ts`/存储 codec）。实际文件拆分以单一职责与现有可复用工具为准，不为每一步机械建文件。
- `utils/image-process.ts`、`image-resize*.ts` 保留为共享处理实现，消除调用方重复逻辑；不把编码器、会话存储或 Qoder 协议塞进 `packages/ai`。
- 低层 `pi-ai` 独立调用仍是调用方负责策略的 API；不得把 coding-agent 的保证宣传成所有自定义 stream 实现均受保护。

### 6. 准入、画质与资源策略

#### 6.1 初始参数提案

单位必须编码进字段名或注释；原字节、编码后二进制、Base64 字符/字节、像素与 token 不得混用。

| 项目 | 提案 | 依据/上线门槛 |
| --- | --- | --- |
| 单图原始输入 | 20 MiB 硬上限 | 复用当前明确路径入口的安全量级；扩大到全部入口属于需确认的行为变化 |
| 单次提交原始总量 | 32 MiB 硬上限 | 工程初值，不是任何 provider 官方限制；T-001 测夹与现有工作流验证后冻结 |
| 单次提交/出站输入图片数 | 32 张工程初值；实际出站取已验证 provider 更严值 | 避免大量极小图片绕过字节保护；保留用户组，不能靠静默丢当前图满足数量 |
| 源解码像素 | 32,000,000 像素初值 | 须测手机照片/长截图及 worker 峰值；48MP 等超限图明确拒绝或由用户调整，不能悄悄解码 |
| 默认兼容输出 | 最长边 2000；Base64 不超过 4.5 MiB | 保留 easy-pi 当前画质/兼容基线；实际已验证的 provider 硬限制更小时取更严值 |
| 请求内联图片总量 | 24 MiB Base64 工程初值 | 仅是本地保护，不是完整 HTTP body 大小或统一 provider 协议保证；明确留出文本/工具/schema 空间 |
| 解码/编码并发 | 同一宿主进程初期 1 个 active job；有限等待队列 | 防止多 AgentSession 同时分配大位图；有测量后才提高，不先建 worker 池 |
| 截止时间 | 单图 10s、单次准备 30s 初值，外层 AbortSignal 可更早终止 | T-001 在 Node/Bun 发行形态测量后冻结；不能把未调优值宣传为性能结论 |
| 处理缓存 | 64 MiB 载荷预算 + 32 项初值；单项超预算不缓存 | 统计二进制与保留的 Base64 表示；这是缓存载荷预算，不是整个进程 RSS 硬保证 |

`images.autoResize` 与 `images.blockImages` 继续作为首批用户开关，不再同时增加 mode/quality/transport 三套互相冲突的设置。内部由 autoResize 选择 balanced/original：

- **balanced**：沿用现有兼容量级，优先保留文字/线条和 alpha。先测试合适的无损候选，达标即停；必要时才走递减有损质量与尺寸阶梯。用真实截图验收决定是否接受 JPEG，不用“最小文件”代替画质标准。
- **original（autoResize=false）**：不主动做有损编码/降采样，但仍受解码校验、资源限制、实际 provider 硬限制及请求总量限制。不能满足时明确失败，不静默缩成低清图。此项安全强化须获得实施确认。
- 明确支持原生 high/original detail 的模型，可由策略扩展映射；首批不假设所有 Responses/兼容服务均接受 `original` 字段，不增加未验证的高细节数值表。
- 不统一放大所有小图至 200px。仅在某个已验证后端要求最小尺寸时做等比放大或带坐标映射的 padding；这不会创造新视觉信息。
- 透明图保持 alpha，不在未明确背景合成策略时转 JPEG；避免透明边缘污染。源 EXIF/ICC 与方向需有测试，不能误称为已实现隐私清洗。
- 截图工具已有的原生 capture_id、截图像素坐标、DPR/缩放关系必须保留。只有拿到可证明的变换才告知模型如何映射；不能猜 CSS/屏幕坐标，也不能把本方案变成 GUI 输入工具重写。

#### 6.2 工作与缓存生命周期

- strict Base64 校验、MIME 探测和像素预检在昂贵解码前完成；解码成功才是容器有效性证据，头部尺寸不是完整验证。
- worker 收到 AbortSignal/截止时间时终止并确认退出后释放容量；不把取消、超时、资源失败再放回主线程执行。仅保留已识别的运行时加载兼容回退，且不能造成 TUI 阻塞。
- 相同源 + 完整策略指纹 + 编码器版本共用进行中的任务。一个等待者取消只取消其等待；最后一个等待者取消才停止底层任务。dispose 后不能复活任务或写入已撤销的会话。
- 输入字节不被 transferable detach；缓存不接受调用方可修改的共享字节所有权。
- 输入像素/字节、并发、超时只能降低风险，不能当作 WASM/原生解码 RSS 的数学硬上限；须测峰值，不以 JS heap 限制冒充外部内存限制。

### 7. 失败、预算与模型切换契约

| 情况 | 行为 |
| --- | --- |
| 新用户图片损坏/准入超限 | 不发模型请求；TUI 保留文字和附件草稿，RPC/SDK 返回分类错误；不隐式重新执行外部操作 |
| 工具已经执行，返回坏图 | 保留工具执行事实及原附件证据；provider 可见图片替换为有原因的文字；不为取图自动重跑工具 |
| 历史图片损坏/丢失 | 只改临时请求视图为稳定占位；报告 image ID/原因；不篡改持久历史或签名/推理块 |
| 编码器不可用 | 与坏图分开报告；已独立证明可解码且符合策略的原字节才允许安全直通，否则局部省略或准入失败 |
| 用户 blockImages | 不发送图片、不触发上传或其他视觉模型；本地附件可保留。出站关闭优先于任何转换/回退 |
| 切到无视觉模型 | 明确说明不可见；不自动调用另一模型替用户付费描述 |
| 当前用户图片/明确引用图片超预算 | 不静默删除；请求在本地失败并提示选择附件、裁剪或调整策略 |
| 累积旧工具截图超预算 | 默认只在临时视图省略较旧、未被明确保护的工具图片；保留图片位置与原因，用户可从源重新读取 |
| 原始 payload hook 增加/改变图片 | hook 后重新验证；不能安全定位/改写时拒绝该次本地请求，不能丢掉整个 opaque payload 损伤历史 |
| HTTP 200 但网关内部丢图 | 没有网关附件回执就标为“远端图像接收未验证”；不能宣称本地 guard 能发现所有代理内部失败 |

- 工具失败留证分期：M1 不改物理格式，允许有界的原始工具结果作为 canonical 事实保留，但标明未准备成功，并只在临时 provider 视图省略坏图；这不等于允许其继续上 wire。M2 将这类源证据移至受控资产并持久关联。超过安全准入上限的工具载荷仅保留大小/摘要与已有且可验证的日志位置，不承诺完整字节留存，也不能把无限 Base64 转移到 details 冒充有界处理。
- 不自动裁剪当前用户附件、明确比较的一组图或当前工具图。预算计划先保留这些组，再处理旧工具截图；用户旧图默认不无提示删除。若这些必保留组已超预算，返回分类错误而不是产生看似成功的缺图回答。错误必须带可执行的恢复动作：M1 至少允许用户明确确认本次/当前分支不再随请求重放哪些历史用户图片（TUI 最小确认与 RPC/SDK 对应选择），不删除日志或源附件，不先建设复杂 pin/图库 UI。选择只作用于临时请求并可撤销，避免每轮只能重试同一个预算错误。
- 每次使用**认证解析后的实际 endpoint**与最终模型解析策略。官方限制只适用于确定抵达官方服务的路由；兼容网关可显式覆盖，缺少信息时使用工程保护并标注未知，不猜模型名。图片策略、资产权限、报告通道均为请求/会话作用域；通过每请求接点接收认证后的模型，不在多个会话共享的 ModelRuntime 上保存“当前会话图片策略”。
- 图片数量、逐图尺寸/格式/字节、内联总量和请求序列化总量是不同预算。最终 wire guard 对可证明的序列化请求做检查；Bedrock 等 SDK 自行封装的传输不能谎报为已精确测得 HTTP body。
- 用户/工具/模型输出图分开计数；仅统计实际重放的输入图片。未来引用传输启用后才按实际 wire 形态排除 file_id/URL 字节，而非看到一个字段就免校验。
- 有限的本地历史修复和预算省略必须稳定且可缓存；报告计时、trace ID 不进入 system prompt 或重复改写有效 prefix。
- 视觉 token 估算与编码字节分开。当前每图约 1200 token 仅作为明确标注的回退估计；有已验证模型公式时才结合准备后尺寸/detail 覆盖。缓存图片事实，不在 token 估算时重新解码；复用现有 usage 与 compaction 判定，不另建压缩算法。T-009/T-010 对照估算和实际 usage，不能把 Codex 的 patch 公式通用于所有模型。

### 8. 原附件、本地存储与物理格式

- M1 不改 session JSONL 物理编码；先得到独立可交付的安全闭环。
- M2 增加**会话作用域**内容寻址资产目录，不先复制 oh-my-pi 的全局跨会话 CAS。反复使用同图在本会话内去重；fork/clone 复制所需资产到目标所有权范围，先不依赖跨团队硬链接。
- 原附件与模型派生图是不同内容，分别按真实字节 SHA-256 寻址；来源路径仅为来源说明，不用来代替已接收字节的身份。明确路径输入在准入时有界快照，避免文件后来变化而把另一个图片当作原图。
- 源引用与消息/工具结果及图片顺序关联；不伪造为 provider 文件 ID，不把绝对私有路径当可移植标识。
- 持久化 codec 只处理已定义的消息图片、已知 recovery prompt/队列等载荷；禁止递归截断任意字符串或改写签名/加密内容。逻辑 `ImageContent.data` 与 provider wire 保持标准 Base64。
- 必须先原子写入并同步资产，再提交引用该资产的日志记录；失败最多留下可审计孤儿，不应留下已承诺但不存在的图。恢复不依赖在内存中的缓存。
- 在物理格式决策确认前，不创建双格式兼容层、不自动迁移旧会话、不覆盖用户历史。现有格式读取行为不擅自删除；新格式版本、旧会话继续写入策略与导出契约在 T-007 开始前确认。
- 导出优先保持单文件可移植语义：导出时解析资产为标准图片内容，不能输出只能在原机器解析的路径。若需要携带原附件与源关联的 bundle，作为显式额外选项，而非悄悄改变 JSONL/HTML 行为。
- resume/fork/clone/import/export/native team 删除与任务恢复需要共同验收。资产查找验证所属根、摘要、长度及非预期符号链接，不能凭一个外来 hash 获得另一个会话的资源权限。
- 不做默认全盘 GC。先提供可达性/缺失/孤儿检查；任何删除须覆盖全分支及恢复记录，受现有写入/团队生命周期锁保护并经过 dry-run/显式确认。

### 9. 网络传输与可观测性

**默认仍然内联，不自动添加公网图床、隧道或额外视觉模型。** 本地 source store 不等于上传服务。

未来确有请求量/带宽收益时，上传器仅做 provider-specific adapter：

- 使用明确支持的实际 endpoint/API；provider + 账号身份摘要 + 内容 + 传输策略隔离缓存。
- file ID/URL 有失效、撤销、内容变更与并发去重契约；回退优先使用本地可信派生图，并重新计算 inline 预算。
- 仅在尚无模型内容/工具调用输出时允许有限重试；以实际来源进度识别 file→URL A→URL B→inline，不能只比较 URL 这一类别。
- 无声回退到公共图床不在允许范围；上传、持有 capability URL、删除与远端留存都需单独说明。
- 不将 9router 的本地补丁搬进 generic 图片层。网关内部上传状态必须由其协议/适配器回执证明；不解析模型回复中的“看不到图”来伪造上传诊断。

处理报告使用既有 UI/事件基础设施，小范围扩展而非新观测平台：

- `accepted`：本地已接收；`prepared`：本地准备成功；`serialized`：实际 wire 形态已检查。
- `remote_response`：provider 已响应，仅证明请求层；`remote_image_receipt`：仅在有明确协议证据时使用。
- 图像识别测试只证明该次模型的给定 oracle，不当作所有输入可读保证。
- 默认只记录大小、尺寸、原因码、策略与脱敏 image ID；不记录 Base64、凭据、敏感查询参数或完整私有路径。用户可主动打开自己的源附件。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### 本轮获准范围

- 按用户“开始实施，完成交付”启动仓库内实现、离线验证与有界子 agent 协作。
- 采用方案推荐的安全行为：保护用户图、分类失败、不自动迁移旧文件、不默认外部上传；真实模型/凭据/运行中服务仍需另行明确授权。

### 本轮实现范围

- `packages/coding-agent/src/utils/image-*.ts`、`clipboard-image.ts`、`pasted-image.ts`、`cli/file-processor.ts`。
- `core/agent-session.ts`、`core/sdk.ts`、`core/model-runtime.ts` 的图片边界；相关 interactive/RPC 和工具结果接入。
- 拟新增小型 `core/images/` 域；M2 的 session 编码、资产管理与 export/import 生命周期。
- 必要且经过契约冻结的 model-config/settings/AI 类型及最终 wire 图片提取器；不重写 provider 或模型目录体系。
- 对应单元、suite/faux-provider、跨运行时、存储与显式 opt-in 真实验收。

### 非目标

- 修改 `codex/`、`oh-my-pi/` 或其他参考仓库；整体移植其架构。
- 图片生成、视频、OCR 服务、全局对象存储、通用媒体框架、GUI 点击安全重构。
- 更换 Bun-only 运行时、默认新依赖、默认公网托管、自动 paid vision fallback。
- 删除现有 autoResize=false/raw 工具输出等有意行为而不先取得确认；历史迁移或清理不因本方案获得授权。
- 未经授权发布、重启服务，或把文档校验结果当作产品测试结果。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

F-003至F-012、F-017描述实施前基线；当前行为以任务验收证据与 `packages/coding-agent/docs/images.md` 为准。

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已要求实施并完成整体交付 | 当前用户原文“开始实施，完成交付”；本文 Mode=execute |
| F-002 | 原图完整进入会话，先前外部网关上传签名错误已被单变量实测定位 | 本会话实测：原图 3,536,139 字节；签名输入变化后 403→200；真实 `qd/dfmodel` 输出“数据备份/iCloud/3.3 MB”。本地修复说明 `~/.9router/local-patches/README-qoder-upload-signature.md`；属于历史证据，非本轮重新验证 |
| F-003 | CLI @file 调用共享图片处理；剪贴板与用户 prompt Images 当前可直通 | `src/cli/file-processor.ts:54`；`src/modes/interactive/interactive-mode.ts:3121`；`src/core/agent-session.ts:2732,2809`（均相对 packages/coding-agent） |
| F-004 | 明确路径粘贴已有有界常规文件读取、20 MiB 上限及输入所有权保护 | `src/utils/pasted-image.ts`；`src/modes/interactive/components/custom-editor.ts`；`docs/tasks/2026-09-11-terminal-image-path-paste-fix.md`，不得破坏已有附件编号/撤销/粘贴解析 |
| F-005 | 工具 after hook 后规范化图片，失败时有意保留原图 | `src/core/agent-session.ts:715`；`src/utils/tool-result-images.ts:40–47`；`test/tool-result-images.test.ts` |
| F-006 | 当前默认 2000×2000、4.5 MiB Base64；编码候选先全部生成再按顺序选择 | `src/utils/image-resize-core.ts:22–29,108–127`；未以性能基准量化收益 |
| F-007 | 每次 resize 建 worker；当前接口无取消/截止时间，失败可回退主线程 | `src/utils/image-resize.ts:25–108`；未复现解码挂死或测量峰值 RSS |
| F-008 | 当前 AI 图片逻辑类型只有 type/data/mimeType | `packages/ai/src/types.ts:375–379` |
| F-009 | 会话物理日志写入 JSON；recovery 去重仅覆盖已定义恢复字段，不是图片资产库 | `src/core/session-manager.ts:937,1456,1574`；`src/core/recovery-storage.ts:48` |
| F-010 | 请求身份可能在认证阶段改变 baseUrl | `src/core/model-runtime.ts::prepareRequest`；返回 model 使用 `resolution.auth.baseUrl || model.baseUrl` |
| F-011 | provider onPayload 先于实际发送，可作为扩展 hook 后的检查接点 | `packages/ai/src/api/openai-completions.ts:242`、`anthropic-messages.ts:596`、`bedrock-converse-stream.ts:255`、`mistral-conversations.ts:144`；`coding-agent/src/core/sdk.ts:403` 当前仅转交扩展 |
| F-012 | JSONL 导出重链当前分支并写出，不应携带机器私有依赖 | `src/core/agent-session.ts:5400` 的 `exportToJsonl`；`writeSessionFile` 处理原子发布与 recovery 编码 |
| F-013 | Codex 有统一准备、高/原始细节预算与有界处理缓存；默认 store 仍内联 | 只读参考 `../codex` 版本 `8c076942cb`：`codex-rs/core/src/image_preparation.rs`、`utils/image/src/lib.rs`、`core/src/thread_manager.rs:527` |
| F-014 | oh-my-pi 有原剪贴板来源、本地 blob、出站解码防线与可选网络引用 | 只读参考 `../oh-my-pi` 版本 `ba85aef0b3`：`input-controller.ts:2130`、`session-persistence.ts:15`、`provider-image-budget.ts:423`、`blob-broker/settings.ts:28` |
| F-015 | oh-my-pi 的 500 KiB 是压缩目标，不是所有分支的硬输出保证；网络引用默认关闭 | 参考 `utils/image-resize.ts:522` 的最终返回；`blob-broker/service.ts:733` 的 enabled gate |
| F-016 | 当前没有在上述参考分析中执行测试或测量画质/性能 | 本会话审查记录；所读测试只能作为覆盖证据，不能写为已通过 |
| F-017 | 当前图片 token 估算使用每图 4800 字符/4 的统一启发值 | `packages/coding-agent/src/core/compaction/compaction.ts:228–265`；`packages/agent/src/harness/compaction/compaction.ts:253–278` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

### Assumptions

- A-001：首要场景是截图、界面小字、代码/图表及常规照片，而不是大量专业原片。影响：默认兼容参数；T-001 用夹具和真实工作流确认。
- A-002：本地原附件和会话侧资产足以解决首批追溯/重试，不必先公开托管。影响：M1/M2 不依赖网络上传；若真实请求数据说明收益不足，应保留内联而不是硬建服务。
- A-003：新的物理存储可以在 M1 完成后单独交付。影响：格式决策不阻塞统一准入与请求保护；M2 不能在 export/recovery 尚未过关时启用。
- A-004：现有 Photon/worker 能通过资源与保真门槛。若不成立，先提交具体瓶颈/缺失 codec 证据，再决策替换或增加依赖，不预先承诺更快。

### Open questions / 实施闸门

| ID | 需确认的材料性决定 | 推荐方案 | 阻塞范围 |
| --- | --- | --- | --- |
| Q-001 | 是否授权进入实现 | 已授权仓库内 M1/M2/M3 实施，按验收推进 | 已关闭 |
| Q-002 | 是否接受扩大准入限制、autoResize=false 的安全校验、坏工具图片不再发给 provider | 接受；原附件/工具事实保留，明确失败原因，不默默删除用户数据 | T-001 契约冻结及相关行为变更；仓库禁止擅改有意行为 |
| Q-003 | 是否接受“只自动省略旧工具截图，保护用户附件；无法容纳则提示并允许明确选择”的默认预算行为 | 接受；先提供预算错误后的最小明确省略确认，不加入复杂图像 pin/图库 UI | T-003/T-004/T-005 默认选择策略与恢复操作 |
| Q-004 | 新存储格式与现有会话的读取/继续写入/导出契约 | 不自动迁移、不重写旧文件；明确新格式版本。是否要求兼容旧读端或单文件附带全部原图另行确认；不擅自建设兼容层 | T-007；不阻塞 M1 |
| Q-005 | 哪些真实 endpoint/模型以及费用上限允许用于真实验收 | 默认 `gpt-6.1-sol`、medium；复现 Qoder 时单独明确 `qd/dfmodel`。设 opt-in 与请求上限；可先批准 M1 小规模识图，避免等存储阶段才验证基础链路 | T-005 的可选 M1 真模型烟测、T-010 最终验收；规划和离线测试不需要凭据 |

2026-10-18 用户已授权实施：Q-001 关闭，Q-002/Q-003 按方案推荐执行。Q-004 采用保守契约：已有 v1–v3 会话不迁移、不重写格式；新会话使用明确的新编码版本，便携导出解析为标准内联图片；不增加旧读端兼容层。Q-005 未获真实模型/费用授权，保留为独立验收闸门。初始工程参数仍须 T-001 数据冻结，不将未测量参数当产品保证。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-01：同一有效夹具经剪贴板、明确路径、@file、RPC/SDK、steer/follow-up、MCP/扩展工具入口，在相同策略下产生等价图片与稳定编号；有意差异有明确契约。
- AC-02：损坏、错误 MIME/Base64、超输入/像素/请求预算、缺失资产、无编码器等失败可区分；一个坏图不导致其后所有请求持续失败；工具不得因图片处理而重复执行。
- AC-03：有效历史的图片字节、非图片消息、工具 ID、签名/加密推理内容不被无关改写；局部替换不会丢掉原生 payload 的其他事实。
- AC-04：当前用户附件不会为了预算被无提示丢弃；工程保护、provider 限制及 capability 来源可查，模型/endpoint 切换不会复用错误策略。
- AC-05：取消、deadline、dispose 后没有悬挂 worker、过期附件插入、已撤销 prompt 复活或非预期主线程重试；并发和缓存载荷受界限控制。
- AC-06：方向、alpha、极端长宽比、16-bit PNG、小字截图、原图模式及坐标映射通过确定性检查；质量结论另有识图/人工证据，不只比较文件大小。
- AC-07：M2 中原始来源可独立读取；持久化后 resume/fork/clone/export/import/HTML/native child 生命周期及任务恢复能解析所需资产，或明确报告缺失，不跨越资产所有权边界。
- AC-08：默认没有图片上传到新第三方、没有隐式视觉模型调用、没有敏感图片/认证数据进入诊断日志。
- AC-09：原始 payload hook 改图后的已支持 API 再验证；不支持/非合规自定义 stream 的保证边界明确，不把未验证标为通过。
- AC-10：拟议回归有 red/green 或等价故障捕获证据；针对性测试、`npm run check` 和适用系统门槛通过。真实模型只在获准后运行，报告实际 oracle、请求数和未覆盖范围。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002,T-003,T-006,T-011}`；`{T-002,T-003,T-011} -> {T-004,T-005}`；`{T-004,T-005,T-006} -> {T-007,T-012}`；`{T-007,T-008,T-012} -> T-009 -> T-010`；T-008在T-006完成且T-007查看API冻结后可并行开发，整体验收仍等待存储/源接线。T-006纯资产库与M1接线无依赖，源关联/持久化仍在后续集成，不提前改会话格式。
- Parallel batches: B0=T-001；B1=T-002+T-003+T-011（共享类型已冻结）；B2=T-004+T-005（调用方与出站守卫文件不重叠）；B3=T-006；B4=T-007；B5=T-008；B6=T-009；B7=T-010（另需 Q-005）。M1 在 T-004/T-005 各自集成测试通过后有独立闸门。
- Serialization constraints: `types.ts`/共享夹具先由 T-001 独占；T-003 独占配置/模型约束 schema；T-004 独占 AgentSession/入口；T-005 独占 SDK/ModelRuntime 请求桥接与 payload 提取器；T-006 后才允许存储任务修改图片来源契约；SessionManager/recovery/export/格式版本由 T-007 统一修改。T-008 再接 UI/RPC，不能与入口任务同时编辑同一文件。公共 harness、生成文件、锁文件如出现重叠则串行，不假设共享 worktree 有隔离。
- Execution authority: 已获实现授权并使用原生 sibling agents 按独占文件协作；coordinator 独占本文、接线与验收。没有专用 DAG 工具，不虚构工具能力。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 冻结契约与可重放基线

- Status: done
- Owner: coordinator
- Objective: 把已知缺口变成独立可运行的行为判据，冻结 Q-002/Q-003、初始参数与共享类型。
- Inputs and prerequisites: Q-001 实现授权；本文事实与初始参数；当前源码状态重检。
- Scope or files: 拟新增 `core/images/types.ts`、图片测试夹具/特征测试；现有 image/clipboard/RPC/suite 测试只做必要补充；本文由 coordinator 单独更新。
- Expected output: 故障夹具、red 证据、冻结的边界类型、参数与文件所有权；不改变图片行为。
- Dependencies: None.
- Execution steps:
  1. 复核入口、hook 顺序、实际 endpoint 与存储/导出，不照抄旧行号。
  2. 用匿名合成图复现跨入口差异、坏工具图保留、重复编码和取消缺口；不把用户原图提交进仓库。
  3. 测原始图/多图峰值及 Node/Bun worker 路径；记录拟议数字是否合理，确认行为决策。
- Acceptance criteria:
  - 每个回归说明用户可见失败；red 不是 import/fixture/环境错误。
  - 初始参数、允许改变的 raw/fallback 行为和 API 覆盖名单已确认。
- Verification method:
  - 对应 package 内指定 Vitest 文件；资源特征测试仅离线；共享接口类型检查。
- Validation evidence: Node24/Vitest：image-input-contract 三个预期 red（坏字节、MIME 不匹配、超像素均错误接收），邻近 image-process 3/3 通过；灰度匿名1320×2868 1801ms/峰值203248KiB，3840×2160 2599ms/峰值283840KiB。冻结 types.ts 与共享PNG夹具，保留工程保护初值，不宣称已测32MP或Bun。Bun未安装，记录为T-009运行形态缺口。
- Blocker: None.
- Unblock condition: 已取得仓库内实现授权；完成本任务基线与类型冻结后释放 B1。

### [x] T-002 — 有界且可取消的共享图片处理

- Status: done
- Owner: /root/image-codec
- Objective: 校验、解码、方向/alpha、按需编码及缓存只有一个实现，资源任务可正确结束。
- Inputs and prerequisites: T-001 冻结类型、夹具和参数。
- Scope or files: `utils/image-process.ts`、`image-resize-core.ts`、`image-resize.ts`、`image-resize-worker.ts`、必要的 image-convert/exif；拟新增图片专用有界缓存实现。
- Expected output: 分类结果；raw bytes/metadata 可复用；单图/批次截止时间、并发限制和 bounded single-flight；无重复候选 Base64 编码。
- Dependencies: T-001.
- Execution steps:
  1. 真实 MIME/Base64/像素预检与解码 oracle 分离；所有尺寸计算至少 1px。
  2. 无损合适即停，按需走有损阶梯；保留 alpha，明确 original 模式语义。
  3. 串接 AbortSignal、有限队列、deadline、退出确认和完整策略缓存键；仅保留受证明的加载兼容回退。
- Acceptance criteria:
  - AC-02/05/06 对共享处理成立；输入 buffer 未被 detach；取消一个 subscriber 不误杀另一个。
  - 硬输出上限不满足即分类失败，不返回“成功但超限”；不凭压缩大小宣称质量更好。
- Verification method:
  - 指定 image-process/image-processing/image-resize-callers 与新增 worker 生命周期测试；异常、超时、dispose、alpha/方向/长条夹具。
- Validation evidence: coordinator已回读codec/core/worker/validation并提出original/format-only几何修正，修正后重跑10文件91/91通过，涵盖T002的生命周期、编码短路、alpha/EXIF、长条、原图、安全准入。首批3个red已green。Bun运行验证仍未执行。
- Blocker: None.
- Unblock condition: T-001 完成。

### [x] T-003 — 实际路由感知策略与请求预算

- Status: done
- Owner: /root/image-policy
- Objective: 形成可解释的策略 resolver 和纯预算计划器，不猜模型名、不无提示丢用户图。
- Inputs and prerequisites: T-001 的策略类型、参数和 Q-003；当前 Model/config schema。
- Scope or files: 拟新增 `core/images/policy.ts`；必要的 `core/model-config.ts`、`settings-manager.ts` 与已确认模型元数据来源；仅为图片估算接入而触及现有 compaction 估算器，不重写子系统；不修改生成目录内容本身。
- Expected output: 带证据来源的有效限制、配置优先级、受保护图片组及 deterministic budget plan。
- Dependencies: T-001.
- Execution steps:
  1. 以实际 API/解析后 endpoint/明确用户 override 解析限制，区分官方与兼容网关。
  2. 明确 source/encoded/Base64/count/whole-payload 的单位和 unknown 状态；硬限制不被画质偏好放宽。
  3. 默认保护用户图片，只省略允许的旧工具截图；模型/设置改变使策略指纹失效。
- Acceptance criteria:
  - AC-04/08 成立；custom gateway 不误套官方值；重复规划结果与理由稳定。
  - 无视觉/blockImages、原图模式、多图/单大图与无法容纳组有明确结果。
- Verification method:
  - 新增纯 resolver/预算测试，覆盖 endpoint reroute、显式 false/override、count 与 bytes 各自触发、分组原子性。
- Validation evidence: coordinator回读policy.ts与settings差异，独立重跑image-policy.test 31/31通过；T002/T011合并验证10文件91/91通过。无模型名猜测，explicit route覆写仅收紧工程限制；settings getter验证正整数。
- Blocker: None.
- Unblock condition: T-001 完成并确认 Q-003。

### [x] T-004 — 全入口统一准入与工具结果语义

- Status: done
- Owner: /root/image-ingress
- Objective: 所有正常/排队用户图片和工具图片遵循同一契约，不丢草稿、不重复执行工具。
- Inputs and prerequisites: T-002、T-003；已确认 Q-002 的行为变化。
- Scope or files: `core/agent-session.ts`、interactive clipboard/CustomEditor、RPC prompt/steer/follow-up、`cli/file-processor.ts`、`core/tools/read.ts`、`utils/tool-result-images.ts` 与对应独立测试。
- Expected output: 统一 pipeline 接点、最小 UI/RPC 分类错误映射及预算错误后的明确图片选择操作、顺序与 image ID；read/通用 hook 不再重复准备同图。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 在 input/tool_result hook 完成变换后准入；覆盖排队、synthetic/extension 消息实际入口。
  2. 缩放失败不等于图片无效；把已执行工具事实与 provider 图片分开。
  3. 维持现有 attachment registry、3s 路径探测降级、输入代际与 admission/recovery 顺序。
- Acceptance criteria:
  - AC-01/02/05；当前剪贴板与路径粘贴编号、删除、undo、显式 Enter、草稿替换测试不回归。
  - 一张坏图之后的正常 turn 能继续；无隐式工具重放或付费描述。
- Verification method:
  - 相关 clipboard/custom-editor/RPC 指定测试；新增 `test/suite/image-input-pipeline.test.ts` 使用现有 harness/faux provider。
- Validation evidence: coordinator检查pipeline/AgentSession/CLI/read/tool/UI/RPC差异，并独立运行9文件161/161，覆盖本任务pipeline、FIFO、取消、队列、RPC和草稿恢复；子agent扩展13文件252/252及最终5文件73/73，最终tsc通过。source快照首次准备后的持久关联仍由M2接线，不把M1 memo当原图库。
- Blocker: None.
- Unblock condition: T-002/T-003 已完成。

### [x] T-005 — 历史与最终 wire 图片守卫

- Status: done
- Owner: coordinator
- Objective: 请求按实际路由修复历史坏图并检查 hook 后的真实图片，不重写 canonical 历史。
- Inputs and prerequisites: T-002、T-003；provider 图片序列化与 onPayload 契约。
- Scope or files: 拟新增 `core/images/request-guard.ts`/精确 API 提取器；`core/sdk.ts`、必要的 `core/model-runtime.ts` 桥接；必要的 API 测试，不把 Photon 导入 pi-ai。
- Expected output: 可缓存历史 decode verdict、格式转换、预算应用、wire facts/分类本地失败；受支持 API 覆盖表。
- Dependencies: T-002, T-003, T-011.
- Execution steps:
  1. 在有效 endpoint 已解析的位置执行请求策略；对历史只复制有变化的消息，保留有效字节与身份。
  2. 在 before_provider_request 后、实际发送前，按 API 精确提取/检查图片；对新增/改变字节复验。
  3. 覆盖 OpenAI Chat、Responses/Codex/Azure、Anthropic、Google/Vertex、Bedrock、Mistral、pi-messages 的当前图片承载形态；不支持的自定义 API 明示保证边界。
  4. 本地不合法图片错误为不可盲目重试，不进入无意义 provider fallback 循环；不改签名/加密/非图片内容。
- Acceptance criteria:
  - AC-02/03/04/08/09；恢复会话、切换模型/endpoint、hook 换图及 text-only/blockImages 均正确。
  - 有效历史不因动态报告影响前缀；不把 HTTP 200 等同图像已识别。
- Verification method:
  - 新增 request-guard faux-provider suite；每种内置 API 的 hook 后 payload 截获测试；已有 pi-ai image-tool-result 路由测试；预算失败→用户明确选择→后续正常 turn 的恢复链路。
  - 若 Q-005 另获批准，可在此先运行有限 M1 真识图烟测，无须等待 M2；否则 M1 只标离线通过，保留远端识别未验证项。
- Validation evidence: coordinator完成SDK认证后context接线、hook后wire守卫和历史临时修复，独立运行9文件161/161通过（request-guard/SDK/source-store/runtime/wire/block/RPC/clipboard/pipeline）。含资源失败不永久缓存、坏历史保留工具事实、block不可绕过、预算错误发布IDs→选择→恢复。wire覆盖10种内置API；自定义stream若不调用onPayload不在保证内；远端接收未验证。
- Blocker: None.
- Unblock condition: T-002/T-003/T-011完成；真实API仍须Q-005。

### [x] T-006 — 原始附件资产与来源身份

- Status: done
- Owner: /root/image-assets
- Objective: 模型派生图片不替代原图；原图有本地可控、可验证的身份。
- Inputs and prerequisites: T-001冻结源大小/摘要/错误契约；只做独立会话作用域资产库，M1关联留待T-007/T-008。
- Scope or files: 拟新增 `core/images/source-store.ts`；pipeline/附件来源关联；只准备存储接口，不抢先修改 JSONL 物理格式。
- Expected output: 会话作用域 SHA-256 资产写读、来源清单、源/派生映射、失败不发送假引用。
- Dependencies: T-001.
- Execution steps:
  1. 在转换前保存收到的快照；文件路径只作来源，不作内容身份。
  2. 实现受控根、原子写/摘要校验与内存会话临时生命周期；不做公开 URL。
  3. 明确源与派生文件、取消后孤儿和持久关联所需字段，交给 T-007 集成。
- Acceptance criteria:
  - 同图会话内去重；篡改、缺失、越界/符号链接被正确拒绝；读取不跨 session/team 所有权。
  - 不因保留原图改变 provider 图片或自动发送私有路径。
- Verification method:
  - 本地临时目录资产测试；并发同内容、截断写、取消、无持久会话、来源文件后改和 owner mismatch。
- Validation evidence: coordinator回读source-store完整实现与故障注入测试，独立运行65/65（并纳入9文件161/161）。会话作用域摘要、同步原子发布、内容校验、symlink/hardlink/owner/目录身份负例通过。原图来源的pipeline关联尚属T-007/T-008，不把纯资产库当已完成集成。
- Blocker: None.
- Unblock condition: T-001已完成；格式/源关联由T-007集成。

### [x] T-007 — 会话物理图片编码与完整生命周期

- Status: done
- Owner: /root/image-storage
- Objective: 图片去重落盘不能以牺牲恢复、分支与可移植导出为代价。
- Inputs and prerequisites: T-006；Q-004 明确批准；现有 recovery 与团队存储约束重新核对。
- Scope or files: `core/session-manager.ts`、新图片存储 codec、必要的 recovery-storage/导出/导入/团队资源接线及指定存储测试。
- Expected output: 明确版本的物理图片引用、逻辑水合、资产先行的提交顺序、完整单文件导出和所有权安全；不自动迁移或清理旧文件。
- Dependencies: T-004, T-005, T-006.
- Execution steps:
  1. 冻结存储版本与继续写入契约；不得用假兼容层跳过 Q-004。
  2. 只编码有定义的图片载荷，包括必须恢复的 prompt/排队/快照字段；不遍历重写 opaque 签名块。
  3. 接入 resume、branch/fork/clone、export/import/HTML 和 native child 生命周期；资产提交失败不承诺引用。
  4. 加入可达性/完整性检查；不自动执行 GC 删除。
- Acceptance criteria:
  - AC-03/07；独立进程/目录导入可读；删除源会话不破坏已承诺的 fork/clone。
  - 故障注入只允许孤儿，不允许已提交 dangling reference；恢复不会重跑已执行工具。
- Verification method:
  - session-manager 的 recovery-storage/durable-storage/history-integrity/file-operations 指定测试；新增资产 recovery/export suite；native team deletion 与 cache-prefix 回归。
- Validation evidence: coordinator回读codec/SessionManager/export/team差异，独立12文件148/148通过；M2独立审查发现仅派生图损坏时丢健康原图，补2个red后修为显式原图恢复，3文件113/113及10文件121/121通过，覆盖原图inventory/读取/fork后删除旧owner仍可读。子agent另跑12文件237/237和subagent47/47。v4新文件、旧1–3不迁移到4、恢复hash顺序/透明导出/故障发布已验；物理断电与Bun未测。
- Blocker: None.
- Unblock condition: T-006完成、Q-004按保守契约实施；source handoff由T-012并行接入。

### [x] T-008 — 附件查看、坐标与分级报告

- Status: done
- Owner: /root/image-ui
- Objective: 用户与工具知道看的是哪张图、经过什么处理、在哪里可读原图，且客户端不因新报告破坏协议。
- Inputs and prerequisites: T-006完成、T-007查看API及imageSource契约已冻结；T-004/T-005已有基本错误反馈。T-007/T-012最终整合由T-009把关。
- Scope or files: interactive 附件/用户消息/工具图片展示、相关 TUI 组件、RPC 可选结构化报告契约与文档；不新增快捷键硬编码。
- Expected output: 原图查看入口、派生尺寸/原因、稳定省略说明、只在已证明时给坐标变换；默认脱敏诊断。
- Dependencies: T-004, T-005, T-006.
- Execution steps:
  1. 沿用编号与原有附件 registry；检查恢复、编辑、undo 和分支后的来源关联。
  2. 展示 accepted/prepared/serialized/远端未验证的区别；保护 RPC stdout 与既有事件消费者。
  3. DPR/裁剪/padding 变换有证据才输出，缺失时明确不可映射。
- Acceptance criteria:
  - AC-06/07/08/09；不会显示签名 URL 或凭据；报告不周期性注入 system prompt。
  - UI 和 RPC 各自有实际消费者测试，不只断言内部字段赋值。
- Verification method:
  - 指定 TUI/编辑器、RPC framing/client、export HTML 测试；隔离 PTY 操作验证，不能把文字快照当全部交互通过。
- Validation evidence: coordinator回读helper/UI/RPC差异与新consumer测试，独立8文件86/86，并完成隔离真实PTY键入来源列表/本地预览/报告；子agent10文件102/102。RPC LF分帧/客户端分类错误、checkpoint-only来源、wrongbranch/hash、没有默认图字节/私有路径已测。终端图像协议实际raster显示未测；PTY仅验证metadata fallback和键盘路径。
- Blocker: None.
- Unblock condition: T-007/T-012已整合，冻结查看API已实现。

### [x] T-009 — 全链路离线验收与性能/质量对照

- Status: done
- Owner: coordinator
- Objective: 以真实行为门槛验收 M1/M2，确认新结构没有扩大复杂度或破坏邻域。
- Inputs and prerequisites: T-008；所有前序任务的实际验证日志。
- Scope or files: 对应新旧指定测试、匿名夹具、settings/session/RPC 文档及必要 package 检查；不更改无关测试或目录。
- Expected output: AC 对照证据、Node/Bun 运行形态差异、编码/缓存/取消指标与剩余风险；支持停在 M1 的独立评审。
- Dependencies: T-007, T-008, T-012.
- Execution steps:
  1. 跑全链路负例与生命周期矩阵；检查各层不重复工作。
  2. 用同夹具和版本对照编码次数、时长、缓存载荷、worker 数与峰值 RSS；不先承诺百分比收益。
  3. 用小字/alpha/方向夹具验证保真，人工与模型质量评估分开；检查完整 diff 和跨任务集成。
- Acceptance criteria:
  - 适用 AC 均有证据而非代理自报；有效原图/元数据没有无故变化；文档与真实行为一致。
  - 新资产格式未通过生命周期门槛时保持未启用，不以关闭测试掩盖失败。
- Verification method:
  - 指定包内测试与 `npm run check`（完整输出）；非 e2e 全量仅用 `./test.sh` 且按风险与权限决定；不擅自 build 或跑全 Vitest。
- Validation evidence: coordinator最终命名coding-agent矩阵44文件566/566，另匿名7px文字/1px线条字节保真2/2；subagent47/47、AI纯序列化4/4，合计619个离线用例。根npm run check完整输出exit0（格式、依赖pin/锁/相对导入、tsc、browser smoke），范围核对无无关文件。两次独立审查的问题均有修正/回归；实际隔离PTY通过。32MP合成灰度一次1227ms/最大RSS约555MiB。只对可运行Node/确定性保真声明通过，Bun、安装包、物理断电、终端raster与真实识图未认证；不将体积/延迟当视觉质量结论。
- Blocker: None.
- Unblock condition: T-007/T-008/T-012完成；可运行离线门槛已满足。

### [ ] T-010 — 经授权的真实识图与启用验收

- Status: blocked
- Owner: coordinator
- Objective: 证明实际用户链路上的原图确实可读，而不只是假 provider 接受了字段。
- Inputs and prerequisites: T-009；Q-005 的 endpoint/模型/费用上限与外部操作批准。
- Scope or files: 显式 opt-in 的指定真实验收脚本/测试、隔离 PTY/测试会话；不改参考仓库、凭据内容或默认服务配置。
- Expected output: 指定原图与匿名夹具经 easy-pi 本身完整路径识别的报告；请求数、模型/effort、结果与未验证范围。
- Dependencies: T-009.
- Execution steps:
  1. 设置 `PI_REAL_MODEL_EVAL=1`；默认 `gpt-6.1-sol`/medium，只跑指定用例且限制请求数。
  2. 如用户另行批准 Qoder，用 `qd/dfmodel` 验证原故障链；不得将原图人工写入答案提示或把直调网关冒充完整 TUI/RPC 通过。
  3. 验证可读文本/图形 oracle、故障提示、重试前后副作用和后续正常 turn；无内容输出前才允许明确有限重试。
- Acceptance criteria:
  - AC-10；记录实际响应但不打印/持久化凭据；未授权的模型/上传/重启均未发生。
  - 失败可重放并明确边界，不以 HTTP 200 单独判断识图成功；启用须有用户批准。
- Verification method:
  - 指定 opt-in 真模型文件 + 隔离真实交互；只对批准的场景声称通过。
- Validation evidence: 完成T-009后检查Q-005授权闸门，仍无指定endpoint/模型/费用批准；未发起本任务真实请求，也未读写凭据/重启服务。此前外部Qoder成功只属于F-002历史证据，不冒充本次产品验收。
- Blocker: Q-005未获授权；真实视觉语义oracle、付费/凭据/外部服务操作禁止默认执行。
- Unblock condition: 用户明确批准实际endpoint、模型/effort和有界费用/请求数后，新增显式opt-in目标用例并执行；默认gpt-6.1-sol/medium，Qoder另行批准。

### [x] T-011 — 类型化 wire 提取与实际模型请求接点

- Status: done
- Owner: coordinator
- Objective: 将T-005的序列化形态识别拆为独立可验证单元，避免用任意递归walker触碰签名/工具参数。
- Inputs and prerequisites: T-001冻结类型；已核对内置API序列化源码。
- Scope or files: 新增 `core/images/wire.ts`、`test/image-wire.test.ts`；ModelRuntime仅增加无全局状态的每请求prepareContext接点及独立测试，不改SDK策略接线。
- Expected output: 各内置API的精确inline/reference图片清单、未知API显式结果、只读有界遍历；认证解析后实际model可传给会话专属context准备回调。
- Dependencies: T-001.
- Execution steps:
  1. 识别Chat/Responses/Anthropic/Google/Bedrock/Mistral/pi-messages图片位置。
  2. 不访问工具JSON参数或reasoning/签名块；对畸形承载字段分类失败。
  3. 用真实形态夹具验证图片发现、外部引用区分、原始payload不变；验证实际endpoint回调/取消/跨请求隔离及回调不泄漏到adapter options。
- Acceptance criteria:
  - 各内置API有独立行为检查；错误位置不吞掉、不遍历无关载荷。
- Verification method:
  - 指定 `test/image-wire.test.ts` 和 `test/model-runtime-context.test.ts` 离线运行。
- Validation evidence: wire/model-runtime-context/model-runtime-auth-options三个文件31/31通过。所有10种内置API形态、引用脱敏、工具参数不遍历、嵌套有界；认证后endpoint、取消未dispatch、跨并发/后续请求无callback串用已验证。
- Blocker: None.
- Unblock condition: T-001已完成。

### [x] T-012 — 原图快照到会话来源接线

- Status: done
- Owner: /root/image-sources
- Objective: CLI首次准备后仍能提交真实源快照，准入与工具hook后将源交给所属会话；不永久全局保留Base64。
- Inputs and prerequisites: T-004/T-005/T-006完成，T-007冻结attachImageSource接口。
- Scope or files: pipeline.ts、agent-session.ts、tool-result-images.ts、必要CLI与对应来源接线测试；不编辑SessionManager/codec/UI/SDK。
- Expected output: 有界临时来源handoff、会话source sink、源与派生事实关联，取消后不复活提交。
- Dependencies: T-004, T-005, T-006.
- Execution steps:
  1. 转换前快照经有界handoff保留到会话提交；不把路径当源。
  2. 用户/队列/工具hook后统一调用会话source sink，成功后释放临时载荷。
  3. 对源过期/丢失明确失败，不将派生图冒充原图。
- Acceptance criteria:
  - CLI/read/SDK与工具来源可独立读取，源文件改变不改变已接收快照；批次/缓存均有界。
- Verification method:
  - 指定pipeline来源与会话harness测试，typecheck与scoped格式检查。
- Validation evidence: coordinator完整回读pipeline和AgentSession/tool差异并独立运行10文件121/121（含26项来源handoff、原入口与SDK/guard/存储集成）。子agent7文件85/85。跨会话owner隔离/共享SHA claim释放、caller mutation两个路径、CLI源文件后改、hook、队列、自定义消息、branch/session取消与报告anchor均通过；已消费派生对象跨会话再用须重附原图，明确storage_missing而不伪造来源。
- Blocker: None.
- Unblock condition: T-004/T-005/T-006完成；T-007冻结契约已整合。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

### 已有测试锚点（已发现文件，不代表本轮运行）

- coding-agent：`test/image-process.test.ts`、`image-processing.test.ts`、`image-resize-callers.test.ts`、`tool-result-images.test.ts`、`custom-editor-image-path.test.ts`、`interactive-mode-clipboard.test.ts`、`block-images.test.ts`、`rpc-input-validation.test.ts`、`rpc-prompt-response-semantics.test.ts`。
- suite：`test/suite/agent-session-tool-result-images.test.ts`、`agent-session-task-recovery.test.ts`；regressions 的 `recovery-storage-export.test.ts`、`4a61062a-recovery-cache-prefix.test.ts`、`session-history-boundaries.test.ts`。
- storage：`test/session-manager/{recovery-storage,durable-storage,history-integrity,file-operations}.test.ts`、`test/session-manager-team-deletion.test.ts`。
- ai：`test/image-tool-result.test.ts`、`openai-completions-tool-result-images.test.ts`、`openai-responses-tool-result-images.test.ts`、`google-shared-image-tool-result-routing.test.ts`。
- tui：`test/editor.test.ts` 及现有图片组件/终端图像测试。

### 最小有效矩阵

| 维度 | 必须覆盖的判据 |
| --- | --- |
| 输入 | 同图跨入口，input/tool_result hook 换图，纯图片、混合文本、多图、排队后模型改变、明确路径文件准入后变化 |
| 容器 | PNG 8/16-bit、JPEG EXIF 方向、WebP、GIF 当前语义、BMP 转换；错误 MIME、截断中部、只剩头尾、错误 padding/非法 Base64 |
| 几何/保真 | 1×1、1×10000/10000×1、超像素、高熵、透明抗锯齿、DPR、裁剪/padding、真实截图式小字 |
| 资源 | 队列满、最后/部分等待者取消、worker 加载失败、处理超时、dispose、Node/Bun fallback、缓存驱逐与策略切换 |
| 请求 | count/单图/总量分别超限；保护当前用户组；旧工具图省略；预算失败后明确选择及撤销；原生 payload/hook 绕过；实际 endpoint reroute；输出图不误计 |
| 历史 | 损坏旧图、缺失资产、签名推理保真、model switch、prefix 稳定、坏图后可继续正常 turn |
| 存储 | 原子写故障、resume、fork/clone 独立所有权、任务恢复/排队/分支、HTML/JSONL 可移植导出与导入、跨团队资源删除负例 |
| 网络/隐私 | 默认无新增网络、无自动 vision call、公网目的地未启用；真实测试 opt-in、无密钥/完整图像日志 |

性能改善以明确可观察工作量先验收：PNG 达标时不做无用 JPEG 阶梯；read 和 afterToolCall 不重复解码；相同策略重复请求命中缓存。延迟与 RSS 为测量结果，不给未经测量的提速承诺。

### 执行命令规范

```sh
# 例：在 packages/coding-agent 运行已存在的针对性测试
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/image-process.test.ts

# 有代码变更之后，从 pi/ 根目录运行；不能只截尾部输出
npm run check

# 仅当获准且需要非 e2e 全量检查时，从根目录运行；不直接跑全 Vitest
./test.sh

# 真模型仅在另获 Q-005 批准后，传给指定测试；不会默认进入 CI
PI_REAL_MODEL_EVAL=1 <指定的真实验收命令>
```

新测试文件在创建后必须运行；实施者应把上述示意命令替换为实际路径与完整结果。真实请求默认 model/effort 按仓库规则，不能继承当前运行中的高推理档位。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

| 风险/约束 | 处理与停止条件 |
| --- | --- |
| 把网关签名错误误诊为图片过大 | 保留 F-002 的单变量链；本地处理不声称修复外部协议；网关错误回执未知时诚实标记 |
| autoResize/raw 和工具失败行为是有意设计 | Q-002 未确认前不修改；不能将“保留证据”偷换成“继续发坏图”或“删除输出” |
| 新数字看似精确但未测量 | 初始参数均标明依据；T-001 失败则更新方案，不关闭门槛 |
| 固定压缩损害小字或 alpha | 保留当前基线与原图来源；测试截图语义与透明边缘，不能只断言字节更少 |
| 像素/超时不能完全限制外部内存 | 控制并发、predecode 尺寸与输入，测 RSS；不声称线程 heap 限制能硬隔离解码器 |
| 层层 guard 导致重复工作或缓存错用 | 源+策略+codec 指纹与 single-flight；metadata/performance 不进入动态模型前缀 |
| 新 blob 引用破坏恢复/导出/团队删除 | M2 独立审批；资产先于引用；指定生命周期故障注入全部通过才启用 |
| 额外全局 CAS/GC 增加复杂度与权限风险 | 首期 session-scoped，默认不删除；跨 session 去重与自动 GC 不在范围 |
| endpoint/auth reroute 与 raw hook 使早期结论失效 | 在实际模型与 hook 后复核；custom stream 未遵守 onPayload 时明示未覆盖 |
| 自动丢图使回答看似完整 | 保护用户图组；省略旧工具图也给稳定原因和源引用；必要时失败而不是装作成功 |
| 并行编辑共享 worktree | 按文件独占与 DAG 批次；共享 schema/harness/codec 串行，不依赖自动 merge |
| 外部网络/费用/服务变更未获准 | 本轮不执行；T-010/Q-005 或可选上传任务开始前必须另行授权 |

实现正在按任务状态推进；Q-005 为真实模型验收的独立闸门，不阻止离线代码交付。

### 自我对抗审查

- 如果把所有工作都放入口：旧历史、模型切换与 raw hook 能绕过，因此需要临时请求/最终 wire 边界。
- 如果只放 provider 前：坏图与巨量原图先污染恢复日志，且所有轮次重复处理，因此需要统一准入与缓存。
- 如果只检测 PNG/JPEG 头：中部损坏仍能通过，因此必须有实际 decode oracle。
- 如果文件已经小于目标就永远不解码：不能证明是有效图片；但对已验证内容应缓存而非重复解码。
- 如果不保留 source：压缩后无法重取小字；如果一开始改全局会话格式：恢复风险大于 M1 收益，因此 M1/M2 解耦。
- 如果原图模式可以绕开所有限制：一张图片仍可耗尽内存或毒化请求，因此保真选项与安全限制分开。
- 如果单 subscriber 取消就杀共享工作：其他请求错误失败；如果永不杀：取消不生效，因此需要有界订阅生命周期。
- 如果把 URL B 仍是 URL 判为“没有进展”：会漏掉合法降级；若不断换随机 URL 判为进展：会无限重试，因此未来上传必须以有限来源序列推进。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18 实施开始：用户明确要求开始并完成交付；基线仍为 0ba5721ec，除本文外工作区干净。切换 execute，T-001 由 coordinator 开始；采用推荐行为和保守格式契约，不启动真实付费请求。已确认可用原生 spawn_agent；未发现专用 subagent DAG 工具，后续使用现有有界 sibling 任务。
- 2026-10-18 T-001 完成：新增共享边界类型与匿名PNG夹具；指定Vitest获得3个语义正确red、邻近3个通过；Node基线记录两种图形耗时/RSS。Bun不可用，未安装运行时。T-002/T-003进入B1，分别独占codec与policy/config文件；coordinator保留文档与后续入口集成写权限。
- 2026-10-18 T-011开始：将独立的wire位置提取从T-005拆出，由coordinator在B1并行完成，未提前改SDK调用链。
- 2026-10-18 T-011完成：31/31指定测试通过；ModelRuntime增加仅每请求的prepareContext回调，在auth解析后调用并在provider dispatch前剥离，支持full/simple且可取消，无共享会话策略。
- 2026-10-18 B1集成：coordinator回读并重跑10个指定文件91/91通过；T-002/T-003完成。修正发现的原图模式2000px误约束与格式转换不应缩图问题。T-004由image-ingress、T-005由coordinator开始，文件范围分离。
- 2026-10-18 依赖细化：T-006的纯资产库可依赖T-001独立实现，源关联/编码在T-007等待M1；启动image-assets独占source-store与测试，避免主链等待期间串行做独立I/O组件。
- 2026-10-18 T-005/T-006验收：coordinator回读实现并独立运行9文件161/161（含65项资产故障测试）。补资源队列失败不能永久缓存为坏图的回归。启动只读image-m1-review。
- 2026-10-18 T-004收口：子agent冻结入口文件；coordinator检查关键diff并独立复跑相关集成，接受M1离线通过。T-007启动，image-assets followup立即执行失败且未改文件，检查结果后换新isolated image-storage独占会话物理codec/SessionManager/存储生命周期；T-012拆出源快照handoff，按冻结接口并行；coordinator负责随后客户端。

- 2026-10-18 M1对抗审查：发现并用回归修正Google嵌套工具图漏检、上一轮截图被永久保护、有效原图超预算被省略、模型切换时坐标提示丢失；补实际endpoint override SDK接点与pi-messages源metadata剥离，4文件66/66。T-012同时修独立branch报告anchor/准入代际和caller mutation回归。另用匿名8000×4000灰度PNG完成一次32MP冷处理：1227ms，macOS time最大RSS582,320,128字节（约555MiB），不是硬内存保证或照片平均值；脚本已删除。
- 2026-10-18 T-008启动：T-007查看API冻结后，与存储/来源独占不同文件并行；T-009最终整合仍等待T-007/T-008/T-012。
- 2026-10-18 T-007/T-012验收：parent独立12文件148/148；存储审查发现仅派生图坏而丢健康原图，补2red→green，3文件113/113与整合10文件121/121通过。source agent修跨owner memo、共享源claim释放和memo可变owner再入；随后完整回读并通过。storage followup再次立即执行失败，父级接管两文件完成该修正，不虚构子agent已修。
- 2026-10-18 T-008接受：parent8文件86/86通过；子agent10文件102/102，docs与metadata投影回读完成。全部实现文件已冻结，T-009开始最终全仓check与命名离线矩阵；没有启动真实API。
- 2026-10-18 离线PTY：独立tmux110×36，空HOME/PI_OFFLINE/网络fetch禁用，只调用init而不启版本更新，faux正常图输入后实际键入/images sources、/images source 8位prefix、/images，看到2400×4原图/2000×3派生事实、原图本地预览fallback、远端UNVERIFIED；未测试支持图像终端的真实raster显示。隔离server/脚本/HOME已清理。以下条目是先前plan阶段历史。

- 2026-10-18 最终离线验收：命名coding-agent44文件566项、另7px字节保真2项、subagent47项、AI4项全部通过；根check通过，未运行带真实API/顶层OAuth的image-tool-result或Responses e2e。追加一条已验证来源生命周期教训到pi/LEARNS.md，未改已有内容。T-009完成，检查T-010闸门后因Q-005未批准从启动检查转blocked；实现交付与远端验收分别报告。

- 2026-10-18：确认用户只要求方案，选择 plan 模式；读取 best-practice 与规划技能、项目规则，未启动子 agent。
- 2026-10-18：复核基线 commit/干净工作区、ImageContent/settings、实际模型认证路由、onPayload、会话/export 接点与既有测试；复用前两轮只读参考审查和已验证的外部签名修复证据。
- 2026-10-18：创建并填写本文件；默认网络引用、隐式视觉模型、运行时迁移及全局存储被排除；M1 与物理存储变更解耦。
- 2026-10-18：完成文内自我对抗审查；补充极小图片数量保护与视觉 token 估算边界，避免把字节预算冒充全部上下文预算；所有实现任务仍为 pending。
- 2026-10-18：完整回读方案并复核 M1/M2 留证边界、共享 ModelRuntime 的请求作用域及 token/数量预算；补齐“预算拒绝后用户可明确选图”的恢复操作与可提前批准的 M1 真识图门槛，避免把首次实际验证推迟到存储重构之后。任务文档结构校验通过；新增文件空白检查通过，工作区仅新增本文件。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001至T-009、T-011/T-012仓库内实现与可运行离线验收完成。coordinator命名用例：coding-agent566+字节保真2、subagent47、AI4，共619/619；根 `npm run check` 通过；隔离PTY实际命令路径通过；任务文档/差异检查通过。原图资产、恢复/fork/clone/导出、保护预算、hook后守卫与独立审查修正均有回归证据。用户使用入口见 `packages/coding-agent/docs/images.md`。
- Limitations: 整体结果仍为partial，T-010因Q-005未授权blocked；不能声称远端图片已接收或识别。Bun未安装，未构建/安装发行产物、未测物理断电或支持图像终端的raster呈现；7px夹具仅证明字节保真，不是OCR/人工画质认证；32MP测量只覆盖一张可压缩合成灰度图，非RSS硬上限/通用性能承诺。旧v1–v3没有新增耐久原图，portable导出只携带逻辑派生图。
