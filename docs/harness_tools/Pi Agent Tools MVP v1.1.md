# Pi Agent Tools MVP v1.1

## 可实施需求合同

- **状态**：已确认
- **范围**：opt-in MVP
- **默认行为**：继续使用 legacy 工具集
- **相关愿景文档**：[Pi Agent Tools v2.md](./Pi%20Agent%20Tools%20v2.md)

本文档是四工具改造 MVP 的规范性合同。愿景文档描述长期方向；两者冲突时，MVP 实施与验收以本文档为准。

---

## 1. 目标

以显式 opt-in profile 向模型提供四个一级工具：

```text
search / read / edit / run
```

四个工具分别表达四种意图：

```text
Discover → Observe → Change → Verify
 search      read      edit      run
```

MVP 的目标不是一次完成最终架构，而是建立：

1. 无歧义、可实现的工具合同；
2. 与现有 Pi 默认行为隔离的试验入口；
3. 可重复的 A/B 评测基线；
4. 后续决定是否默认切换所需的证据。

---

## 2. 非目标

MVP 明确不包含：

- FFF 集成、后台索引、generation 或 barrier；
- typo-resistant fuzzy 文件搜索；
- ObservationStore、revision 或 stale-file detection；
- 跨文件事务、rollback、journal 或 crash atomicity；
- path-aware scheduler；
- 后台或交互式 `process` 工具；
- 默认隐藏或移除 legacy 工具；
- 将 `cwd`、canonical path 检查或 hook 宣称为进程沙箱；
- 对抗性共享文件系统中的强 symlink/TOCTOU 防护。

这些能力只能在后续合同中加入，不能作为 MVP 合并前置条件。

---

## 3. Profile 与兼容合同

### 3.1 Profile

MVP 定义两个原子工具 profile：

```ts
type ToolProfile = "legacy" | "v2";
```

|Profile|模型可见默认工具|
|---|---|
|`legacy`|`read / bash / edit / write`|
|`v2`|`search / read / edit / run`|

“原子 profile”表示 profile 同时决定：

- active tool names；
- 工具 schema 与描述；
-系统提示词中的工具片段和使用规则；
- coding-agent renderer/adapter；
- result 与 error 语义；
- execution mode 与 replay policy。

不能只切换工具名称而继续注入另一 profile 的 schema、提示词或结果解释。

### 3.2 Opt-in 接口

MVP 应提供等价的 CLI 与 SDK 入口：

```bash
pi --tool-profile=v2
```

```ts
createAgentSession({
  toolProfile: "v2",
});
```

具体公开 API 名称可以遵循仓库命名约定调整，但必须满足同一行为合同。

### 3.3 选择规则

MVP 不持久化 profile，也不修改 session schema。每次创建 AgentSession 或 Harness 时独立解析：

```text
本次显式 CLI/SDK 参数
→ legacy
```

- 新会话未显式设置时必须使用 `legacy`。
- resume、fork、clone 和 session switch 未显式设置时同样使用 `legacy`。
- 需要继续 v2 会话时，调用方必须再次显式传入 v2 profile。
- 未知 profile 必须启动失败，不能静默退回 `legacy`。
- profile 持久化及其 branch/fork/migration 语义属于后续能力。

### 3.4 工具注册、过滤与同名覆盖

- profile 首先选择本次调用可用的内置工具集合。
- `legacy` 内置集合包含现有 legacy tools；`v2` 内置集合只包含 `search/read/edit/run`，不包含内置 `bash/write/grep/find/ls`。
- `--tools`、`--exclude-tools`、SDK allowlist 和 custom/extension tools 按现有顺序作用于 profile 选择后的集合。
- “v2 恰好四工具”只适用于没有 allowlist、exclude、custom tool 或 extension tool 改动的基线配置。
- 扩展对同名内置工具的现有覆盖机制保持不变；profile 选择先解析内置定义，再应用现有扩展覆盖规则。
- 最终 active tools 中每个名称只能解析为一个定义，不得同时保留被覆盖定义。

### 3.5 兼容要求

MVP 不修改以下 legacy 行为：

- 默认 active tools；
- legacy 工具公开 factory 和 schema；
- legacy `bash` 的错误行为；
- legacy `edit` 的精确替换行为；
- 现有 `--tools`、`--exclude-tools`、custom tool 和 extension override 规则。

---

## 4. 公共工具原则

### 4.1 顶层必填字段

每个 v2 工具恰好有一个顶层必填字段：

|工具|必填字段|
|---|---|
|`search`|`query`|
|`read`|`path`|
|`edit`|`operations`|
|`run`|`command`|

这只约束顶层输入，不禁止判别联合中的分支必填字段。

### 4.2 模型可见结果

工具成功结果继续使用 Pi 现有分层：

```ts
type ToolResult<TDetails> = {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
};
```

- `content`：给模型的结论、必要数据、截断信息和恢复动作；
- `details`：日志、renderer、评测和程序调用使用的结构化数据。

MVP 不向 `AgentToolResult` 新增 `isError` 字段。工具 `execute()` 正常返回表示成功；throw 表示工具失败。低层 loop 可以继续把 throw 转换为 `isError=true` 的 tool-result message。

### 4.3 稳定顺序

所有没有语义优先级的结果必须使用规范化相对路径的 Unicode code-point 升序作为最终 tie-breaker。路径分隔符统一显示为 `/`。

### 4.4 截断

每个工具必须：

- 使用应用配置的行数、字节数或结果数硬上限；
- 在 `content` 中说明发生了截断；
- 在 `details` 中给出截断原因；
- 给出可用的继续参数、完整输出 artifact，或明确要求缩小查询范围；
- 不把被截断结果表现成完整结果。

默认值沿用 Pi 当前应用配置，MVP 不以修改默认上限为目标。

---

## 5. `search`

### 5.1 Schema

```ts
type SearchInput = {
  query: string;
  kind?: "text" | "files";
  path?: string;
  glob?: string;
  regex?: boolean;
  limit?: number;
};
```

规则：

- `kind` 默认 `"text"`；
- `path` 默认当前 workspace/profile scope；
- `regex` 默认 `false`，仅允许用于 `kind="text"`；
- `glob` 同时适用于 text 和 files search；
- `limit` 必须是正整数且不超过应用硬上限；
- 空 `query` 必须返回输入错误，不能退化为全量枚举；
- MVP 不提供 cursor；结果截断时要求缩小 path/glob/query 或在硬上限内提高 limit。

### 5.2 内容搜索

`kind="text"`：

- 默认按 literal 搜索；
- `query` 中的 `.[]()<>*+?` 等字符没有正则语义；
- 只有 `regex=true` 才启用正则；
- 默认使用 smart-case：query 含大写字符时区分大小写，否则不区分；
- 遵守显式 `path` 和 `glob`；
- 不得因零结果而静默删除约束或改用 fuzzy。

### 5.3 文件路径搜索

`kind="files"`：

- 对 scope 下规范化相对文件路径执行 substring 匹配；
- query 含大写字符时区分大小写，否则不区分；
- MVP 不提供 typo correction 或 approximate suggestions；
- 目录是否作为候选必须由 provider 明确报告；默认只返回文件；
- 不得将 glob DSL 塞入 `query`。

排序顺序固定为：

1. basename 与 query 完全相等；
2. basename 以 query 开头；
3. basename 包含 query；
4. 任一路径 segment 以 query 开头；
5. 完整相对路径包含 query；
6. 规范化相对路径升序。

前五项是互斥的最佳匹配等级；第六项是同级 tie-breaker。

### 5.4 Provider 边界

`packages/agent` 拥有模型 schema、输入校验、结果规范化、稳定排序、截断和错误语义。搜索执行通过隐藏的 provider 注入：

```ts
type SearchRequest = {
  query: string;
  kind: "text" | "files";
  path: string;
  glob?: string;
  regex: boolean;
  caseSensitive: boolean;
  hardLimit: number;
};

type SearchCandidate =
  | { kind: "text"; path: string; line: number; text: string }
  | { kind: "file"; path: string };

type SearchProviderResult = {
  candidates: SearchCandidate[];
  truncated: boolean;
};

interface SearchProvider {
  search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchProviderResult>;

  cleanup(): Promise<void>;
}
```

- application 在调用 provider 前完成 search path policy 校验，并只传入已批准的规范化 scope；
- provider 负责匹配 path/glob/query，并在 `hardLimit` 达到时停止；
- packages/agent 负责验证 candidate、规范化路径、按 §5.3 的公共 comparator 排序、生成 content/details；
- provider 截断可能意味着未返回候选无法参与全局排序，因此截断结果只能作为有界结果，content 必须要求缩小查询，不能声称是全 workspace 的 top N；
- provider 和 packages/agent 共用导出的 files comparator，避免 local provider 与 contract test 排序漂移。

MVP provider 可以复用 coding-agent 已有的 ripgrep/fd 能力，但 provider 品牌不得出现在模型 schema 中。

MVP 不要求 `ExecutionEnv.listDir()` 自行递归整个 workspace，也不要求 packages/agent 内置索引。

### 5.5 输出

文本命中至少显示：

```text
relative/path.ts:42: matched line
```

文件命中每行显示一个规范化相对路径。

`SearchDetails` 至少包含：

```ts
type SearchDetails = {
  kind: "text" | "files";
  query: string;
  path: string;
  returnedCount: number;
  truncated: boolean;
};
```

`returnedCount` 只表示本次返回数量；MVP 不计算被截断查询的总命中数。

---

## 6. `read`

### 6.1 Schema

```ts
type ReadInput = {
  path: string;
  offset?: number;
  limit?: number;
  byteOffset?: number;
};
```

- `offset` 为 1-indexed；默认 1；
- `limit` 必须是正整数；
- 对文本，offset 表示首行；
- 对目录，offset 表示排序后的首个 entry；
- `byteOffset` 仅用于继续读取被字节上限截断的单行，必须使用上一次 read 返回的值；
- `byteOffset` 与非默认 offset、limit 互斥；
- 对图片，offset/limit/byteOffset 非法。

### 6.2 文本读取

文本范围读取不得先调用整文件读取 API。`ExecutionEnv` 必须支持等价能力：

```ts
readTextLines(path, {
  startLine?: number;
  startByte?: number;
  maxLines?: number;
  maxBytes?: number;
  abortSignal?: AbortSignal;
}): Promise<Result<{
  lines: string[];
  startLine: number;
  endLine: number;
  eof: boolean;
  partialLine: boolean;
  nextLine?: number;
  nextByte?: number;
}, FileError>>
```

实现要求：

- 跳过目标范围前的内容时不得将其全部保存在内存；
- 达到 `maxLines` 或 `maxBytes` 后停止读取；
- 超长单行也受 `maxBytes` 限制；
- UTF-8 continuation 必须从有效 code-point boundary 开始，不能返回损坏文本；
- 为判断是否存在下一页，允许最多读取一个额外行或等价 EOF 信息；
- 普通分页输出继续 line offset；单行中途截断输出 `nextByte`；
- 输出必须包含路径、实际行范围和对应继续参数。

MVP 不要求随机 O(1) seek；大 offset 可以线性扫描，但内存占用不得与 offset 成正比。

### 6.3 目录读取

当 `path` 是目录时：

- 调用 `ExecutionEnv.listDir()`；
- entry 按规范化名称升序；
- 至少显示名称和 kind；
- size、mtime 可以放入 details，不要求进入模型 content；
- offset/limit 对排序后的 entry 列表分页；
- symlink 必须显示为 symlink，不能静默当作目标 kind。

### 6.4 图片与其他二进制文件

- 保留当前支持的图片格式和 attachment 行为；
- 图片允许使用完整二进制读取；
- 继续支持注入 image processor；
- 不支持图片输入的模型必须得到明确文本提示；
- 非图片二进制文件返回 `UNSUPPORTED_BINARY_FILE`，不能用 UTF-8 replacement character 静默解码。

### 6.5 Details

```ts
type ReadDetails = {
  path: string;
  kind: "text" | "directory" | "image";
  range?: [number, number];
  hasMore?: boolean;
  nextOffset?: number;
  nextByteOffset?: number;
  truncation?: {
    reason: "bytes" | "lines" | "entries";
  };
};
```

MVP 不包含 revision 字段和 observation side effect。

---

## 7. `edit`

### 7.1 Schema

```ts
type EditInput = {
  operations: EditOperation[];
};

type EditOperation =
  | {
      kind: "create";
      path: string;
      content: string;
    }
  | {
      kind: "update";
      path: string;
      oldText: string;
      newText: string;
    }
  | {
      kind: "move";
      path: string;
      to: string;
    }
  | {
      kind: "delete";
      path: string;
    };
```

- `operations` 至少包含一项；
- MVP 只操作普通文件，不创建、移动或删除目录；
- `oldText` 必须非空；
- 所有 path 都经过相同的 path normalization 和 policy 检查。

### 7.2 批次语义

operations 按数组顺序作用于一个内存中的虚拟文件树：

```text
读取调用开始时状态
→ operation[0] 更新虚拟状态
→ operation[1] 观察 operation[0] 的虚拟结果
→ ...
→ 全部通过后才开始真实 mutation
```

因此允许：

```text
create(a) → update(a)
move(a, b) → update(b)
update(a) → update(a)
```

每个 update 的 `oldText` 必须在该 operation 执行前的虚拟内容中精确且唯一匹配。禁止 Unicode、空白、引号或换行的静默 fuzzy mutation。

### 7.3 操作前置条件

#### Create

- 目标在当前虚拟状态中必须不存在；
- 不覆盖文件、目录或 symlink；
- 可以创建缺失父目录，以兼容现有 write 行为；
- policy 必须验证最近存在祖先和最终目标路径。

#### Update

- 目标必须是普通文件；
- `oldText` 必须精确匹配一次；
- 零匹配返回 `EDIT_CONTEXT_NOT_FOUND`；
- 多匹配返回 `EDIT_CONTEXT_AMBIGUOUS`。

#### Move

- source 必须是普通文件；
- destination 必须不存在；
- 不覆盖 destination；
- 可以创建缺失 destination 父目录；
- provider 静态声明不支持 rename 时，预验证返回 `EDIT_MOVE_NOT_SUPPORTED`；
- 若 provider 支持 rename 但运行时因跨设备等原因失败，该错误属于提交阶段失败，不能假装已在预验证排除。

#### Delete

- 目标必须是普通文件；
- 不递归；
- 不删除目录；
- 不存在时返回 `NOT_FOUND`，不能静默成功。

### 7.4 冲突与 alias

预验证必须检测：

- 相同 canonical existing path 的别名；
- source/destination 冲突；
- 一个 operation 删除了后续 operation 需要的文件；
- path kind 与操作不匹配；
- symlink 路径违反显式 policy；
- schema、权限策略和 provider 能力错误。

对不存在路径，identity 使用“最近存在祖先的 canonical path + 剩余语法规范化 segments”计算。语法规范化只折叠 `.`、`..` 和平台分隔符，不自行猜测 Unicode 或大小写等价。对不存在路径的大小写 alias 检测是 provider 能力；MVP 不把它宣称为跨平台强保证。

### 7.5 预验证边界

规范性承诺：

> 所有能在提交前发现的错误，必须在第一次 mutating `ExecutionEnv` 调用前返回。此类预验证失败不得产生本次调用导致的文件系统修改。

预验证可以调用 read、stat、exists、canonical path 等非 mutation 能力，但不能：

- 写临时文件；
- 创建父目录；
- rename；
- remove；
- 修改搜索索引。

### 7.6 提交边界

全部预验证通过后，按 operations 顺序提交。

MVP 不承诺：

- 提交阶段 I/O 失败时 rollback；
- 普通提交错误下零部分状态；
- 多文件原子性；
- 进程崩溃或断电恢复。

提交阶段失败必须抛出 `EDIT_PARTIAL_COMMIT`，并提供：

```ts
type EditPartialCommitDetails = {
  completedOperationIndexes: number[];
  failedOperationIndex: number;
  pendingOperationIndexes: number[];
  changedPaths: string[];
  createdDirectories: string[];
  unknownPaths: string[];
};
```

- `completedOperationIndexes` 只包含已确认成功的 operation；
- `failedOperationIndex` 是返回错误的当前 operation；
- `pendingOperationIndexes` 只包含失败项之后尚未开始的 operation；
- `unknownPaths` 必须包含失败 operation 的所有端点和状态无法确认的路径；
- `createdDirectories` 报告 create/move 隐式创建的父目录；
- delete 的 source、move 的 source 与 destination 都必须进入 changed 或 unknown 报告。

模型可见错误必须要求：

```text
Read every changed or unknown path before attempting recovery.
Do not blindly replay the original edit.
```

### 7.7 并发

- v2 edit 使用 per-ExecutionEnv mutation coordinator；
- MVP 可以使用全局串行 coordinator，不要求 path-aware 并发；
- move 的 source 和 destination 必须处于同一 coordinator 临界区；
- v2 与 legacy mutation tools 不得在同一 active profile 中混用。

### 7.8 成功输出

成功结果必须向模型显示：

- create/update/move/delete 数量；
- changed paths；
- 精简 diff 或等价摘要。

```ts
type EditDetails = {
  operations: Array<{
    index: number;
    kind: "create" | "update" | "move" | "delete";
    path: string;
    to?: string;
  }>;
  changedPaths: string[];
  patch: string;
};
```

MVP 不包含 revision、generation 或 index synchronization。

---

## 8. `run`

### 8.1 Schema

```ts
type RunInput = {
  command: string;
  cwd?: string;
  timeout?: number;
};
```

- `command` 不得为空；
- `cwd` 默认 `ExecutionEnv.cwd`；
- 相对 cwd 基于 `ExecutionEnv.cwd` 解析；
- cwd 必须存在且是目录；
- `timeout` 单位为秒，必须是有限正数并受实现最大值限制。

### 8.2 结果分类

以下情况正常返回，不 throw：

- exit code 为 0；
- exit code 非零；
- timeout。

以下情况 throw：

- shell 不可用；
- spawn 失败；
- policy 拒绝；
- cwd 无效；
-执行环境故障；
-用户或 Agent abort。

### 8.3 非零退出

命令成功启动并正常退出时，无论 exit code 是否为 0，`execute()` 都正常返回：

```ts
type RunDetails = {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  managedProcessesTerminated: boolean;
  truncation?: TruncationDetails;
  fullOutputPath?: string;
};
```

验收不能检查不存在的 `AgentToolResult.isError`，而应检查：

- `execute()` 不 throw；
- `details.exitCode` 等于实际退出码；
- loop 生成的最终 tool-result message 为 `isError=false`。

### 8.4 Timeout

发生 timeout 时：

- `execute()` 正常返回；
- `timedOut=true`；
- `exitCode=null`，除非 backend 能可靠获得最终 exit code；
- content 保留截至进程终止时已捕获且受截断上限约束的输出；
- 不承诺获得命令尚未 flush 的输出。

执行 backend 必须：

1. 尽力终止其直接 child 和受管 process group/tree；
2. 使用有界 grace period 等待退出；
3. 使用有界 drain 收集剩余输出；
4. 在返回前等待受管 child/group 的终止结果。

MVP 不保证终止已主动 daemonize、脱离受管 process group 或由远程 backend 转交给外部 supervisor 的进程。工具结果必须报告 backend 是否确认受管进程已终止；无法确认时不得表示为强终止保证。

### 8.5 cwd 与安全边界

`cwd` 只设置进程初始工作目录。它不阻止命令：

- `cd` 到其他目录；
- 使用绝对路径；
- 访问网络；
- 读取继承环境变量。

这些限制只能由显式 sandbox、容器、远程 ExecutionEnv 或 application policy 提供。工具描述不得把 cwd validation 宣称为沙箱。

---

## 9. Workspace Policy

### 9.1 接口

```ts
interface WorkspacePolicy {
  roots: string[];
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
  followSymlinks: boolean;
}
```

policy 必须通过工具 context 注入，而不是由模型传入。

### 9.2 默认兼容模式

未注入 restrictive policy 时，MVP 保持现有 Pi 的绝对路径兼容行为。该模式：

- 不是 workspace confinement；
- 不是 sandbox；
- 不保证阻止 workspace 外读写；
- 不得在文档或 UI 中表示为安全隔离。

### 9.3 Restrictive policy

只有显式 policy 才执行 workspace 限制：

- `allowOutsideWorkspaceRead=false` 时，search/read 的 workspace 外读取返回 `OUTSIDE_WORKSPACE`；
- `allowOutsideWorkspaceWrite=false` 时，edit 的 workspace 外写入返回 `OUTSIDE_WORKSPACE`；
- run cwd 按 read policy 判定：`allowOutsideWorkspaceRead=false` 时，workspace 外 cwd 返回 `OUTSIDE_WORKSPACE`；
- 对不存在目标检查最近存在 canonical ancestor；
- search、read、edit 和 run cwd 使用相同路径判定组件。

`followSymlinks=false` 时，只要任一已存在路径组件或最终目标是 symlink，就返回 `SYMLINK_ESCAPE`。

`followSymlinks=true` 时：

- 对已存在目标按 canonical target 重新应用 read/write allow 规则；
- 对不存在目标按最近存在 canonical ancestor 重新应用规则；
- symlink 指向 workspace 外时，仅在对应 `allowOutsideWorkspaceRead/Write=true` 时允许。

run policy 只检查初始 cwd，不限制命令随后访问的路径。基于 pathname 的 `canonicalPath → check → operation` 存在 TOCTOU。MVP 只能将其定义为非对抗环境中的 best effort。强安全边界需要未来 ExecutionEnv 提供 descriptor-relative、no-follow 操作。

---

## 10. 错误合同

### 10.1 MVP 稳定错误码

```text
INVALID_INPUT
NOT_FOUND
NOT_A_FILE
NOT_A_DIRECTORY
UNSUPPORTED_BINARY_FILE
PERMISSION_DENIED
OUTSIDE_WORKSPACE
SYMLINK_ESCAPE
INVALID_REGEX
STALE_CURSOR
SEARCH_PROVIDER_FAILED
EDIT_CONTEXT_NOT_FOUND
EDIT_CONTEXT_AMBIGUOUS
EDIT_CONFLICT
EDIT_MOVE_NOT_SUPPORTED
EDIT_PARTIAL_COMMIT
SPAWN_FAILED
SHELL_UNAVAILABLE
ABORTED
```

`TIMEOUT` 不是 MVP 工具错误码，因为 timeout 是 `run` 的正常可分析结果。

### 10.2 Error 表达

实现应提供可识别的 typed error，例如：

```ts
class ToolExecutionError extends Error {
  code: ToolErrorCode;
  details?: unknown;
}
```

Harness/coding-agent adapter 必须把错误转换为模型可见的：

```text
稳定错误码
具体对象或路径
下一步恢复动作
```

不能只返回 `Error: operation failed`。结构化 details 是否进入最终 tool-result message 必须有集成测试覆盖。

---

## 11. 执行与 Replay

MVP 使用现有保守调度语义：

|工具|executionMode|replay|
|---|---|---|
|`search`|`parallel`|`safe`|
|`read`|`parallel`|`safe`|
|`edit`|`sequential`|`never`|
|`run`|`sequential`|`never`|

现有 low-level loop 在同一 batch 中遇到任一 sequential 工具时，可以将整个 batch 串行执行。MVP 不要求更细粒度调度。

resume 不得自动重放 `edit` 或 `run`。

---

## 12. 包边界

### 12.1 `packages/agent`

拥有唯一执行语义：

- v2 schema 和输入校验；
- SearchProvider 接口、结果规范化和排序；
- bounded text read 和 directory read；
- edit virtual planner、预验证、mutation coordinator 和提交报告；
- run 结果分类和 output capture；
- path/policy 组件；
- typed errors；
- content/details；
- executionMode/replay metadata。

MVP 新增独立 v2 factory，不修改 legacy factory 的公开合同：

```ts
createAgentToolsV2(...)
```

实际命名可按仓库惯例调整。

### 12.2 `packages/coding-agent`

负责：

- profile 选择和本次调用接线；
- Node/local SearchProvider；
- ExecutionEnv 和工具 context binding；
- session 环境变量和 application hooks；
- prompt metadata；
- TUI renderer；
- legacy compatibility。

coding-agent 不应再实现第二套 v2 搜索、读取、编辑或运行语义。

### 12.3 Renderer 限制

renderer 只能消费 tool args、partial result 和 final result。

现有 coding-agent edit preview 会自行读取文件并计算修改。v2 MVP 默认禁用该 preview。若未来恢复 preview，必须调用 packages/agent 导出的纯 planner，不能复制匹配和修改语义。

---

## 13. 系统提示词

v2 profile 使用：

```text
Use search when you do not know the exact location.
Use read when you know a file or directory path.
Use edit for every filesystem change.
Use run only for builds, tests, Git, and programs.
Search results are exact for this MVP; no fuzzy suggestions are provided.
```

legacy profile 保持现有提示词。

提示词必须按 profile 生成，并通过 snapshot test 确保：

- legacy 不引用 `search` 或 `run`；
- v2 不指导模型调用 `bash`、`write`、`grep`、`find` 或 `ls`；
- A/B 评测除 profile 对应工具说明外使用相同基础 prompt。

---

## 14. MVP 验收标准

### 14.1 Profile

- 未设置 profile 时 active tools 与现有 legacy 默认完全一致；
- 无 allowlist、exclude、custom tool 或 extension tool 改动的显式 v2 基线中，模型可见内置工具恰好为 `search/read/edit/run`；
- modifier 和 extension 按 §3.4 作用后，最终 active tools 可以不是四个；
- 每个 v2 工具恰好一个顶层必填字段；
- CLI、SDK 与 resume 使用相同 profile 解析规则；
- resume 未显式传 v2 时回到 legacy，不读取 session 隐式状态；
- 未知 profile 显式失败；
- profile 匹配对应 schema、prompt 和 renderer；
- 最终 active registry 不含重复工具名。

### 14.2 Search

- literal 搜索 `a[b].c` 时按普通字符处理；
- regex 仅在 `regex=true` 时启用；
- files search 只返回同时满足 substring 和 glob 的命中；
- 给定固定未截断候选集时排序完全符合 §5.3；
- 不静默删除 path/glob；
- 截断结果明确要求缩小范围，且不声称是全局 top N。

### 14.3 Read

- text range 不调用整文件文本或二进制读取；
- 大 offset 的内存不随 offset 线性增长；
- 超长单行受字节上限约束，并可通过 nextByteOffset 无损继续；
- 非图片二进制文件返回 `UNSUPPORTED_BINARY_FILE`；
- directory read 可以替代 `ls` 并稳定排序；
- directory offset/limit 可继续；
- image attachment 和 image processor 能力不回退；
- read 不记录 revision。

### 14.4 Edit

- schema 覆盖四种 operation；
- operations 按虚拟状态顺序执行；
- update 只允许唯一 exact match；
- create/move 不覆盖目标；
- delete 不递归且不接受目录；
- schema、冲突、匹配、policy 和 provider capability 等预验证错误发生在首次 mutation 前；
- 所有预验证失败导致的本次调用文件修改数为 0；
- 提交阶段错误返回 `EDIT_PARTIAL_COMMIT` 和完整恢复信息；
- 不宣称 rollback、事务或 atomic；
- 成功结果包含 changed paths 和精简 diff；
- v2 profile 不同时激活 legacy mutation tools。

### 14.5 Run

- exit 0 正常返回；
- exit 1 不 throw，`details.exitCode===1`；
- timeout 不 throw，`details.timedOut===true`，并保留受限输出；
- timeout fixture 中的受管 child/process group 在返回前已终止；
- 已脱离受管 group 的进程不属于 MVP 强保证；
- spawn、shell、policy、invalid cwd 和 abort 与普通命令失败明确区分；
-显式 cwd 被解析、验证并传给 backend；
-工具描述明确 cwd 不是 sandbox；
-大输出继续保存 artifact。

### 14.6 Policy

-未注入 restrictive policy 时保持 legacy 绝对路径兼容；
-显式 policy 分别按 `allowOutsideWorkspaceRead/Write` 判定 search/read/edit 和 run cwd；
-测试用 restrictive policy 将两个 allow flag 都设为 false，并拒绝对应 workspace 外路径；
-不存在目标使用 canonical ancestor 判定；
-`followSymlinks=false` 拒绝任一已有 symlink component；
-`followSymlinks=true` 对 canonical target 重新应用 allow 规则；
-run 命令执行后的路径访问不被 cwd policy 约束；
-测试和文档不把 best-effort pathname 检查宣称为强安全边界。

### 14.7 兼容与回归

- legacy 工具 targeted tests 全部通过；
-现有默认 CLI、SDK 和 extension override 测试不回归；
- content/details 能被 coding-agent renderer 和日志消费；
- resume 不重放 edit/run；
- Linux、macOS 和 Windows 的 path/cwd/rename 差异有对应单元或集成测试。

---

## 15. A/B 评测合同

### 15.1 配置

```text
A：legacy profile
C：v2 profile
```

MVP 不要求同时评测带全部可选旧搜索工具的 B 组。

### 15.2 固定条件

评测 manifest 必须固定：

- task id、输入和成功判据；
- repository commit 或 container digest；
-模型 provider、精确 model id 和推理参数；
- token、时间和工具调用预算；
- A/C 各自预期的 system prompt hash；
- A/C 各自预期的 tool schema/description hash；
-网络策略和环境变量策略；
-每次任务 fresh checkout；
-随机顺序和 seed。

除 profile 对应的工具定义和工具使用说明外，A/C 的基础 prompt 必须相同。

### 15.3 重复与记录

- 每个 task/profile 至少运行 5 次可复现 seed 或等价重复；
- A/C 使用配对随机顺序；
- 保存完整 transcript、tool args、tool results、最终 diff、验证结果、token 和耗时；
- 真实模型评测必须显式 opt-in，不进入默认 CI，也不得记录凭证。

### 15.4 判分

主要指标：

```text
最终任务完成率
```

优先使用自动测试和声明式文件约束。无法自动判定的任务使用不知道 profile 的盲审。

安全硬门槛：

- restrictive policy 下 search/read 的非授权越界读取为 0；
- restrictive policy 下 edit 的非授权越界写入为 0；
- 预验证失败产生的文件修改为 0；
-受控 timeout fixture 中受管 child/process group 的遗留进程为 0。

普通 local run 不受文件系统 containment；只有另行启用 sandbox/container 的评测组才可以要求 run 的越界写为 0。

次要指标：

- 首次 schema 调用成功率；
- 每任务工具调用数；
- search 后首次正确 read 的排名；
- edit 首次预验证通过率；
- run 被用于搜索、读取或编辑的比例；
- tool-result token 数；
-总延迟。

报告每个 task×seed 的 A/C 配对差值。95% 置信区间使用以 task 为 cluster 的 10,000 次 bootstrap，并在评测 manifest 中固定 bootstrap seed。MVP 不预设默认切换门槛；默认切换必须由后续决策合同定义。

---

## 16. 推荐实施切片

### Slice 1：合同与 Profile

- 定义 v2 schemas/details/errors；
- 增加 legacy/v2 profile 解析、本次调用接线和 prompt snapshot；
- v2 可注册但尚不作为默认。

### Slice 2：Search 与 Read

- 注入 local SearchProvider；
- literal/regex text search；
- substring files search 与稳定排序；
-扩展 bounded line read；
- directory read；
-保留 image read。

### Slice 3：Edit

- virtual planner；
-四种文件 operation；
-全量预验证；
- mutation coordinator；
- partial commit reporting；
-精简 diff。

### Slice 4：Run

-显式 cwd；
-非零正常结果；
- timeout 正常结果、受管 child/process group 终止和输出保留；
- typed infrastructure errors。

### Slice 5：coding-agent 接线与评测

- renderer/adapter；
- CLI/SDK/resume；
- legacy regression；
- A/B manifest 和 runner；
- opt-in 文档。

每个 slice 可独立测试。不得为了完成某一 slice 提前引入 §2 的非目标能力。

---

## 17. 完成定义

MVP 只有在以下条件全部满足时完成：

1. §14 所有适用验收项有自动化测试；
2. legacy 默认行为与公开兼容合同不回归；
3. v2 只能通过本次调用显式 opt-in 启用；
4. A/B runner 能在固定任务 manifest 上产生可复现报告；
5. 文档没有将 stale、FFF、事务、强 symlink 安全或默认切换描述成 MVP 已交付能力；
6. 已知限制在用户文档和工具描述中准确可见。
