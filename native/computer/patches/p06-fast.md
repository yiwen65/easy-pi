# P06 fast-build candidate

Experimental incremental patch, **not production promotion or a cold-checkout SDK**.

- Apply `p06-fast.patch` **after the qualified P06 discovery source** (`8314efe7…`), not directly after P05 or bare upstream. It includes earlier trimming slices; do not stack those alternatives.
- SHA-256: `a37c8c2998757b4841a07b4fbb460e416b41a01a8be0b8100ec0f3a12a9f740f`.
- 34 source paths: 31 Rust source/manifests and three TypeScript entry/configuration files. No manually authored generated FFI or lockfile changes.
- SDK default features remain empty. Legacy CLI consumers explicitly enable receiver/recording/history; receiver implies legacy transports. Core default features retain legacy facilities. Build the fast SDK alone, not with the CLI in the same Cargo invocation: feature unification can restore legacy implementations.

## Actual compilation boundary

Active fast release Cargo artifacts/depfiles exclude:

- MCP dispatcher/skills/wire, daemon socket client and socket I/O;
- SDK embedded daemon launcher, private worker, service session and outgoing remote/MCP carriers, inbound remote receiver;
- recording/replay/video/FFmpeg/installer/cursor sampler/PiP hooks and independent encrypted history;
- macOS/shared cursor renderer, PiP preview, clipboard implementation and browser TLS dependency.

Shared protocol/result data, session/client metadata, action completion and privacy-bounded classifiers remain real shared implementations. Shared cursor configuration data remain; the whole cursor crate is **not** removed. Inactive cursor presentation keeps the previous uninitialized-channel semantics, not a fake input or terminal success. ScreenCaptureKit still capture, canonical authorization/revocation, owned browser CDP, input guards and tracked cleanup remain.

## Generated entry

Regenerate using the existing `generate-uniffi-bindings.mjs`, check generation, stage N-API and check the C header. Compile `typescript/tsconfig.computer.json` and use `dist/computer.js` (package subpath `./computer`), not the legacy root entry. The Computer entry exports the controlled facade and its real result/configuration types; it does not decorate nonexistent transport constructors. The default generator builds the fast profile. Legacy TS/Electron/Fleet root packaging has not been qualified against this profile and is not a fallback.

## Evidence and limits

Evidence root: `.artifacts/computer/p06-trim/`.

- `transport-hostfixed-inputs.json`: 81 generated/runtime pins and active release depfiles; original P06 inputs unchanged.
- `transport-hostfixed-patch-verification.json`: independent forward/byte/reverse application for all 34 source paths.
- Fast SDK59, core controlled78/authorization45, platform85+1 explicit benchmark ignore; shared observation12, completion1. Legacy CLI and SDK test compilation pass; fake remote20, receiver14 and worker1 pass. These are targeted checks, not a full upstream GUI suite.
- Genuine generation/check/N-API/header/strict Computer TS pass. No-host load verifies actual absence of transport constructors and preserves ArrayBuffer/bigint value factories. It creates no native host, requests no TCC and acquires no desktop lease.
- Host boundary/root-graph types pass; 19 host tests pass with genuine generated values and a fake desktop. Initial host typing caught two missing escalation enums in the curated export list; the failure is retained and the exports corrected without changing native behavior.
- Library: 22,976,672 bytes versus untrimmed 27,257,440 bytes. File size only, **not runtime performance**.

No trimmed-build GUI/browser/capture adjacency, production activation, independent packaging, real-model qualification or P08 performance acceptance is claimed here. Product P04 loaders and the untrimmed P06 desktop loader remain unchanged. C145 is historical untrimmed native evidence, not this candidate's GUI qualification.
