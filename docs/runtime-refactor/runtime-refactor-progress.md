# Runtime Refactor Progress

## Workspace

- Easy-pi root: `/Users/w/Projects/easy-pi/pi`
- Implementation worktree: `/Users/w/Projects/easy-pi/pi-runtime-p00-p01`
- Starting HEAD: `dba1626064e8fd5339c18d7430355c985e2956e9`
- Current HEAD / branch: `874481a1d` / `my-pi`
- Codex reference root / HEAD: `/Users/w/Projects/easy-pi/codex` / `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`
- Execution scope: P00-P08
- No Codex files, real APIs, credentials, dependencies, lockfiles, push, release, approval UI, OS sandbox, or permission mode changes were used.

## Stages

| Phase | Status | Implementation | Evidence | Commit / diff |
|---|---|---|---|---|
| P00 | passed | Baseline, call-chain, ownership, and characterization documents | Baseline documents and focused pre-change tests recorded | `46af9a4a4` |
| P01 | passed | Final synchronous cancellation check before `tool.execute()` | Low-level and real AgentSession/faux-provider barrier regressions pass | `46af9a4a4` |
| P02 | passed | `RunScope`, stable run IDs/generations, cancellation-aware provider/tool admission, session lifecycle generation fence | RunScope, Agent preflight cancellation, coding-agent cancellation tests; active run remains the sole owner | `42a1d34ed` |
| P03 | passed | `ToolPlan` and `StepSnapshot`; copied/frozen schemas, stable handler bindings, isolated provider observer context | ToolPlan and provider-context isolation tests pass | `42a1d34ed` |
| P04 | passed | Awaitable `AgentSession.shutdown()`, background process/output settlement, structured shutdown reports, shutdown admission seal | Background manager tests cover process/writer settlement, timed-out reporting, and rejection after shutdown starts | `42a1d34ed` |
| P05 | passed | Host-owned asynchronous tool admission followed by final synchronous admission | Denied calls never invoke handlers; cancellation remains a tool-result outcome | `42a1d34ed` |
| P06 | passed | Bounded shared/exclusive `ResourceScheduler` and optional per-tool resource declarations | Scheduler tests cover bounded slots, shared leases, queued cancellation, and Agent parallel-tool bounding | `42a1d34ed` |
| P07 | passed | Redacted execution events with run/step/plan correlation and provider/tool/scheduler terminal outcomes | Execution observer assertions cover denied admission and step/plan correlation | `42a1d34ed` |
| P08 | partial / blocked | Integration verification and delivery documentation | `npm run check` passed. Full `./test.sh` reached all workspaces but coding-agent retains 51 failures also present on the unchanged `dba162606` baseline; targeted runtime suites pass. | `42a1d34ed`, `874481a1d` |

## Runtime boundaries delivered

- `Agent` owns one `RunScope` through its existing `activeRun`; cancellation prevents new provider, scheduler, and tool effects while already-started handlers receive and settle with the original signal.
- Each provider request creates a step snapshot. Tool schemas and handler bindings come from the same plan, while current cancellation and host admission remain live checks.
- Session replacement and disposal await `AgentSession.shutdown()`. Background tasks seal new starts, request two-phase termination, wait for process exit and log-writer settlement, and return completed, failed, timed-out, and remaining IDs.
- Execution observers receive only redacted identifiers, phase, outcome, reason, and monotonic duration. Raw arguments, prompts, secrets, and environment values are not emitted.
- Existing `dispose()` and `cleanup()` entry points remain available; synchronous disposal starts the awaitable shutdown without changing their return type.
- The concurrent-session characterization now asserts that a steering message queued before cancellation is consumed by the aborted run but cannot trigger a provider request after cancellation.

## Validation evidence

- Agent runtime focused suite: 7 files, 80 tests passed.
- Coding-agent runtime focused suite: 4 files, 18 tests passed; concurrent-session characterization: 7 tests passed.
- Full `./test.sh` on `my-pi`: coding-agent reports 17 failed files / 51 failed tests / 2,253 passed / 56 skipped.
- Full `./test.sh` on unchanged `dba162606`: coding-agent reports 17 failed files / 51 failed tests / 2,251 passed / 56 skipped. The remaining failures are outside the runtime-refactor files and are not introduced by P02-P08.

## Remaining validation and risks

- The repository-wide test command is not green because the pre-existing coding-agent baseline has 51 failures across package-manager/resource-loader/UI/subagent/session-message tests. Fixing those requires a separate scope from the runtime refactor.
- Platform coverage remains local Darwin arm64; no real provider or cross-platform process claim is made.
- The runtime cannot force-stop arbitrary JavaScript extensions that bypass the supplied abort signal and host execution environment.
