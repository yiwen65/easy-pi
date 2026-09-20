# Optional Computer assets

Computer is opt-in. Its qualified native build targets **Node 24.15.0, macOS arm64**. Other runtimes/platforms are rejected, not redirected to MCP, a CLI, global input or a foreground fallback. Ordinary Node coding does not need these assets.

## Build the asset directory

Use the qualified P06 `transport-hostfixed` SDK (`dist/computer.js`), its runtime packages, and corresponding source/license materials. The exact inputs are in `desktop/pinned-inputs.json`. Older P04/P06 SDKs are not interchangeable.

```sh
node native/computer/scripts/package.mjs \
  --sdk "$ABSOLUTE_QUALIFIED_SDK_DIRECTORY" \
  --materials "$ABSOLUTE_SOURCE_MATERIALS_DIRECTORY" \
  --out "$ABSOLUTE_NEW_OUTPUT_DIRECTORY/computer"
```

The packager verifies the pinned SDK/runtime/binaries, material manifest and copied output. It refuses an existing output, unsafe material paths, symlinks, missing notices and mismatched binaries. It does not download, compile Rust, run npm lifecycle scripts, load native code or access the desktop. Workspace development dependencies supply the pinned esbuild.

The result includes:

- `bridge.js`: optional host bridge; no second Agent loop or scheduler implementation;
- `sdk/`: genuine generated Computer bindings, UBRN runtime and fixed native binaries;
- `materials/`: Cua source, modified copy-mode UBRN source, MPL sources/license and dependency notices;
- `manifest.json`: file hashes, build/source provenance and native pins.

The materials input has a `manifest.json` containing `patchSha256`, `librarySha256`, `nodeRuntimeSha256`, `compiler`, and a relative-path-to-SHA256 `files` map. Hashes detect drift; they do not establish trust in arbitrary third-party input or protect against a malicious embedding host. Binary reproducibility and cold-cache source rebuilds are not claimed.

## Placement and activation

Install the **matching built coding-agent product** and its dependencies first. Copy the complete `computer/` directory alongside that package's `dist/` and `package.json`:

```text
<installed coding-agent package>/
  package.json
  dist/
  computer/
    bridge.js
    sdk/
    materials/
    manifest.json
```

The bridge imports the installed product's `dist/core/computer/{host,binding}.js` and existing shared packages. It is not a standalone plugin and must not be relocated away from that product. Do not point production installation at monorepo symlinks. No Rust toolchain or native download is needed at runtime.

```sh
epi --computer
# Explicit trusted manifest; never taken from model output:
epi --computer --computer-manifest /absolute/capabilities.yaml
# Alternative DOM-only profile, with a separately trusted CfT bundle:
epi --computer-browser '/absolute/Google Chrome for Testing.app'
```

Desktop mode discovers/selects windows and exposes semantic observation, bounded plans and image operations. Browser mode uses a new isolated profile and typed DOM operations; it is not the desktop/pixel profile. Browser binaries are not bundled. Only the separately qualified CfT build is covered by current evidence.

`--tools`, `--exclude-tools`, and `--no-tools` retain their existing selection rules; exclusion wins. An explicit allowlist can enable `computer` despite `--no-tools`. Help and model listing do not activate Computer. Missing assets are an explicit activation error; there is no automatic install.

Without a manifest, the native host uses explicitly acknowledged Unrestricted authorization, consistent with Full Access. An invalid/empty manifest option is never silently treated as absent. Native target, permission, cancellation, freshness, modal, hardware-conflict and ownership guards still apply.

SDK ownership:

```js
import { createAgentSession, createNativeComputerFeature } from '@earendil-works/pi-coding-agent';

const computer = createNativeComputerFeature();
let session;
try {
  ({ session } = await createAgentSession({ computer: computer.binding }));
  await session.prompt('Perform the requested task in the authorized test window.');
} finally {
  try {
    await session?.shutdown();
  } finally {
    await computer.close();
  }
}
```

Construction/import and unused close are native-inert. First actual Computer work loads native code. Session/child shutdown revokes only its capability; the embedding owner must also await final feature close. A failed native drain remains quarantined. Never delete the desktop lease, infer terminality from a timeout, or replay unknown input.

## Verification and runtime limits

```sh
node --test native/computer/test/package.test.mjs
PI_COMPUTER_PACKAGE_SDK="$ABSOLUTE_QUALIFIED_SDK_DIRECTORY" \
PI_COMPUTER_PACKAGE_MATERIALS="$ABSOLUTE_SOURCE_MATERIALS_DIRECTORY" \
  node --test native/computer/test/package.test.mjs
node native/computer/desktop/typecheck.mjs "$ABSOLUTE_QUALIFIED_SDK_DIRECTORY"
```

The asset tests are build-time/non-GUI; they do not create a native owner. The independent-install report is in `docs/implementation/computer/p07-packaging.md`. Packaging/load tests do not prove GUI or real-model behavior; consult the sole task authority for those gates.

**Bun is not supported for Computer.** Bun 1.3.11 directly invoking the optional bridge produces the explicit Node-only error. On the tested product snapshot, ordinary Bun CLI startup also fails on the existing `node:sqlite` import, and its separate binary build fails resolving `@easy-pi/web-search`. These failures are retained, not presented as passing ordinary Bun qualification. Node installation and coding-loop checks are separate.
