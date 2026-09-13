# Runtime Refactor Baseline

Date: 2026-09-14

## Repository identity

- Easy-pi source root: `/Users/w/Projects/easy-pi/pi`
- Implementation worktree: `/Users/w/Projects/easy-pi/pi-runtime-p00-p01`
- Starting Easy-pi HEAD: `dba1626064e8fd5339c18d7430355c985e2956e9`
- Starting branch: `my-pi`; implementation branch: `runtime-p00-p01`
- Codex reference root: `/Users/w/Projects/easy-pi/codex` (read-only)
- Codex local HEAD: `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`
- Codex branch: `main`; working tree clean
- Reference SHAs in the plan were not checked out.
- The source worktree was clean at branch creation. The original worktree has pre-existing untracked user files under `docs/runtime-refactor/`; they were not modified by this implementation worktree.

## Environment and isolation

- Host: Darwin 25.5.0 arm64
- Node: `v24.15.0`
- npm: `11.12.1`
- Existing dependencies were copied into this owned worktree; no install, dependency, or lockfile change was made.
- The primary checkout contains ignored generated provider data and built workspace artifacts. Those artifacts were copied into this owned worktree only for isolated offline tests; they are not task changes and will be removed before commit.
- Targeted tests run from their package roots, not through a real provider. No credentials or user HOME were used.

## Actual active call chain

```text
packages/coding-agent/src/main.ts
  -> createAgentSessionRuntime(createRuntime)
  -> createAgentSessionFromServices(...)
  -> packages/coding-agent/src/core/sdk.ts
       -> new Agent(...)
       -> new AgentSession(...)
  -> InteractiveMode | runPrintMode | runRpcMode
  -> AgentSession.prompt()
  -> Agent.prompt()/continue()
  -> runAgentLoop()/runAgentLoopContinue()
  -> streamAssistantResponse()
  -> executeToolCallsSequential()/executeToolCallsParallel()
```

Evidence: `main.ts:828,853,935-971`, `core/sdk.ts:320,402`, `core/agent-session.ts:1402`, `agent.ts` `runPromptMessages/runContinuation`, and `agent-loop.ts:34,67,157,478-580`.

The public replacement owner is `AgentSessionRuntime` (`core/agent-session-runtime.ts`); its replacement paths call `session.dispose()` (`:177,398-404`). The low-level `Agent` owns one `activeRun`, its abort controller, and `waitForIdle()`. `agent_end` is emitted before awaited listeners finish; `AgentSession` subsequently emits `agent_settled` (`agent-session.ts:855-856`). These are distinct lifecycle boundaries and were not renamed.

## Current runtime facts

- A run snapshots `systemPrompt`, messages, and tools in `Agent.createContextSnapshot()`; the loop rebuilds provider context through `transformContext` then `convertToLlm` before each provider call.
- `AgentSession` installs the extension `tool_call`/`tool_result` hooks on the agent (`agent-session.ts:562-604`) and derives active tools from its resource/tool gateway. `agent-loop.ts` validates arguments, awaits `beforeToolCall`, revalidates hook mutations, then dispatches the selected handler.
- Parallel mode performs all preparation sequentially, stores prepared calls, and invokes them through `Promise.all` (`agent-loop.ts:544-580`). Before P01, that invocation had no final signal check.
- Existing cancellation checks already occur during argument preparation and after `beforeToolCall`; an already-started handler receives the same abort signal. The missing window was cancellation after preparation and before `prepared.tool.execute()`.
- Tool-result messages are emitted in assistant source order while `tool_execution_end` can be completion ordered; existing tests cover this compatibility contract.
- `AgentSession.abort()` delegates to the agent abort controller (`agent-session.ts:1827`); `dispose()` also owns background notification teardown. No public API was changed.

## Native child, process, policy, and file coordination classification

- **Active native child path:** `pi-collaboration-root.ts` creates `createPiChildSessionHost()` during `session_start`; the host creates a child `AgentSession` and exposes cooperative `run`, `abort`, and `dispose` (`pi-child-session-host.ts:87,291-309,430-447`). Child requests retain runtime permission callbacks (`toolAllowed`, `getPermissions`) at execution time (`:209,236,269,366`).
- **Active process path:** coding-agent Bash uses the injected agent-core `ExecutionEnv`/`BackgroundTaskManager`; `node-process-executor.ts` owns spawned process handles and cleanup, while `background-task-manager.ts` tracks background/promoted tasks. These are host capabilities, not an OS sandbox.
- **Active file coordination:** coding-agent `withFileMutationQueue()` is used by write/edit tools. It is path-keyed and separate from the P01 agent-loop dispatch gate.
- **Active policy:** `easy-pi.ts` calls `decidePermission()` in full-access mode; `permissions.ts` retains hard-deny checks for protected/catastrophic deletes. Full Access remains the only product mode.
- **Compatibility/retired paths:** `packages/subagent/src/pi-rpc-runtime.ts` and DAG-related files are present and tested for compatibility contracts, but the active root collaboration extension imports the native child host rather than replacing the current AgentSession loop with them. No P01 change touched these paths.

## Baseline test evidence

1. `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts test/agent.test.ts`
   - The focused Agent tests pass offline after the owned worktree received the primary checkout's ignored generated provider data: 2 files, 55 tests passed.
   - Before adding the P01 tests, the existing agent-loop file had 27 passing tests.
2. `cd packages/coding-agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/runtime-tool-cancellation.test.ts test/suite/agent-session-runtime.test.ts test/suite/agent-session-tool-gateway.test.ts test/suite/regressions/6363-agent-settled-event.test.ts`
   - 4 files, 17 tests passed using the repository faux provider, real AgentSession loop, and barrier-controlled preflight after copying only ignored local build artifacts into the owned worktree.
3. Both the low-level loop regression and the real AgentSession/faux-provider regression were run against the pre-fix implementation in the owned worktree and failed with `expected [] but received ["first"]`; after the final check was restored, both passed. This is the causal RED/GREEN evidence for P01.
4. `npm run check` completed formatting, dependency, import, shrinkwrap and install-lock checks, then stopped on two pre-existing model-catalog type errors for `gpt-5.2-codex` in `packages/ai/test/tool-call-id-normalization.test.ts:48,118`. No P01 file appeared in that failure list.

## P00 classification

- `confirmed-gap`: final cancellation check was absent at `executePreparedToolCall()`.
- `already-present`: active native child cancellation/dispose seam, Agent/Session settled distinction, source-order tool-result materialization, Full Access hard-deny call path, file mutation queue, and faux-provider AgentSession harness.
- `baseline-blocker`: repository-wide check reaches TypeScript but stops on two existing stale model-catalog test references; this is outside P01 and was not changed.
- P00 did not change product architecture; only P01 implementation and its focused regression are in this worktree.
