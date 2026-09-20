# P07 optional asset packaging evidence

Status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`.
This report covers packaging and non-GUI installation only, not P07/P08 completion.

## Qualified artifact

- Optional directory: `.artifacts/computer/p07/assets-v3/computer`.
- 1,365 manifest-hashed files, genuine P06 fast Computer SDK and fixed N-API/runtime closure.
- Native patch: `a37c8c2998757b4841a07b4fbb460e416b41a01a8be0b8100ec0f3a12a9f740f`.
- Source/license materials: 1,203 files, 262 dependency records; Cua Rust source and support files, contract, build locks/scripts, modified copy-mode UBRN, @ubjs TypeScript, MPL registry source and notices. No cold-cache or byte-reproducible-build claim.
- `native/computer/scripts/package.mjs` creates a new directory only. No native load, network, Rust build or npm hooks occur in packaging.
- `desktop/loader.ts` and pins now select qualified `dist/computer.js`; old P04 loaders remain unchanged.
- The bridge bundles only `native/computer` sources. It externally imports the installed product host/binding and shared packages, preserving class and scheduler identity.

Usage and ownership: [`native/computer/PACKAGING.md`](../../../native/computer/PACKAGING.md).

## Independent Node installation

The already verified `activation-reviewed-check/workspace` completed `npm run build:offline` with exit 0. Twelve current workspace packages were packed using `npm pack --ignore-scripts`, including reviewed materialization of private bundled workspace outputs **inside the snapshot**, not the shared tree.

A new `/private/tmp/epi-computer-install-aa6uaW/product` was extracted outside the monorepo. Its installation lock replaces only workspace registry artifacts with those exact local tarballs and integrities. All 132 external lock entries remain unchanged. `npm ci --ignore-scripts --omit=dev` actually installed 135 packages; it fetched fixed dependencies into the isolated cache, ran no lifecycle scripts, and did not alter the frozen installation lock. This is an installation test, not a claim that dependencies were fetched offline. Installed execution requires no download.

Verified independently:

- All installation symlinks resolve within that installation; no workspace source resolution.
- CLI help/version/model listing succeed without Computer assets, including `--computer --help`/`--list-models`.
- Explicit activation without assets fails clearly.
- With assets, both desktop and browser binding construction/fork/close leave native libraries unloaded.
- Intercepting the installed `ComputerHost.openSession` sees both roots and both children; scheduler `instanceof` checks use the installed shared package.
- Wrong runtime architecture is rejected before native work.
- A separate fresh process loads the genuine SDK/N-API/dylib from the installed directory, without a host constructor, TCC or GUI.
- Ordinary Node coding completes a real AgentSession/faux `read` tool loop with no Computer schema/native load.
- Final v3 file hashes match; its bridge/runtime bytes are identical to v2, with fuller source-support materials. Inert/load/coding checks pass again.

Evidence under `.artifacts/computer/p07/`: `install-preparation.json`, `install-independent-proof.json`, `independent-verification.json`, `assets-v3-verification.json`, command JSON/log/exit files and individual stdout/stderr. Temporary installation paths are evidence locations, not compiled product paths.

## Bun is not qualified

Pinned test-only `@oven/bun-darwin-aarch64@1.3.11` was installed with scripts disabled and its recorded registry integrity checked. This does not change product dependencies.

- Direct optional bridge call correctly refuses Computer with the explicit Node-only error.
- Ordinary CLI and existing `dist/bun/cli.js --help` fail before activation: `No such built-in module: node:sqlite`.
- Separate existing Bun binary build fails resolving `@easy-pi/web-search`.

These are failures, not skips or passing ordinary Bun coverage. No Bun Computer, Bun binary, or other-platform support is claimed. No unrelated storage/package-resolution code was changed. `bun-boundary-verification.json` records each result separately.

## Regressions and retained failures

- Packaging regressions: **8/8**, including existing-output refusal, traversal/symlink/material drift, mismatched native material identity, missing MPL notice and external bundle identity.
- Current trimmed desktop tests: **21/21**, including inert entry; actual AgentSession/faux: **5/5**.
- Actual generated native-boundary and root-graph types: exit 0.
- `packaging-current-check`: full `npm run check` exit 0, **1,419 files/no fixes**, Computer/session **204 passed + 5 existing skips**, controller **38 passed**, source drift 0.

Retained failures: asset v1 bundled TypeBox because TypeScript path mapping defeated generic externalization; an explicit package resolver fixed it without weakening the graph gate. The first independent identity assertion expected two host opens but omitted the two deliberate child opens; the observed source path and corrected four-open assertion pass. The first Bun result collector incorrectly expected the compile failure to match the runtime SQLite failure; raw outputs remain, and the final record distinguishes both. No failed artifact is promoted or overwritten.

GUI, modes/context integration and real-provider image reasoning remain separate T-041 gates. Last accepted GUI evidence at this point is C169; no new native owner, lease recovery or real-provider request occurred during packaging.
