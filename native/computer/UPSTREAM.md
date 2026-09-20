# Fixed native input provenance

This directory contains TypeScript boundaries and reviewed native patches, not a new FFI framework. Generated bindings come from the actual patched Rust contract; they are not handwritten or manually edited.

## Current optional delivery

`desktop/pinned-inputs.json` selects the qualified P06 Computer-only fast build. Its patch is `a37c8c2998757b4841a07b4fbb460e416b41a01a8be0b8100ec0f3a12a9f740f`, applied after the qualified discovery source, not bare upstream. See [p06-fast.md](patches/p06-fast.md) and [PACKAGING.md](PACKAGING.md). The optional asset manifest records the actual runtime/file hashes, source/license materials and build provenance. Independent Node installation and genuine native loading have been verified. A cold-cache source rebuild or bit-for-bit binary reproducibility is not claimed.

The following P02 records are historical baselines; they do not replace current desktop pins.

| Input | Pin |
| --- | --- |
| Cua repository | https://github.com/trycua/cua |
| Cua commit | `05f29785b508a4441ec3aa06c556a8e8b26c1d71` |
| Source scope | `libs/cua-driver` plus root `LICENSE.md` |
| SDK package | `@trycua/cua-driver` 0.28.2, built from that commit (not installed from npm) |
| Rust / rustfmt | project-local 1.97.1, aarch64-apple-darwin |
| UniFFI generator/runtime | `uniffi-bindgen-react-native`, `@ubjs/core`, `@ubjs/node`, each 0.31.0-3 |
| Compilation host | macOS 26.5.1 arm64, MacOSX26.5 SDK, Swift 6.3.3 |
| JS emission / runtime tested | TypeScript 5.9.3 / Node 24.15.0 arm64, N-API 10 |
| Contract versions | C ABI 1.1.0; UniFFI 30; contract schema 0.8.0 |

## Historical P02 reviewed build inputs

The complete preparation procedure, source manifests, commands, toolchain, logs and fixed independent Cargo closures remain in `.artifacts/computer/p02/`; the accepted static review is `review.md`. In particular, `repro/` retains the environment helper, guard patch and additional generator/runtime Cargo locks. These are local experimental evidence, **not** a distributable installer or a selected production vendor tree. Cold-checkout packaging remains a later gate.

| Lock | SHA-256 |
| --- | --- |
| Cua Cargo.lock | `fe2ece2843bd07ebdcdab67a44b34c89868a4c6e96fd326c80fd3b9aa0ba9a39` |
| Minimal npm package-lock.json | `b5d89b848ab2583ab950d7ad524887eae1e1e043ddf3327f34f8fad7711f48ef` |
| Generator Cargo.lock | `0579226746e900ed10eec6478678a6fd067e531aeffe38a5338024559201e5b1` |
| Copy-mode N-API runtime Cargo.lock | `1cb3cbb2f84d1ea6f5f8e690c8aa56bec42dba4d0319eec4eecd01eef39fe9b6` |

Npm packages were installed with lifecycle scripts and optional packages disabled. The platform package was locally staged, not fetched from npm. The generator CLI guard adds `--locked --offline`; the adapter builder copies the retained runtime lock into its temporary N-API crate and adds those same flags. Cua's upstream copy-mode RustBuffer transformations are preserved. No Electron/Fleet installation, global toolchain replacement, ScreenCaptureKit stubs, or generated-source modification.

After hydrating **all-platform** sources under the unchanged Cua lock (the generator's nested metadata is unfiltered), the verified commands were:

```sh
# From Cua's staged rust directory; reviewed isolated toolchain/environment required.
cargo build --locked --offline --release -p cua-driver-sdk
node ../scripts/generate-uniffi-bindings.mjs --check
node ../scripts/stage-uniffi-library.mjs
cargo run --locked --offline -p cua-driver-bindgen --bin cua-driver-abi-header -- --check

# From its typescript directory; use the existing pi TypeScript compiler/types.
node "$PI/node_modules/typescript/bin/tsc" \
  --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --declaration --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --types node --typeRoots "$PI/node_modules/@types" \
  --rootDir src --outDir dist src/index.ts
```

Do not change target-directory layout: upstream staging expects `rust/target/release`. The retained build guards and independent locks are prerequisites, not optional command-line decoration.

## Historical P02 artifact qualification

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `libcua_driver_sdk.dylib` | 25,123,200 | `cbbc2bf82304282b559f4c1f495ff20f74fbe9bad2286d57a6627e7ecdb7d5f5` |
| `cua_driver_node_runtime.node` | 873,296 | `5f8dff5b6703d99282b498fe5a6c59bb3b3a7d31a3c55fd9ba1157854180fab6` |

Both are arm64 Mach-O. Binary hashes intentionally pin this local build; bit-for-bit reproducibility on another host is not claimed. A changed build requires review and fresh qualification, not bypassing the loader check. Generated API checksums are 16-bit compatibility checks, not cryptographic integrity hashes.

`pinned-inputs.json` additionally pins 81 files: SDK manifest plus emitted root/native JS/declarations (15), core manifest plus ESM tree (61), node manifest plus resolver (2), and platform manifest plus binaries (3). Each group hashes sorted UTF-8 `relative-name + NUL + lowercase-file-SHA256 + LF` records. The loader verifies these bytes before `require`, using the generated native module's resolution context. CJS core is resolved only to locate the package, never executed. No source path points into `.artifacts`; a trusted host supplies the directory.

Use fresh processes, stable trusted input directories and no loader hooks. This is drift detection, not protection against concurrent filesystem modification, a hostile process, preloaded/patched modules or malicious Node resolution hooks.

## Licenses and redistribution

Cua's root `LICENSE.md` is MIT, copyright 2025 Cua AI, Inc. UBJS packages/generator are MPL-2.0. Cua's `scripts/node-runtime-NOTICE.md` documents the adapted copy-mode runtime; preserve that notice, original MPL headers/license and corresponding source obligations if distributing the adapter binary. The optional P07 package includes reviewed Cua source/build materials, the actual modified UBRN copy-mode source, MPL sources/license and dependency notices. Preserve its complete `materials/` directory when redistributing the native assets. Historical experimental outputs are not interchangeable with that qualified package.
