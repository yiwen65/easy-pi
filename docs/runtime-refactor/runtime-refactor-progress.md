# Runtime Refactor Progress

## Workspace

- Easy-pi root: `/Users/w/Projects/easy-pi/pi`
- Implementation worktree: `/Users/w/Projects/easy-pi/pi-runtime-p00-p01`
- Starting HEAD: `dba1626064e8fd5339c18d7430355c985e2956e9`
- Current HEAD / branch: `46af9a4a4` / `runtime-p00-p01`
- Codex reference root / HEAD: `/Users/w/Projects/easy-pi/codex` / `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`
- Execution scope: P00-P08
- No Codex files, real APIs, credentials, dependencies, lockfiles, push, release, approval UI, OS sandbox, or permission mode changes were used.

## Stages

| Phase | Status | Implementation | Evidence | Commit / diff |
|---|---|---|---|---|
| P00 | passed | Baseline, call-chain, ownership, and characterization documents | Baseline documents and focused pre-change tests recorded | `46af9a4a4` |
| P01 | passed | Final synchronous cancellation check before `tool.execute()` | Low-level and real AgentSession/faux-provider barrier regressions pass; late prepared tools do not start | `46af9a4a4` |
| P02 | passed | `RunScope`, stable run IDs/generations, cancellation-aware provider/tool admission, session lifecycle generation fence | `run-scope.test.ts`, Agent preflight cancellation, coding-agent cancellation tests; active run remains the sole owner | Uncommitted P02-P07 diff |
| P03 | passed | `ToolPlan` and `StepSnapshot`; copied/frozen schemas, stable handler bindings, isolated provider observer context | `tool-plan.test.ts`, provider-context isolation tests, dynamic plan lookup in loop | Uncommitted P02-P07 diff |
| P04 | passed | Awaitable `AgentSession.shutdown()`, background process/output settlement, structured shutdown reports, shutdown admission seal | Background manager lifecycle tests cover process/writer settlement, timed-out reporting, and rejection after shutdown starts | Uncommitted P02-P07 diff |
| P05 | passed | Host-owned asynchronous tool admission followed by final synchronous admission | `execution-admission.test.ts` proves denied calls never invoke handlers; cancellation remains a tool-result outcome | Uncommitted P02-P07 diff |
| P06 | passed | Bounded shared/exclusive `ResourceScheduler` and optional per-tool resource declarations | Scheduler tests cover bounded slots, shared leases, queued cancellation, and Agent parallel-tool bounding | Uncommitted P02-P07 diff |
| P07 | passed | Redacted execution events with run/step/plan correlation, provider/tool/scheduler terminal outcomes | Execution-admission assertions cover denied tool admission and step/plan correlation; provider context remains isolated | Uncommitted P02-P07 diff |
| P08 | in progress | Integration verification, final documentation, and delivery | Targeted Agent suite: 6 files / 66 tests; targeted coding-agent suite: 4 files / 18 tests; `npm run check` passed. Isolated `./test.sh` is running before final commit. | Pending final validation |

## Runtime boundaries delivered

- `Agent` owns one `RunScope` through its existing `activeRun`; cancellation prevents new provider, scheduler, and tool effects while already-started handlers receive and settle with the original signal.
- Each provider request creates a step snapshot. Tool schemas and handler bindings come from the same plan, while current cancellation and host admission remain live checks.
- Session replacement and disposal await `AgentSession.shutdown()`. Background tasks seal new starts, request two-phase termination, wait for process exit and log-writer settlement, and return completed, failed, timed-out, and remaining IDs.
- Execution observers receive only redacted identifiers, phase, outcome, reason, and monotonic duration. Raw arguments, prompts, secrets, and environment values are not emitted.
- Existing `dispose()` and `cleanup()` entry points remain available; synchronous disposal starts the awaitable shutdown without changing their return type.

## Remaining validation

- Complete the isolated repository `./test.sh` run.
- Re-run targeted tests after documentation changes, inspect the final diff/status, then stage only files owned by this task and commit with the normal hook.
- Platform coverage remains local Darwin arm64; no real provider or cross-platform process claim is made.
