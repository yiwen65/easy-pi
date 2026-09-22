# General observation metadata and output filtering

Apply `g02-action-metadata.patch` **after** `g02-general-candidate.patch` (`545fa70b…`). This one-path increment has SHA-256 `b7a534937ecef1d679e7f7773f515efff5f6d9f1184bb780839879c53244222d`. Same upstream MIT notice: `LICENSE.cua.md`. Independent forward/byte/reverse proof: `.artifacts/computer/general/action-metadata-increment-verification.json`.

Finder's readable AXSplitter returned `AXUIElementCopyActionNames=-25200`. Previously that optional metadata failure stopped traversal before the file list. General observations now retain an incomplete-metadata flag and no advertised actions, but continue reading structure. Permission denial and legacy strict scans still fail. This does not make a partial tree complete or authorize an unknown action.

The companion Desktop `observe` request accepts optional `text`: a literal, case-insensitive substring of label, identifier or value, bounded to 256 UTF-8 bytes. Filtering precedes the 8 KiB output budget; excluded rows receive no reference grants. Selector uniqueness is still counted against the entire native result, not the filtered subset. Native completeness and projection truncation remain separate facts.

Evidence:

- Native error regression failed before; Computer 40, surface seven and SDK 80 tests passed after. Genuine generation/check/staging/header/types passed. Existing generated-runtime warnings remain.
- New projection/schema tests failed before, passed after; 20 SDK-backed no-host tool/segment tests passed with zero skips. Full isolated root check: 1446 files, no fixes or source drift; matching two-layer native types passed.
- Independent installed C339: one original AgentSession read 612 UTF-8 bytes from Chrome through Computer, entered/saved them in VSCode, observed/selected the file in Finder, and entered a Terminal checksum command through GUI. Exact source/file/checksum and 41 terminals/two natural exits independently verified in `crossapp-verification.json`.
- Setup opened the dedicated source page, editor file, Finder folder and empty shell. This does not claim autonomous Finder path navigation. The source payload used by the editor came from actual native observation, not an oracle substitution.
- C341/C342/C344 Chrome Unicode single-submit, explicit Finder focused-child rename and drag emergency release/zero model continuation passed; 35 terminals/six natural exits, sealed in `filtered-installed-verification.json`. Earlier unfiltered-discovery harness refusals remain preserved.

Installed candidate: SDK `b1b49c0e34827ddad6f5c140ab12b1065431afe9c810c396f8256df22c543482`, N-API `c407383448f085fe9e5cfbd75d4808f2e163d6e1cef08b636fb9c1308894d9c0`, helper `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc`.

Faux tests are not real-provider evaluation; software HID is not physical-source proof. Production pins and whole-goal acceptance remain unchanged.
