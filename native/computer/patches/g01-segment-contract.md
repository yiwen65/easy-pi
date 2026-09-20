# G01 experimental segment protocol

Protocol and pure validation only. **No general input executor, production pin promotion, or GUI qualification.**

Apply `g01-segment-contract.patch` after the qualified `p06-fast.patch` source described in `p06-fast.md`, not bare upstream. SHA-256: `9c9956328566aeef679465f9a2418fc38b5128563abeb3c13e8eb71aecaf4ecf`.

The patch changes three authored paths: SDK `computer.rs`, new `computer/segment.rs`, and the curated TypeScript `computer.ts` entry. Regenerate genuine UniFFI bindings, check generation, stage N-API, check the C header and compile `tsconfig.computer.json`. Generated bindings are not handwritten. Locks are unchanged.

## Contract

- Structured addresses and image-relative points; focus, replacement/insertion text, keys/chords/paired holds, pointer/buttons/click/scroll/drag and window actions.
- 1–64 actions, aggregate 16 KiB text, trusted duration at most 30 seconds, bounded coordinates and scheduled drag time. These are protocol limits, not proof that the existing eight-step executor supports them.
- Explicit value/presence/focus/bounds/visual postconditions. Visual confirmation requires fresh model-visible evidence, not event delivery alone.
- Separate dispatch, condition and segment-result types. Result execution/projection and runtime invariants remain to be wired.
- Pure exported `validateComputerSegment` permits genuine FFI codec testing without creating a host. Future execution should invoke the Rust validator directly, not add a separate hot-path FFI call.

Model schema/parser and generated-value encoder are in `native/computer/desktop/segment-{contracts,codec}.ts`. They are not registered in the production tool. The parser rejects lone UTF-16 surrogates to avoid silent UTF-8 replacement and preserves valid Unicode exactly. Runtime target ownership, key mapping, input release after cancellation, routing, confirmation and recovery remain separate obligations.

## Evidence

Evidence root: `.artifacts/computer/general/`.

- `segment-inputs.json`: authored sources, four product files and built-output hashes; qualified previous 636 source hashes and 81 pins unchanged.
- `seal-segment.py`: independent patch forward application, byte comparison and reverse application passed. An empty context line was normalized for repository whitespace checks; the original patch/hash evidence is preserved as `*-context-space.*`. Native source/output bytes did not change.
- Parser: 12/12. Genuine no-host codec/native-validation: 3/3. SDK `controlled_` tests: 66/66, including seven segment tests.
- Genuine generation/check/staging/header/TypeScript and strict four-file boundary check passed.
- Isolated `p07/g01`: full check passed, 204 pass + 5 skip, controller 38, no source drift. This was not a full-suite rerun; earlier full-suite failures remain recorded.
- Failed surrogate regression before the fix, initial lint failure and strict test-typing failure are preserved, not replaced by successful output.

No runtime input, virtual cursor, background/foreground routing, speedup or whole-goal completion is established by this protocol milestone.
