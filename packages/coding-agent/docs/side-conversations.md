# Side conversations

`/side` and `/btw` open the same temporary, read-only conversation in interactive mode. The main task keeps running. Each main session owns at most one side conversation.

```text
/btw Why did we choose this implementation?
/side
```

With a question, the command starts answering in the side panel. Without one, it opens the panel without starting inference. Reopening a hidden side keeps its previous questions and answers. Closing it discards that conversation; the next command creates a new one.

The side inherits a snapshot of the parent's request context, including complete recent messages when available. It does not continuously import new parent output. Inherited history is hidden in the panel and is reference context, not an instruction to continue the parent's task. Side questions and answers are not appended to the parent's session or automatically delivered to its model.

## Controls

The panel owns keyboard focus and has its own single-line text input. The original main editor draft is preserved. Shell escapes, slash commands, skills and prompt templates entered in the panel are sent as plain question text.

| Action | Default | Configurable action |
| --- | --- | --- |
| Return to main, retaining the side | Alt+Left | `app.side.hide` |
| Cancel the side answer only | Escape | `app.side.abort` |
| Close the side and wait for cleanup | Ctrl+D | `app.side.close` |
| Follow newest output | End | `app.side.latest` |
| Scroll | PageUp / PageDown | `tui.select.pageUp` / `tui.select.pageDown` |

These actions do not change the main editor's Ctrl+C behavior. Return to a retained side with `/side` or `/btw`. The header shows whether the main task is running, side state, and observed input/cache usage. Image attachments and a multiline composer are not currently supported by the side panel.

## Prompt-cache reuse

The first side request preserves the captured parent's system prompt, ordered tool declarations and message prefix. The side boundary and question are appended afterwards. The side does not add delivery/progress tools or rebuild the system prompt with a smaller tool list.

For Codex Responses, the side inherits the parent's effective `promptCacheKey` and `cacheAffinityId`, including an already-inherited cache lineage. Its native session/request identity stays independent. Cache-affine Codex requests use SSE instead of sharing the parent's WebSocket continuation state.

Strict replay currently supports **OpenAI Responses and Codex Responses with image-free inherited context**. Other APIs, including Anthropic Messages, are explicitly refused rather than silently rebuilding a different wire prefix. Image-bearing prefixes are also refused: the neutral capture precedes image projection, and replaying it could restore a historical image the parent excluded. A future provider/image replay implementation must preserve those transformations before enabling these paths.

A captured request is required. If the parent has not sent a request, send a main-thread message first. Changed model, reasoning effort, service tier, rules, tool declarations, cache routing, branch or compaction can make a snapshot incompatible. The error explains the incompatible state; there is no automatic uncached fallback or paid prewarm request.

A registered `before_provider_request` hook is permitted only when observation of the actual parent request proves its settled result left the JSON payload unchanged. A model-scoped hook that does nothing for the current model therefore does not block replay. The side never reruns parent payload hooks, including as a speculative probe. Changed payloads, hook errors, missing or ambiguous observations, repeated payload callbacks, and replaced/reordered handlers block replay. If observation is still pending, wait for the parent's request to start and retry. Registered `before_provider_headers` hooks remain unsupported.

This observation assumes trusted hooks complete all payload changes before returning or settling their promise. Detached later mutations are unsupported; observation is not a sandbox or a proof that a stateful hook will always be a no-op.

Matching the prefix and cache route makes reuse possible, **not guaranteed**. Cache expiration, provider minimum lengths, account routing and server scheduling still apply. The panel's `cache read` and `cache write` numbers come from provider usage. They are not inferred from a shared key. Offline/mock usage is not evidence of a real server cache hit.

## Tool authority

Inherited declarations are retained for caching; they are not execution grants. The side can execute only standard local `read`, `grep`, `find` and `ls` tools that the parent authorized, optionally through the built-in `codemode` tool when authorized. It cannot execute Bash, writes, edits, MCP operations, discovery, team tools or subagents.

The side rechecks live parent authorization and tool provenance at dispatch, including after asynchronous parent policy hooks and inside nested scripts. A custom same-named tool is not treated as a standard local read capability. Root policy hooks still apply to permitted calls. This is tool-level restriction, not an OS sandbox or isolation from arbitrary trusted extension JavaScript.

## Persistence and cleanup

The side uses a separate in-memory session and settings snapshot, plus an isolated provider registry view. It creates no side session JSONL or team registry. Hiding the panel releases its UI subscription but retains the conversation; finishing an answer also retains it for follow-up.

Explicit close immediately starts an awaited shutdown rather than a delayed idle-unload timer. It seals admission, cancels/drains work, releases session-owned transport/extension resources, deletes only side-owned codemode spill/image files, and drops transcript references. Cleanup failures remain visible and block creating another side over the retained resources.

Main-session shutdown, replacement or reload closes its side. Side cleanup is also registered as a parent-owned shutdown resource, so a failed side cleanup makes the parent session's shutdown report incomplete even when an ordinary extension event handler catches its error.

Closing never deletes files referenced from inherited parent history. These lifecycle guarantees are not secure erasure of provider prompt caches, arbitrary external logs, shared credentials or process memory.
