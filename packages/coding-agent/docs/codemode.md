# Codemode

The `codemode` tool runs JavaScript that calls the session's other tools. A script can batch calls, chain their results, and filter large output before returning it to the model. Execution uses a local QuickJS worker, not the host's JavaScript runtime.

This integration does not expose the upstream `models.*` catalog, classifier, or image-generation API. Images returned by tools can still be shown with `image()`.

## Enable codemode

The built-in extension registers `codemode` active, and it is part of the default tool set next to `read`, `bash`, `edit`, and `write`. Turn it off for one run with `--exclude-tools codemode` (or a `--tools` list that omits it), or persistently with a [settings](settings.md#tools) `defaultTools` list without it:

```bash
# The script may read files, but cannot edit, write, or run commands.
epi --tools codemode,read

# Authorize this MCP namespace as well; the server must be configured and enabled.
epi --tools 'codemode,read,mcp__docs__*' --exclude-tools 'mcp__docs__delete_*'
```

Tool names in `--tools` and SDK `tools` are strict grants. **`--tools codemode` grants no target tools.** Discovery, `codemode.mode: "only"`, and MCP auto-activation do not expand this list. Native children need both `codemode` and each target capability in their delegated tool set; current root and ancestor restrictions still apply.

`defaultTools` without `codemode` disables it persistently; a list that omits it never re-enables it at startup:

```json
{
  "defaultTools": ["read", "bash", "edit", "write"],
  "codemode": { "mode": "on", "inlineBudget": 3000 }
}
```

MCP servers default to `deferred` exposure. For direct calls, `tool_search` loads their declarations; authorized codemode scripts can discover them with `searchTools` / `describeTool` and call them without first using `tool_search`. Servers configured with `codemode` exposure use scripts only. The top-level `autoEnableCodemode` option in `mcp.json` controls automatic activation for enabled, authorized servers; it defaults to `true`, but activation still requires authority for `codemode`, and it never grants the server's tools. See [MCP servers](mcp.md#discovery-and-strict-authorization).

Use `noCodemode: true` to omit the built-in registration from the SDK's default loader. Custom SDK resource loaders remain host-owned; add `createCodemodeExtension()` explicitly when needed. See [SDK](sdk.md#codemode).

### Updating a running development session

After updating the core source, restart the Easy Pi process and resume the session. `/reload` reloads resources and extensions, not the already-loaded core modules. An old core can therefore load a newer codemode extension without providing its invocation-scoped tool context. Codemode rejects that mismatch before starting the script or nested calls; retrying or `/reload` cannot repair the old core. SDK hosts must likewise supply the full `ExtensionToolContext`, not an event-handler context.

## Choosing a call path

- Use codemode to batch independent calls, chain deterministic steps, or filter large tool output.
- Prefer a direct tool for one simple call when it is declared. Split execution when the next step needs model judgment rather than encoding an unconfirmed decision in a script.
- Parallelize only independent read-only calls; keep dependent steps and writes ordered. Use `Promise.allSettled()` when successful results should survive known failures.

## Scripts

The script is the body of an async function, so top-level `await` and `return` work. The tool schema accepts `{ code: "...JavaScript source..." }`; models with the supported constrained-sampling format can write raw source instead. Do not put a Markdown code fence inside `code`.

```js
const paths = ["README.md", "package.json"];
const results = await Promise.allSettled(paths.map((path) => tools.read({ path })));
return results.map((result, index) => ({
  path: paths[index],
  result: result.status === "fulfilled" ? result.value : result.reason.message,
}));
```

The VM has no Node APIs, file system, network, modules, or timers. A script reaches the outside world only through authorized tools. Those tools retain their normal host permissions: the QuickJS sandbox is not an OS sandbox for a command run by `tools.bash()` or an MCP server.

A script may start with an options line:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens` defaults to 10000 and accepts a non-negative integer. Output over the budget keeps its start and end; the full text is written to a temporary file whose path appears in the result.
- `timeout_ms` sets a deadline for the whole script, including time spent in tools. It must be a positive integer; there is no default script deadline. Cancellation stops the VM and signals pending host calls, but the session must still account for those calls' actual outcomes.

The result starts with `Script completed` or `Script failed`, the wall time, and output. Multiple text items from `text()` or `return` start with `==> text N/M <==` markers. Console lines follow in one `<console_output>` block. Failures retain partial output and report the error. Calls made before a failure are real and are not undone.

## Globals

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | Call an authorized tool. See [Call tools](#call-tools). |
| `text(value)` | Add text output. Strings are used as is; other values are JSON. |
| `image(value)` | Show a base64 `data:` URL, an `{ image_url }` object containing one, or `{ type: "image", data, mimeType }`. Remote URLs are not fetched. PNG, JPEG, GIF, and WebP are accepted; the result also names a temporary file containing the image. |
| `console.log(...)` | Add a console line; `info`, `warn`, `error`, and `debug` do the same. |
| `return value` | Add the returned value like `text()`. |
| `exit()` | End the script successfully. |
| `store(key, value)` / `load(key)` | Keep small branch-local JSON values. See [Store values](#store-values). |
| `ALL_TOOLS` | The authorized tool catalog captured when the script starts, as `{ name, description }` entries. It is a snapshot, not a grant for later calls. |
| `await searchTools(query, { limit?, namespace? })` | Rank currently authorized tools with BM25; default limit 8, maximum 50. Resolves to `{ name, description }[]`. |
| `await describeTool(name)` | Resolve a tool's description and TypeScript declaration, or `undefined`. |
| `await describeNamespace(name)` | Resolve `{ name, description?, instructions?, tools }` for a namespace, or `undefined`. |

## Call tools

Characters that are not valid in a JavaScript identifier become `_`: `mcp__dev-docs__search` is available as `tools.mcp__dev_docs__search(args)`. `tools["mcp__dev-docs__search"](args)` also accepts the original name. Each method takes one argument object.

The script's `tools` object is created from active `direct` tools and authorized `codemode` or `deferred` tools. `hidden` and `model-only` tools are not callable from scripts; neither is `codemode` itself. Explicitly disabled tools stay disabled. The discovery helpers and execution recheck current grants and exclusions, including live native-child ancestry restrictions. `ALL_TOOLS` is a script-start snapshot: having seen a tool earlier does not authorize a later call after it is revoked. Start another script to obtain methods for newly registered tools.

Nested calls use the normal execution pipeline: parameter preparation and schema validation, `tool_call` hooks and revalidation, host admission, execution-resource scheduling, and `tool_result` hooks. They are not direct calls to an extension's `execute()` method.

What a call resolves to depends on its declaration:

- A tool declaring `outputSchema` returns its `structuredContent` value when provided.
- MCP tools return a `CallToolResult`, including `content`, optional `structuredContent`, and an optional `isError` flag. A server-reported `isError` is a confirmed response, not a lost connection.
- Other tools return their text content as one string. Do not assume an upstream Bash or Read structured-result shape unless the tool's declaration supplies one.

Unknown tools, invalid arguments, blocked calls, and ordinary tool failures reject with the tool's error text. Use `Promise.allSettled()` when independent successful results should survive a known failure.

### Unknown outcomes and recovery

A script catching an exception does not prove that a remote operation failed. For example, an MCP write may reach the server before the connection drops. Its result is **unknown**, even if the script catches the error and returns a value.

Nested dispatch facts are recorded with their parent task before execution. An unresolved dispatched effect cannot be converted to success by `catch`, a script timeout, or a result-presentation hook. Easy Pi retains the task for verification and does not automatically replay the script or independently replay its nested effects. A new direct call or script must not repeat the unresolved operation without establishing its outcome.

Calls still running when the script ends are signalled to cancel. Cancellation is not proof that their effects stopped; the host accounts for their outcomes before completing the parent call. Await calls that matter. Do not use unawaited calls for fire-and-forget writes.

Nested calls produce tool lifecycle events, identified by `parentToolCallId`, but do not add standalone tool-result messages to the provider transcript. Only the parent script's output reaches the model. Durable execution records are separate from the bounded display summaries.

## Tool descriptions and modes

The codemode description groups tools by namespace and includes TypeScript declarations. Listed declarations share `codemode.inlineBudget`, default 3000 estimated tokens (characters divided by four). `deferred` tools are not inlined. Find tools that are not listed with the discovery globals instead of guessing their schemas.

`codemode.mode` changes presentation while `codemode` is active:

- `on` (default): active direct tools remain declared to the model; their descriptions explain how to call them from scripts.
- `only`: active direct tools' declarations are omitted from provider requests and represented in the codemode catalog instead. They remain active and authorized; this mode does not enable inactive tools or grant new capabilities.

Descriptions returned by the discovery helpers include the tools' prompt guidelines. Changing modes or loading a deferred tool does not bypass current grants, exclusions, or hidden exposure.

## Store values

`store(key, value)` stores a JSON value under a string key; `store(key, undefined)` deletes it. `load(key)` returns the value or `undefined`.

Writes are persisted only after a successful, non-cancelled script whose host calls have settled with known outcomes. Script errors, timeouts, cancellation, or unknown nested outcomes discard the writes. Each committed set of writes appends a `codemode-store` custom session entry. Resume and branch navigation read only the entries on the current branch; the store is not shared between independent root and child sessions.

```js
const cursor = load("cursor") ?? 0;
// Use the cursor in authorized tool calls, then save the next one.
store("cursor", cursor + 1);
return { cursor };
```

The store is for IDs, cursors, or small summaries. One value is limited to 262144 characters of JSON; all stored values together are limited to 1048576 characters. Do not store image data; show images with `image()` instead.

## Limits and scope

- Each script has a fresh VM with a 256 MB memory limit. Exhaustion raises `InternalError: out of memory`.
- Helper output and serialized return/error payloads share a 16777216-character hard budget. Helpers and a returned value share 100000 output items. Oversized terminal errors become a bounded limit diagnostic before reaching the host. Use a tool to write larger data to a file.
- A promise that cannot settle and has no pending host call fails immediately; the VM has no timers to make progress.
- Scripts cannot start other codemode scripts.
- The independent `@earendil-works/pi-codemode` package also has portable sandbox APIs. This product integration uses the local worker and does not configure or deploy a remote sandbox.
