# General dual-target operation lifetime foundation

Apply `g02-drag-lifetime.patch` after `g02-popup-surfaces.patch` and its predecessors. SHA256: `bcb31c81526c3d1cc522ec818679973e774699d1c08dd3eaf6ca2567b628aee9`.

An inert operation can retain one additional native-window capability. Both endpoints must share the gate/SDK host, have process incarnations and name distinct windows. Attachment is immutable and precedes configuration/start. It does not change either window scope, invent a parent relation, authorize a second target's input or expose a new foreign API.

Core admission, cancellation and terminal settlement check both recursive lifetimes. SDK revoke/close discovers dependent operations from either subtree and waits for genuine terminal before resource/snapshot retirement. SDK attachment shares the operation-registry lock with close's dependency snapshot and strongly retains the destination facade. Matching cleanup remains possible after cancellation; no new primary is admitted.

## Validation

- Original single-session counterexample passed, demonstrating that an **unbound** destination was unrelated to the operation. This is a capability gap, not a fabricated failing old cross-window API. That legacy behavior remains covered.
- Fixed Rust1.97.1, locked/offline release tests: **93 core controlled**, **89 SDK controlled**, zero failures/skips. Eight new core and six new SDK tests cover invalid/repeated/late attachment, revocation between validation and primary, both ancestors, canonical authority loss, unstarted/action gates, tracked cleanup/terminal, strong facade retention, registry ordering, dependent close and quarantine.
- The SDK close test uses retained synthetic work and snapshot callbacks, not actual GUI button release. The registry-ordering test exercises close's gate-revocation phase while attachment is blocked on the registry; it is not a desktop barrier.
- Two SDK test warnings (`snapshot_lifecycle_tests.rs` unreachable else, `abi.rs` unused shutdown) already occur in the popup baseline and remain recorded.
- `general/drag-lifetime-source-verification.json`: exactly eight authored native paths; all other source, lock and generated inputs unchanged; strict patch apply, byte comparison and reverse passed.
- Worker task147 stopped after proxy failures, having produced only baseline/counterexample evidence. Coordinator implemented and ran the final tests; the network failure was not counted as implementation completion.

No public UniFFI ABI changed, so no generation/N-API staging was performed for this foundation. No new binary was promoted or GUI-qualified. Production pins remain historical; the latest installed popup candidate does not contain this increment. T-072 still owns the actual dual-image drag API, canonical authorization, global transport, host view retention and installed qualification.
