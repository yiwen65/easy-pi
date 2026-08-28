# Pi Tools V2.1 分阶段增强方案（修订版）

## 0. 文档定位

本方案保留 V2 的核心方向：

```text
模型层只暴露：search / read / edit / run
运行时提供专业能力、结构化错误和恢复语义
宿主层提供本地/远程 Provider、策略和专用 TUI
```

但不再把搜索内核、超大目录快照、编辑 DSL、崩溃恢复事务、Overlay、完整 Hook ABI 和默认切换压进同一个版本。

版本定位调整为：

```text
V2.1  Structured Search + Search TUI
V2.2  Read Provider + Read TUI
V2.3  Shared Mutation Core + Edit TUI
V2.4  Experimental Journaled Mutation
V2.5  Host Provider/Adapter stabilization
V3.0  默认 profile 切换（必须通过评测门槛）
```

其中只有 **V2.1 Structured Search** 是本文第一阶段的承诺交付；后续阶段是有前置门槛的路线图，不构成同一版本的验收范围。

---

# 一、目标、非目标与不可破坏合同

## 1.1 总目标

保留四个对模型稳定、低选择成本的一级意图：

```text
search  发现未知目标
read    读取已知资源
edit    改变工作区状态
run     执行程序
```

逐步把原生 `grep/find/ls/read/edit/write` 的成熟实现提取为：

-结构化 Provider；
-可选 Capability；
-共享 Runtime；
-专用 Renderer；
-兼容 Adapter。

最终目标是减少重复执行逻辑，而不是立即删除原生工具 API。

## 1.2 当前版本非目标

V2.1 不承诺：

- FFF SDK 或 daemon 集成；
-所有文件搜索默认严格全局 Top-N；
-大目录 external merge sort；
-稳定目录 snapshot；
-新的 canonical edit patch DSL；
-多文件 journal、自动崩溃恢复或 Overlay；
- shell sandbox；
-细粒度 Search/Read/Edit Hook 全集；
-默认 profile 切换；
-移除原生工具。

这些能力必须在后续阶段分别证明需求、正确性和性能。

## 1.3 不可破坏的现有合同

### 模型工具集合

模型默认仍只需要理解：

```text
search / read / edit / run
```

每个工具保持一个必填主参数，高级控制使用可选字段。

### `run` 结果语义

当前合同保持不变：

```text
exit 0 / nonzero  →正常结构化结果
timeout           →正常结构化结果，details.timedOut=true
abort             → ABORTED 工具错误
spawn failure     → SPAWN_FAILED / SHELL_UNAVAILABLE 工具错误
```

`TIMEOUT` 不列为普通 v2 run 工具错误。

###部分结果语义

有用但不完整的搜索结果是正常结果：

```ts
details.partial = true
```

不能把已有结果丢弃后仅抛出 `SEARCH_PARTIAL`。

### WorkspacePolicy 边界

当前 WorkspacePolicy 是 best-effort 路径策略，不是对抗恶意文件系统的 sandbox。

它可以：

-限制规范化路径是否位于允许 root；
-拒绝已检测到的 symlink escape；
-区分 read/write policy。

它不能单独保证：

-抵御所有 TOCTOU；
-阻止 shell 命令访问 workspace 外；
-提供 handle-relative/openat 级边界；
-替代 OS sandbox、容器或 Overlay。

任何安全或事务保证都必须明确依赖 backend capability，不能仅引用 WorkspacePolicy。

### Renderer 生命周期

继续使用现有 `ToolDefinition`：

```ts
renderCall
renderResult(result, { isPartial, expanded }, theme, context)
```

partial update、共享 state、timer 和 component reuse 均由现有 render context 表达。V2.1 不新增重复的 `renderUpdate` 生命周期。

---

# 二、分层架构

```text
                         LLM
                          │
         search ───── read ───── edit ───── run
                          │
                  Model Contracts
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
 Search Runtime      Resource Runtime    Mutation Runtime    Exec Runtime
       │                  │                  │                  │
 SearchProvider      ReadProvider        MutationBackend    ExecutionEnv
       │                  │                  │                  │
 rg/fd/fs/remote     Node/env/SSH        local/journal      local/remote
       └──────────────────┴──────────────────┴──────────────────┘
                          │
                  Workspace Services
       policy / observation / coordination / telemetry
                          │
                  coding-agent Host UX
       renderer / theme / approval / compatibility adapters
```

## 2.1 路由原则

执行路径必须单向：

```text
Model Tool
→ Tool Runtime
→ Provider/Backend
→ optional ExecutionEnv capabilities
→ platform implementation
```

禁止同一个 Runtime 有时直接访问 Node、有时绕过 Provider、有时再调用原生 ToolDefinition。

## 2.2 包边界

### `packages/agent`

负责：

-模型 schema；
-运行时语义；
- Provider/Backend 接口；
-结构化 details；
-错误与恢复协议；
-调度和 replay metadata；
-平台无关 capability detection。

### `packages/coding-agent`

负责：

-本地 Node Provider；
- `rg` / `fd` 进程适配；
- SSH/远程 Adapter；
-专用 TUI Renderer；
-theme 和键盘交互；
-旧 Operations 兼容层。

`packages/agent` 不直接依赖 Node 本地实现或 coding-agent TUI。

## 2.3 Provider 生命周期和所有权

注入实例和注入 factory 的生命周期必须不同：

```ts
interface ProviderHandle<T> {
  provider: T;
  ownership: "session" | "host";
}
```

规则：

- factory 为每个 session 创建的 Provider 默认为 `session` ownership，由 session close；
-直接注入并可能被多个 session 共享的实例默认为 `host` ownership，不由 session 擅自 close；
- reload 只关闭 session-owned Provider；
- close 必须 best-effort、幂等，并具有独立错误记录；
- daemon/index Provider 必须定义引用计数或 host-owned 生命周期。

---

# 三、V2.1：Structured Search

## 3.1 模型接口

```ts
interface SearchInput {
  /** 文本、文件名或 glob。唯一必填参数。 */
  query: string;

  /** 默认 text。 */
  kind?: "text" | "files" | "glob";

  /** 搜索范围；默认 workspace root。 */
  path?: string;

  /** text/files 的候选文件过滤。 */
  fileGlob?: string;

  /** 默认 smart。 */
  case?: "smart" | "sensitive" | "insensitive";

  /** 仅 text 有效；默认 false，即 literal。 */
  regex?: boolean;

  /** 仅 text 有效；默认 0。 */
  context?: number;

  /** 默认 20，具有硬上限。 */
  limit?: number;

  /** 上一页返回的 opaque continuation。 */
  cursor?: string;

  /** 仅 files 有效；默认 fast。 */
  ranking?: "fast" | "global";
}
```

仍只有 `query` 必填，但“一个必填字段”不被视为模型一定更容易调用的证明。schema 成功率必须通过真实模型评测确认。

## 3.2 三种 kind 的明确语义

### `text`

```text
literal 默认
regex 显式开启
支持 smart/sensitive/insensitive
支持 context
支持 fileGlob
```

结果按稳定的：

```text
normalized relative path → line → column
```

排序。

### `files`

用于低延迟模糊定位文件或目录。

默认：

```ts
ranking: "fast"
```

允许 Provider 使用索引、有限候选或 early stop。结果必须明确：

```ts
approximate: true | false
partial: true | false
```

`ranking="global"` 才要求完整扫描候选空间并维护 Top-K。它可能显著更慢，且只在扫描完整时声明 global complete。

### `glob`

用于确定性路径枚举，不使用模糊分数。

排序固定为规范化相对路径字典序。分页 continuation 必须稳定；达到 deadline 时返回 partial，而不是伪装成完整枚举。

## 3.3 精确、近似和部分结果不能混淆

```ts
interface SearchPage {
  hits: SearchHit[];
  nextCursor?: string;

  /** Provider 是否扫描完本次语义要求的候选空间。 */
  complete: boolean;

  /** 结果是否使用近似或有限候选排名。 */
  approximate: boolean;

  /** deadline、provider failure 或 budget 是否导致提前停止。 */
  partial: boolean;

  generation?: string | number;
}
```

规则：

- exact hits 和 approximate hits 在 details 和 TUI 中分区；
- `complete=false` 时不能声称严格全局 Top-N；
- partial page 仍作为正常结果返回；
-模型可见文本必须提示如何缩小 `path` 或 `fileGlob`；
- `ranking="global"` 在 deadline 前未完成时返回 partial global attempt，不降级后伪装完整。

## 3.4 Cursor 是公开 continuation 协议

`cursor` 虽然 opaque，但已经属于模型协议，不能再称为完全隐藏的内部概念。

cursor 必须：

- versioned；
-绑定 query、kind、path、fileGlob、case、regex、context、ranking；
-绑定 provider ID 和 generation；
-绑定 workspace/session scope；
-防止被用于不同请求；
-过期时返回 `STALE_CURSOR`；
-不能包含未经处理的敏感路径或凭据。

恢复信息：

```text
STALE_CURSOR
The search index or request changed. Repeat the same search without cursor.
```

## 3.5 Provider 接口

```ts
interface SearchCapabilities {
  textLiteral: boolean;
  textRegex: boolean;
  context: boolean;
  fuzzyFiles: boolean;
  glob: boolean;
  stableCursor: boolean;
  globalRanking: boolean;
}

interface SearchProviderV2 {
  readonly id: string;
  readonly capabilities: SearchCapabilities;

  search(
    request: SearchRequest,
    context: SearchContext,
    signal?: AbortSignal,
  ): Promise<SearchPage>;

  syncPaths?(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{ generation?: string | number }>;

  close(): Promise<void>;
}
```

Runtime 必须在调用前校验 capability；不能静默忽略 Provider 不支持的 case/context/global 等请求。

## 3.6 V2.1 内置 Provider

### `RipgrepJsonProvider`

直接执行：

```text
rg --json
```

将事件转为结构化 hit：

```ts
interface TextSearchHit {
  kind: "text";
  path: string;
  line: number;
  column: number;
  text: string;
  ranges: Array<[number, number]>;
  before?: SearchContextLine[];
  after?: SearchContextLine[];
}
```

禁止经过原生 grep 的最终文本格式。

### `FdNulProvider`

直接执行：

```text
fd --print0
```

使用 NUL 分隔解析路径，避免换行或特殊字符导致文本协议歧义。

### `ExecutionEnvSearchProvider`

作为无 `rg`/`fd` 或远程 backend 的兼容实现，能力可以较低，但必须准确声明 capabilities 和 partial/approximate。

### FFF

FFF 仅作为 V2.1 之后的候选可选 Provider。当前不能作为基础依赖或验收条件。

引入前必须单独确认：

-真实 SDK/daemon API；
-许可证和发布方式；
-跨平台支持；
-索引时间、磁盘和 watcher 成本；
- generation/cursor 语义；
-失败和离线 fallback；
-与其他 Provider 的 score 校准和去重。

## 3.7 Composite Provider

Composite 不能简单拼接不同 Provider 的 score。

第一版只允许按 capability 路由：

```text
text → rg
files fast → fd 或索引 Provider
glob → fd/filesystem
```

跨 Provider 混合排名、score calibration 和 deduplication 推迟到存在真实需求后再设计。

## 3.8 Search TUI

复用现有 `ToolDefinition.renderCall/renderResult`，不新增第二套 Renderer 生命周期。

###调用摘要

```text
search "AuthService" · text/literal/smart · src/ · *.{ts,tsx}
```

###结果

-按文件分组；
- ranges 高亮；
- context 弱化；
-路径缩写；
- exact/approximate badge；
- partial/complete 状态；
- continuation 提示；
- expanded/collapsed 使用现有状态机制。

Renderer 只消费 `SearchDetails.hits`，禁止解析模型可见文本。

## 3.9 V2.1 明确排除

V2.1 Structured Search 不实现：

- FFF；
- watcher/daemon；
-跨 Provider 混合评分；
-默认全量 global scan；
-通用 rank hook；
- Read/Edit 重构；
-默认 profile 切换。

---

# 四、V2.2：Read Provider 和专用 TUI

V2.2 在 V2.1 稳定后单独实施。

## 4.1 模型接口

```ts
interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
  byteOffset?: number;

  /** 仅在 Provider 返回 nextCursor 时继续稳定快照。 */
  cursor?: string;
}
```

仍只有 `path` 必填。稳定大目录分页需要 cursor；如果不使用 cursor，只保证 best-effort offset pagination，不宣称 snapshot consistency。

## 4.2 Capability 路由

```text
Read Runtime
→ ReadProvider
→ capability detection
→ ExecutionEnv / Node / SSH backend
```

###文本读取

优先级：

```text
1. readTextRange capability
   → bounded line/byte continuation

2. provider-native streaming reader
   →顺序扫描，内存 bounded

3. readTextLines
   →仅可靠覆盖 offset=1，或由 provider 明确实现顺序 skip

4. readBinaryFile fallback
   →先检查严格文件大小上限
```

旧 backend 不支持大文件随机 range 时必须返回明确 capability error，不能为了兼容而无界读取整个文件。

```text
RANGE_READ_UNSUPPORTED
This backend cannot read the requested range without loading an oversized file.
Use a smaller file, start from offset=1, or configure a range-capable provider.
```

## 4.3 1GB 文件验收的准确含义

“读取 1GB 文件中的 100 行”必须同时指定位置和后端：

- Node range-capable backend：峰值内存 bounded；
-靠近文件尾且没有行索引：时间仍可能 O(file size)；
-远程旧 backend：可以明确不支持；
-若要求近似随机行访问，需要独立 line-index capability。

不得用“内存 bounded”暗示“任意 offset 都低延迟”。

## 4.4 目录分页

第一阶段策略：

-小目录：内存排序和 offset page；
-支持稳定 cursor 的 Provider：使用 provider snapshot；
-只对当前 page 补充 size/mtime，避免对全部 entry 执行 stat；
-超阈值且没有 cursor capability：返回 `DIRECTORY_TOO_LARGE`，建议缩小路径；
-不在 V2.2 初版实现 external merge sort。

external sort、temp spool 和 k-way merge 只有在真实百万目录基准证明必要后才进入独立设计。该设计必须包含：

-临时空间配额；
- TTL；
-崩溃清理；
-并发 snapshot；
- branch/session 绑定；
-目录变更检测；
-远程 Provider 语义。

## 4.5 Read TUI

###文本

-语法高亮；
-行号 gutter；
-路径和范围；
-nextOffset/nextByteOffset；
-文档/resource 特殊展示；
-搜索命中跳转。

###目录

- kind；
-仅当前 page 的 size/mtime；
-continuation；
-snapshot/partial 状态。

###图片和资源

-模型不支持图片提示；
-MIME、尺寸和大小；
-可注入 ResourceReader；
-转换器生命周期明确。

---

# 五、V2.3：Shared Mutation Core 和 Edit TUI

## 5.1 内部 canonical 结构

无论模型使用哪种输入 dialect，Runtime 只处理：

```ts
interface EditPlan {
  observations: FileObservation[];
  operations: EditOperation[];
  limits: MutationLimits;
}
```

解析兼容输入属于 argument normalization，不进入 MutationBackend。

## 5.2 不预设 patch 一定优于 operations

候选 dialect：

```text
operations   当前 V2 数组
replacement 原生 path + edits
patch        单字符串 patch DSL
```

一次运行中模型只看到一种 schema，但在改变默认前必须真实 A/B：

-首次 schema 成功率；
-单文件 edit 首次成功率；
-多文件成功率；
-token 数；
- patch parse failure；
-恢复率；
-不同模型族差异。

只有 patch 显著更优时，才把它设为默认 canonical model dialect。

## 5.3 Patch DSL 前置要求

如果实现 patch dialect，必须先冻结 grammar 和版本：

-文件名转义；
-路径包含空格、换行或 `->`；
-无末尾换行；
-空文件；
- rename 后 update；
- add/delete/move 冲突；
- patch marker 出现在文件内容；
-二进制拒绝规则；
- context ambiguity；
-最大文件、hunk、总字节和操作数。

“模型熟悉 patch”只能作为待验证假设。

## 5.4 文件观察与并发修改

每个计划必须记录：

```ts
interface FileObservation {
  path: string;
  identity?: string;
  contentHash: string;
  size: number;
  mtimeMs?: number;
  mode?: number;
}
```

提交前重新观察。文件已变化时返回：

```text
STALE_FILE
The file changed after it was read or planned.
Read it again and create a new edit plan.
No files were changed by this call.
```

不能无条件覆盖外部程序的新内容。

## 5.5 文件保真范围

第一版明确支持：

- UTF-8 和 UTF-8 BOM；
- CRLF/LF；
- regular file；
- mode/executable bit（backend 支持时）；
-精确唯一匹配；
-overlap 检查。

必须明确拒绝或降级：

-未知编码；
-二进制；
- symlink 编辑语义未指定；
-硬链接 identity 保持；
- ACL/xattr；
-跨平台不可表达的 metadata。

“未修改区域原始字节完全不变”需要 byte-aware patch engine，不能由普通字符串重写自动保证。

## 5.6 V2.3 提交语义

V2.3 仍使用当前可检测 partial-commit 模型，但增加：

- observation check；
-统一限制；
-结构化 EditPlan；
-共享 BOM/CRLF/mode 处理；
-专用 diff TUI；
-更精确的 changed/unknown paths。

Journal 不属于 V2.3 默认 backend。

---

# 六、V2.4：实验性 Journaled Mutation

Journal 是独立实验 backend，默认关闭。

## 6.1准确保证

可承诺：

> 在没有未经协调的外部修改、backend 满足声明的 rename/fsync/directory-fsync 能力、rollback 数据完整且磁盘可用时，普通失败和已覆盖的崩溃点可以恢复到旧状态或完成已决定的提交。

不能无条件承诺：

-多文件对外原子可见；
-阻止外部进程修改；
-所有平台具有相同 fsync/rename 保证；
-回滚永不失败；
-仅靠 advisory lock 就能安全覆盖当前状态。

发现外部状态与 journal observation 不一致时必须停止自动恢复并返回：

```text
EDIT_INDETERMINATE
```

## 6.2 Journal 状态机

```text
planned
→ staged
→ originals_secured
→ installing
→ committed
→ cleanup_complete
```

回滚状态：

```text
rollback_started
→ rollback_complete
```

每个状态转换必须持久化并具备 failure-injection 测试。

## 6.3提交前置能力

Backend 必须声明：

```ts
interface MutationCapabilities {
  atomicRenameSameFilesystem: boolean;
  fsyncFile: boolean;
  fsyncDirectory: boolean;
  preserveMode: boolean;
  detectCrossFilesystem: boolean;
  durableJournal: boolean;
}
```

缺少关键能力时不得宣传 durable crash recovery。

## 6.4 外部修改处理

恢复前比较：

- observation hash；
- journal staged hash；
- rollback hash；
-当前目标 hash；
-文件 identity。

只有状态属于已知事务状态时自动继续或回滚。未知新内容不能被覆盖。

## 6.5 Journal 存储与清理

必须定义：

- journal root；
-权限；
- path traversal 防护；
-磁盘字节和事务数配额；
- TTL；
- startup scanner ownership；
-多个 Pi 进程的恢复锁；
-敏感内容处理；
- committed 但未 cleanup 的恢复；
- Windows 和 Unix 平台差异。

## 6.6 跨文件系统移动

跨文件系统只能声明 `recoverable`，不能声明单步 atomic：

```text
copy to destination staging
→ verify hash
→ fsync destination
→ install destination
→ secure/remove source
→ commit
```

任一步失败都必须根据两侧 hash 判断已知状态，不能盲目删除或覆盖。

## 6.7 Overlay

Overlay/copy-on-write/worktree backend 属于更强隔离的可选宿主能力，不是 Journal MVP 的必要依赖。

---

# 七、宿主扩展策略

## 7.1 统一 factory，按工具注入

```ts
interface PiToolsV2Options {
  search?: {
    provider?: SearchProviderV2 | (() => SearchProviderV2);
    renderer?: ToolRendererSlots<SearchInput, SearchDetails>;
  };

  read?: {
    provider?: ReadProviderV2 | (() => ReadProviderV2);
    resourceReaders?: ResourceReader[];
    renderer?: ToolRendererSlots<ReadInput, ReadDetails>;
  };

  edit?: {
    backend?: MutationBackend | (() => MutationBackend);
    dialect?: "operations" | "replacement" | "patch";
    renderer?: ToolRendererSlots<EditInput, EditDetails>;
  };

  run?: RunToolOptions;
  policy?: WorkspacePolicy;
}
```

`ToolRendererSlots` 应映射现有 `ToolDefinition.renderCall/renderResult`，不定义第二套 update 生命周期。

## 7.2 Hook 最小化

优先复用当前 extension `tool_call` 等全局事件。

第一阶段只在明确无法表达时增加：

```text
beforeCommit approval
afterCommit notification
afterRollback notification
```

暂不承诺：

```text
transformSearchRequest
rankSearchHits
resolveResourceReader
beforePlan/afterValidate 全套 Hook
```

新增 Hook 前必须定义：

-调用顺序；
-是否允许修改输入/结果；
-抛错语义；
-timeout/cancel；
-并发和重入；
-事务恢复时是否重新调用；
-审计和安全边界。

## 7.3 Native Operations Adapter

Adapter 按阶段增加，不能承诺旧 Operations 自动拥有新 Provider 的全部能力。

例如旧 `GrepOperations` 如果只提供文件访问，不能凭空提供：

- `rg --json` ranges；
- generation cursor；
-全局 ranking。

Adapter 必须准确声明降级 capability。

---

# 八、错误与恢复协议

## 8.1 正常结果状态

以下不是默认工具错误：

```text
run nonzero
run timeout
search partial
search approximate
read hasMore
```

它们通过 content + details 表达。

## 8.2 工具错误

```text
NOT_FOUND
NOT_A_FILE
NOT_A_DIRECTORY
UNSUPPORTED_BINARY_FILE
RANGE_READ_UNSUPPORTED
DIRECTORY_TOO_LARGE
INVALID_REGEX
STALE_CURSOR
STALE_FILE
STALE_DIRECTORY
OUTSIDE_WORKSPACE
SYMLINK_ESCAPE
PATCH_PARSE_ERROR
PATCH_CONTEXT_NOT_FOUND
PATCH_AMBIGUOUS
EDIT_PLAN_TOO_LARGE
EDIT_ROLLED_BACK
EDIT_INDETERMINATE
SPAWN_FAILED
SHELL_UNAVAILABLE
ABORTED
```

## 8.3结构化恢复动作

```ts
interface V2RecoveryAction {
  kind:
    | "retry_without_cursor"
    | "narrow_scope"
    | "read_again"
    | "split_edit"
    | "inspect_paths"
    | "configure_capability";
  paths?: string[];
}
```

错误文本必须说明下一步，但恢复动作也应进入 details，避免宿主再次解析文本。

---

# 九、兼容与迁移

## 9.1 旧工具映射

|旧工具|V2 路径|
|---|---|
|`grep`|`search(kind="text")`|
|`find`|`search(kind="files" | "glob")`|
|`ls`|`read(directory)`|
|`write`|`edit` create dialect|
|原生 `edit`|EditPlan argument adapter|
|`bash` / `powershell`|`run`|

原生 API 保留为 compatibility profile，直到 V3.0 默认切换门槛全部通过。

## 9.2 不维护两套底层执行逻辑

迁移顺序应是：

```text
1.提取结构化 backend
2. V2 runtime 使用 backend
3.原生 ToolDefinition 改为 backend adapter
4. parity 验证
5.再考虑默认隐藏原生 tool
```

不能先删除原生实现，再同时重写 V2 和兼容层。

## 9.3 旧 ExecutionEnv

新能力保持可选 capability，但降级必须明确：

-支持旧 backend 不等于支持所有新性能保证；
-不支持高效 range 时返回 capability error；
-不支持稳定 cursor 时只提供 best-effort pagination；
-不支持 metadata preservation 时不能启用相应 mutation backend。

---

# 十、实施路线与依赖

```text
Phase 0 Contract Freeze
        │
        ▼
V2.1 Structured Search
        │
        ▼
V2.2 Read Provider
        │
        ▼
V2.3 Shared Mutation Core
        │
        ├──────────────┐
        ▼              ▼
V2.4 Journal       V2.5 Host ABI stabilization
        └──────────────┘
                │
                ▼
             V3.0 default switch
```

## Phase 0：Contract Freeze

必须先确认：

- exact/approximate/partial；
-cursor binding；
-Provider ownership；
-正常状态与错误边界；
-WorkspacePolicy 非 sandbox；
-Renderer 复用现有生命周期；
-Edit dialect 需要评测；
-Journal 条件保证。

## V2.1：Structured Search

交付：

- `rg --json` Provider；
- `fd --print0`/filesystem Provider；
- text/files/glob；
-case/context/fileGlob；
-fast/global 明确语义；
- cursor version/binding；
-结构化 hits；
- Search TUI；
-differential、性能和真实模型测试。

## V2.2：Read Provider

交付：

-capability detection；
-Node bounded range；
-有界旧 backend fallback；
-小目录分页；
-当前 page metadata；
- Read TUI；
- ResourceReader 注入。

external directory sort 另立决策门槛。

## V2.3：Shared Mutation Core

交付：

- EditPlan；
-observation hash；
-BOM/CRLF/mode 能力；
-限制和结构化 diff；
- Edit TUI；
-operations/replacement/patch A/B。

## V2.4：Experimental Journal

交付：

-feature flag；
-state machine；
-failure injection；
-独立进程 crash tests；
-fsync capability matrix；
-外部修改检测；
-配额和恢复扫描；
-Unix/Windows 验证。

## V2.5：Host ABI Stabilization

交付：

-Provider ownership；
-factory/instance lifecycle；
-Native Operations adapters；
-最小 Hook；
-SSH/Memory reference Provider；
-扩展迁移文档。

## V3.0：默认切换

只有所有门槛通过后才把：

```text
search / read / edit / run
```

设为默认，原生工具转 compatibility profile。

---

# 十一、验收标准

## 11.1 V2.1 Search

###正确性

-不再调用原生 tool 后解析最终文本；
-literal/regex 和三种 case 模式覆盖；
-context 和 fileGlob 覆盖；
-files 与 glob 语义分离；
-cursor 与请求和 generation 绑定；
-partial/approximate/global 状态不能混淆；
-与 `rg --json --fixed-strings` differential test；
-与 reference glob implementation differential test；
-路径含空格、冒号、换行、非 ASCII 的 fixture。

###性能

-记录仓库规模、文件数、冷/热启动；
-P50/P95 latency；
-首个结果时间；
-峰值内存；
-cancel latency；
- fast 模式不能为了 global guarantee 默认全量扫描；
-所有性能结论区分 component 与 end-to-end。

### TUI

- ranges 高亮；
- context；
-exact/approximate/partial；
-continuation；
-expanded/collapsed；
-窄终端和 ANSI 宽度测试；
-Renderer 不解析 content 文本。

## 11.2 V2.2 Read

-旧 backend 无需实现新必选接口；
-旧 backend 的降级范围明确；
-Node backend 读取大文件 range 时峰值内存 bounded；
- late offset 的时间复杂度有实测；
-超长单行 byte continuation；
-大目录无 capability 时明确失败，不无界占用内存；
-只 stat 当前 page；
-cursor snapshot 和 best-effort offset 明确区分；
-文本、目录、图片 TUI parity。

## 11.3 V2.3 Edit

-EditPlan 单一内部表示；
-observation 变化导致 STALE_FILE 且零修改；
-BOM/CRLF/mode 在支持 backend 上保留；
-超预算在任何写入前失败；
-专用 diff TUI；
- patch 默认切换必须由真实模型 A/B 支持；
-不宣称多文件严格原子。

## 11.4 V2.4 Journal

-每个持久化状态转换都有 failure injection；
-kill -9/进程崩溃由独立进程测试；
-外部修改不被自动覆盖；
-磁盘满、权限失败、fsync 失败、rename 失败、cleanup 失败覆盖；
-恢复 scanner 多进程互斥；
-平台 capability 不足时不启用 durable guarantee；
-只有 rollback 本身无法确认时返回 EDIT_INDETERMINATE。

## 11.5 Host

- provider ownership 测试；
-reload/close 幂等；
-SSH backend 不改变模型 schema；
-Adapter 准确声明降级能力；
-现有 ToolDefinition Renderer 生命周期保持单一；
-不依赖解析模型可见文本进行 TUI 展示。

---

# 十二、模型评测与默认切换门槛

对比：

```text
A：原生完整工具集
B：当前 V2
C：候选阶段版本
```

指标：

-工具选择正确率；
-首次 schema 成功率；
-每任务调用数；
-search 后正确文件首次读取排名；
- `run` 被误用于搜索/读取/编辑的比例；
-单文件 edit 首次成功率；
-多文件 edit 成功和恢复率；
- approximate 被误当 exact 的比例；
-tool result token；
-最终完成率；
-延迟、CPU、峰值内存和外部进程数。

评测要求：

-固定任务、seed、模型和 thinking；
-默认不调用真实 provider；
-真实模型评测必须显式 opt-in；
-区分 prompt 变化和 runtime 变化；
-记录失败类别而不持久化敏感内容；
-默认切换必须使用 held-out 任务；
-不能只凭功能 parity 切换默认 profile。

---

# 十三、主要风险和停止条件

## Search

如果严格 global ranking 导致明显交互延迟，则保留显式 global 模式，不把它设为默认。

## Read

如果 external directory sort 的真实需求不足以抵消状态和磁盘复杂度，则停止在 Provider cursor 或明确的大目录限制。

## Edit

如果 patch dialect 没有稳定优于 operations/replacement，则不改变默认 schema。

## Journal

如果平台能力或外部修改使自动恢复无法可靠判定，则保持 experimental，不替换当前明确的 partial/indeterminate 协议。

## Host ABI

如果新增 Hook 只能服务假设场景，则不增加；优先 Provider、Renderer 和现有 extension events。

---

# 最终定位

V2 的长期方向仍是：

```text
模型只学习四个稳定动作
宿主保留专业 backend 和完整 UX
运行时提供结构化能力、边界和恢复
```

但“全面超越原生工具”必须按能力逐项证明，而不是由架构图直接推出。

正确实施顺序是：

```text
先冻结合同
→先交付 Structured Search
→再补 Read
→再统一 Mutation
→最后实验 Journal 和默认切换
```

这样既保留四工具极简主义，也避免一次性引入搜索索引、文件系统快照、事务恢复、Hook ABI 和 TUI 重构所带来的不可控复杂度。
