# G01 experimental segment protocol

Protocol and pure validation only. **No general input executor, production pin promotion, or GUI qualification.**

Apply `g01-segment-contract.patch` after the qualified `p06-fast.patch` source described in `p06-fast.md`, not bare upstream. SHA-256: `410fe49e1aa5d24c095a3407dbab8271e467fbfcc1db7a7c017e860c1ea3d5e8`.

The patch changes three authored paths: SDK `computer.rs`, new `computer/segment.rs`, and the curated TypeScript `computer.ts` entry. Regenerate genuine UniFFI bindings, check generation, stage N-API, check the C header and compile `tsconfig.computer.json`. Generated bindings are not handwritten. Locks are unchanged.

## Contract

- Structured addresses and image-relative points; focus, replacement/insertion text, keys/chords/paired holds, pointer/buttons/click/scroll/drag and window actions.
- 1–64 actions, aggregate 16 KiB text, trusted duration at most 30 seconds, bounded coordinates and scheduled drag time. These are protocol limits, not proof that the existing eight-step executor supports them.
- Explicit value/presence/focus/bounds/visual postconditions. Visual confirmation requires fresh model-visible evidence, not event delivery alone.
- Separate dispatch, condition and segment-result types. Each action reuses genuine `ActionResult.route` and `delivery.mode`; no competing route enum. Pure result validation rejects contradictory dispatch/effect/route facts, noncontiguous prefixes, incorrect unfinished indices, recovery counts over two, and native claims of visual business confirmation. Execution/projection still remain to be wired.
- `firstUnfinishedAction` describes delivery, not business success. A directly verified postcondition may already be satisfied without executing unnecessary actions. Cancellation can coexist with a satisfied condition; neither result validation nor a satisfied condition is terminal proof.
- Pure exported `validateComputerSegment` permits genuine FFI codec testing without creating a host. Future execution should invoke the Rust validator directly, not add a separate hot-path FFI call.

Model schema/parser and generated-value encoder are in `native/computer/desktop/segment-{contracts,codec}.ts`. They are not registered in the production tool. The parser rejects lone UTF-16 surrogates to avoid silent UTF-8 replacement and preserves valid Unicode exactly. Runtime target ownership, key mapping, input release after cancellation, routing, confirmation and recovery remain separate obligations.

## Evidence

Evidence root: `.artifacts/computer/general/`.

- `segment-result-inputs.json`: current authored sources, four product files and built-output hashes; qualified previous 636 source hashes and 81 pins unchanged. Prior protocol-only evidence remains in `segment-inputs.json` and `segment-v1-built/`.
- `seal-segment-result.py`: independent patch forward application, byte comparison and reverse application passed. This cumulative patch supersedes the initial protocol patch; do not stack both. The initial empty-context whitespace correction remains documented in `*-context-space.*`.
- Parser: 12/12. Genuine no-host codec/native-validation: 5/5. SDK `controlled_` tests: 70/70, including eleven segment tests.
- Genuine generation/check/staging/header/TypeScript and strict four-file boundary check passed.
- Isolated `p07/g01r`: full check passed (1424 files, no fixes), 204 pass + 5 skip, controller 38, no source drift. This was not a full-suite rerun; earlier full-suite failures remain recorded.
- Failed surrogate regression before the fix, initial lint failure and strict test-typing failure are preserved, not replaced by successful output.

No runtime input, virtual cursor, background/foreground routing, speedup or whole-goal completion is established by this protocol milestone.
