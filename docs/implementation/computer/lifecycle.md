# Computer ownership and cancellation boundary

Phase status is recorded only in [the task authority](../../tasks/2026-09-18-computer-native-implementation-task.md). This document describes the host contract; it does not certify a native backend merely because it implements the TypeScript interface.

## Three different lifetimes

1. **Host runtime:** `ComputerHost` lazily invokes one injected runtime factory. Concurrent initialization and failures are cached. The host is retained outside cwd-bound services; a session cannot shut it down.
2. **Session owner:** one `ComputerSession` owns the desktop across tool calls and model decisions. A different session, including a child, receives `desktop_busy`, not an automatic retry or a second queue. Ownership ends only after that session's terminal close. Child handles are independent capabilities, not copies of the parent's live handle.
3. **Execution slot:** the existing shared `ResourceScheduler` takes `desktop:<trusted-id>` exclusively for a tool invocation. Root and children must receive the same scheduler. `ComputerSession.run()` never acquires it again. Releasing this slot does not transfer the persistent owner.

Construction, binding creation and closing unused sessions do not create a native runtime. There is no default native factory, registry entry, fifth tool, permission request or native import in this path. `createComputerSessionBinding()` is explicit SDK host input and rebuilds tool closures for every fork/renewed capability.

## State transitions

| Event | Admission and retained resources |
| --- | --- |
| First admitted run | Reserve the session owner synchronously; register pending work before factory/dispatcher callbacks. Initialize the shared runtime once. |
| Another owner calls | Fail `desktop_busy`; do not queue, replay or reinterpret its request. |
| Ordinary abort | Latch cancellation, notify the native operation, and retain ownership. After terminal settlement the same live session may run again. |
| Session/ancestor revoke | Mark the entire subtree revoked before native callbacks or abort listeners can reenter. No old handle becomes live again. |
| Session close | Revoke immediately, await descendants, operations, late initialization and native session close; only then release that session owner. Do not close the shared runtime. |
| Host close | Gate all sessions synchronously, drain them, then close the runtime once. No initialization of unused infrastructure. |
| Dispatcher throws after possible submission; native cancel/revoke/close fails; terminal rejects | Sticky `desktop_quarantined`. Retain owner, runtime and operation handles; refuse all new work. No timeout, GC, replacement or retry unlocks it. |

A factory that fails before returning an owned native object must clean up its partial creation or retain it in native quarantine. JavaScript cannot infer this from an exception.

## Result is not terminal acknowledgement

The trusted operation interface has separate `result` and `terminal` promises. The result can reject while native work is still running. The host observes that rejection without exposing backend exception text, but does not finish the call until terminal acknowledgement succeeds.

Conversely, terminal rejection is handled independently of the result: quarantine and report the failure even if the result never settles. Waiting for `Promise.allSettled([result, terminal])` before noticing terminal failure would hide a known failure indefinitely. Quarantine retains the operation handle and does not run native close or release ownership.

A fulfilled result keeps its native delivery/effect semantics even if cancellation raced with completion. Driver-owned drain is not rollback, proof of an external application's effect, or proof that an application cannot later change itself. Unknown results are not retried.

## Native requirements

The P02 SDK adapter does **not** satisfy this contract. Its generated AbortError and shutdown settlement can precede escaped AX workers and focus-restoration callbacks. It remains separate and is not a P01 `ComputerBackend`.

The controlled native qualification profile is deliberately narrower than the general SDK: exact-window tree observation and one advertised, enabled background AXPress. No screenshots, pixel/selection/foreground fallback, recording, arbitrary JSON dispatch or P04 bounded plan is implied. The existing general SDK is not removed.

Native session/ancestor gates must be monotonic; operation allocation is inert so cancellation can precede start. A native supervisor, not a foreign future waiter, owns blocking work and cleanup. Every effect-capable worker/callback must be accounted for until it cannot submit more work. Already committed input and necessary focus restoration may finish after a cancellation request; that request is not a terminal acknowledgement.

Public native result/terminal subscribers must not install foreign wakers on channels notified under admission locks. The pinned N-API bridge blocks a Rust wake until its JS callback returns; JS cancellation or re-polling can then wait on those same locks. The controlled SDK instead awaits core proof in a native executor task and exposes its JoinHandle to the foreign future. Only native wakers reach the core channel; monitor completion happens after proof locks are released. Dropping the foreign waiter detaches a monitor, not the independent producer. The paired blocking-wake and dropped-subscriber regressions prove this local boundary without platform calls, not resolution of the original GUI stall.

A cooperating-process lease must be held natively through drain or quarantine. Ordinary `proper-lockfile` heartbeat expiry is unsuitable: a stalled JS loop could lose its lock while native work continues. No timeout-based takeover or automatic stale recovery is allowed. The eventual native implementation and evidence must establish the actual canonical lock namespace, cleanup and unclean-exit behavior; the generic host interface alone cannot do so.

## Lock and recovery rules

Order: existing tool scheduler → host owner admission → lazy native lease/runtime → native session/operation gate → existing native desktop/per-PID coordination → primitive submission. Recheck revocation after waits. Never reacquire the outer scheduler or add a private waiting queue. Bookkeeping locks must not be held across asynchronous waits or reentrant host callbacks.

Session replacement/reload must revoke old authority before asynchronous teardown and create fresh closures only after successful close. Resuming/forking history restores no native owner, operation, window handle or executable observation reference. Native failure or a dirty crash marker requires an explicit recovery decision and fresh observation; history is not a replay log.

## Explicit session integration

Trusted SDK callers pass `computer: ComputerSessionBinding` through `createAgentSession` or its services/runtime factory. The session uses the binding's existing scheduler; its tools remain subject to the ordinary active-tool filters and snapshot dispatch. Omission and suppression do not initialize native resources. Ordinary abort cancels current work without revoking the reusable session.

Accepted replacement, reload and tree navigation revoke before callbacks and drain before renewal. The renewal guard captures the authority generation **before** native revoke/abort listeners can reenter. A later narrowing during callbacks or drain prevents renewal; shutdown's duplicate lifecycle revocation is not another authority decision. For example, a shutdown observer removing Computer must not be overwritten by a previously saved `enabled=true`. Failed drain never renews authority.

The collaboration host reads the root's current binding only when creating a fresh child, then forks independent closures on the same scheduler. Existing children and retained old closures never follow a getter to acquire replacement authority. Controller authority refresh runs synchronously before display observers and shutdown notifications. A child without delegated Computer can still start as an ordinary coding child.

Host-only barriers are in `test/computer/host.test.ts`; real SDK/faux-loop lifecycle and reentrant renewal regressions are in `test/computer/lifecycle.test.ts` under `packages/coding-agent`. These prove host ordering, not native terminal truth, OS permissions, actual fixture behavior or cross-process exclusion. See the task authority for the independent native qualification evidence.
