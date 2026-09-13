# Runtime Refactor Test Matrix

Results use `pass`, `fail`, `baseline_fail`, `not_run`, or `not_applicable`; local passes are not cross-platform claims.

| Test ID | Invariant | Test / evidence | Result | Command / log | Platform |
|---|---|---|---|---|---|
| C01 | I01 | Agent loop barrier regression: prepared parallel tools do not start after cancellation | pass | `packages/agent/test/agent-loop.test.ts`; focused Agent suite | Darwin arm64 |
| C02 | I01/I02 | Agent sequential cancellation preserves the started tool signal and does not start later calls | pass | `packages/agent/test/agent-loop.test.ts`; focused Agent suite | Darwin arm64 |
| C03 | I01 | Real `AgentSession`/faux-provider prepared-tool cancellation | pass | `packages/coding-agent/test/suite/runtime-tool-cancellation.test.ts` | Darwin arm64 |
| C04 | I01 | Agent provider preparation cancellation does not call the provider | pass | `packages/agent/test/agent.test.ts`, coding-agent runtime cancellation test | Darwin arm64 |
| C05 | I02/I09 | Existing tool completion event order and source-order result materialization | pass | Agent loop focused suite | Darwin arm64 |
| R01 | I01/I07 | `RunScope` cancellation, generation rejection, and idempotent settlement | pass | `packages/agent/test/run-scope.test.ts` | Darwin arm64 |
| R02 | I03/I04 | ToolPlan schema copy/freeze, duplicate-name final binding, and StepSnapshot binding | pass | `packages/agent/test/tool-plan.test.ts` | Darwin arm64 |
| R03 | I03/I04 | Provider observer receives an isolated context and cannot mutate the request | pass | `packages/agent/test/agent-loop.test.ts` provider-context tests | Darwin arm64 |
| R04 | I01/I08 | Background shutdown waits for process and log-writer settlement | pass | `packages/agent/test/harness/background-task-manager.test.ts` | Darwin arm64 |
| R05 | I08 | Background shutdown reports terminal timed-out tasks and rejects new starts after sealing | pass | Same background manager test file | Darwin arm64 |
| A01 | I01/I05 | Async host admission denial emits an error result and never invokes the handler | pass | `packages/agent/test/execution-admission.test.ts` | Darwin arm64 |
| A02 | I01/I06 | Scheduler queue cancellation and final admission prevent execution | pass | `packages/agent/test/resource-scheduler.test.ts`, execution admission tests | Darwin arm64 |
| Q01 | I06/I09 | Bounded parallel execution and shared/exclusive lease behavior | pass | Resource scheduler and execution admission tests | Darwin arm64 |
| O01 | I07/I12 | Redacted execution events correlate provider/tool outcomes with run, step, and plan IDs | pass | Execution admission observer assertions | Darwin arm64 |
| S01 | I11 | Existing provider/model/cache-affinity characterization suite | pass | Coding-agent targeted runtime/session suite; no provider network | Darwin arm64 |
| CHECK | I12 | Repository type, format, import, shrinkwrap, install-lock, and browser smoke checks | pass | `npm run check` (exit 0; formatter changes reviewed) | Darwin arm64 |
| FOCUSED-AGENT | I12 | Agent runtime focused regression set | pass | 6 files, 66 tests passed | Darwin arm64 |
| FOCUSED-SESSION | I12 | Session/runtime focused regression set | pass | 4 files, 18 tests passed | Darwin arm64 |
| SUITE | I12 | Isolated full `./test.sh` | fail / baseline environment blocker | Two runs completed. Targeted packages pass, but the workspace coding-agent full suite reports 52 unrelated environment/source-fixture failures and cannot be used as a clean P08 gate; full log is in `/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gnf/T/pi-bash-task-21-af007290.log` (path may be cleaned by the host). | Darwin arm64 |

## P02-P08 evidence summary

- P02: the existing `Agent.activeRun` remains the single run owner; `RunScope` supplies identity, generation, cancellation, and settlement.
- P03: each provider step binds one copied/frozen tool plan and one model/context snapshot; dynamic next-turn context replaces the prior plan.
- P04: session replacement awaits `AgentSession.shutdown()`, and background tasks remain tracked until process and output writer settlement or a reported deadline.
- P05: host admission is asynchronous but is followed by a final synchronous effect-admission check immediately before handler invocation.
- P06: scheduler leases are bounded, cancellable while queued, shared/exclusive by key, and released idempotently.
- P07: execution diagnostics omit raw arguments and secrets and now include terminal outcomes for provider requests, admission, scheduler waiting, handler execution, and failures/cancellation.

## Validation gaps and residual risks

- The complete workspace test script is not green in this isolated worktree because the full coding-agent suite depends on unrelated generated/UI fixtures and has existing behavioral failures; the changed runtime's targeted suites are green.
- Tests ran on Darwin arm64 only. Windows process-group behavior, non-cooperating in-process extension code, and real provider transports were not exercised.
- The runtime cannot force-stop arbitrary JavaScript extensions that bypass the supplied abort signal and host execution environment.
