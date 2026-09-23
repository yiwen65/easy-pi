# Optional Computer assets

## Renderer/emergency foundation (host interface 2)

The current bridge requires the genuine `ComputerHost.createWithRenderer(options,
new ComputerRendererConfig.Required(...))` API and lifetime protocol v3. It never
falls back to diagnostic-disabled rendering. Root production pins now select the
qualified General SDK/N-API and matching protocol3 helper. See
[General source provenance](patches/general-desktop.md) and the
[delivery handoff](../../docs/implementation/computer/handoff.md).
Historical P06 packages/materials remain separate; interface-1 assets are refused.

The materials manifest additionally requires:

```json
{
  "computerFeatureVersion": 2,
  "renderer": {
    "helperPath": "renderer/computer-renderer",
    "sha256": "<actual qualified helper SHA-256>",
    "sourcePaths": ["sources/renderer/main.swift"],
    "buildPath": "sources/renderer/build-provenance.json",
    "licensePath": "licenses/renderer.txt",
    "compiler": "<actual Swift compiler version>",
    "lifetimeProtocol": 3,
    "datagramProtocol": 1
  }
}
```

Every listed path must be a regular, non-symlink file in the materials directory,
with its actual SHA-256 in the existing `files` map. `sourcePaths` must include
all authored helper sources and its build script; `buildPath` records the actual
build command, compiler/SDK/target, source hashes and matching output hash.
`licensePath` contains the helper's applicable license/attribution. The existing
`patchSha256`, `librarySha256`, `nodeRuntimeSha256`, `compiler`, source and license
requirements remain in force. No placeholder hash is accepted as qualification.

Packaging copies the executable to `computer/renderer/computer-renderer` with
mode 0755, retains provenance/licenses in `materials/`, lists both in the output
manifest, and embeds the verified helper hash in `bridge.js`. First native work
verifies this fixed relative location before ownership. Missing bytes, changed
bytes, non-executable files and internal helper/directory symlinks refuse.
Canonical ancestor aliases such as `/tmp` → `/private/tmp` are allowed, so moving
the complete installation is supported. Hashes protect against accidental drift,
not a malicious host modifying the bridge or a concurrent privileged file swap.
There are no runtime builds, downloads, helper-path options or model-selected
paths/chords.

`NativeComputerOptions.emergencyChord?: string | readonly string[]` accepts one
trusted app-format chord (for example `super+shift+a`). When omitted,
`createNativeComputerFeature()` resolves `app.computer.emergencyStop` from the
existing user `keybindings.json`; its registered default is `ctrl+alt+escape`.
An empty, multiple, unsupported or modifier-only configuration refuses. Modifiers
map `ctrl`/`alt`/`shift`/`super` to native Control/Option/Shift/Command; Fn is not
supported. Letters/digits, unshifted US punctuation, arrows, navigation keys and
F1–F12 name **physical macOS key positions**, not layout-dependent text. `delete`
maps to forward delete; `backspace` maps to the physical backward-delete key.
The native global listen-only monitor observes the chord while another app is
foreground. Actual installed foreground/keyboard-layout qualification remains a
GUI gate. Configuration is captured for the host lifetime: `/reload` cannot
remap an existing native helper; create an explicitly new feature/host.

Each binding exposes `rendererHealth` (`not_started`, `ready` with `pid/windowId`,
`emergency_stopped`, or `failed` with `code`) separately from tool input/effect
and terminal facts. Optional `subscribeStop(listener)` synchronously supplies
latched emergency/fatal stops, returns an unsubscribe function, and is shared
across forks/renewals. Stops clear delegated view authority, revoke JS access and
abort the original AgentSession loop, including model-only streams and pending
compaction. Existing fulfilled results remain fulfilled; no input is replayed.
Polling starts only after lazy native creation, is unref'ed at 100ms, stops on a
fatal state or feature close, and ends before facade destruction. A status read
or timer is never input-release, terminal, process-reap or main-thread-liveness
proof. Protocol 3 adds actual GUI-main-loop heartbeats at 250 ms; a missing heartbeat for one second revokes the native host with `renderer_heartbeat_timeout`. The timeout does not prove operation drain or child reap. Stopped bindings cannot renew; no reload/restart/lease recovery is added.

The installation layout below is shared with the historical product. General
functional/performance and independent-install evidence is indexed by the task
authority; historical P07 evidence alone does not establish General acceptance.

Computer is opt-in. Its qualified native build targets **Node 24.15.0, macOS arm64**. Other runtimes/platforms are rejected, not redirected to MCP, a CLI, global input or a foreground fallback. Ordinary Node coding does not need these assets.

## Build the asset directory

Use the qualified General SDK (`dist/computer.js`), its runtime packages, protocol3 renderer and corresponding source/license materials. The exact inputs are in `desktop/pinned-inputs.json`; the consolidated source increment is `patches/general-desktop.patch`. Older P04/P06 SDKs are not interchangeable.

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
# Explicit bounded legacy profile, not General segments; never from model output:
epi --computer --computer-manifest /absolute/capabilities.yaml
# Alternative DOM-only profile, with a separately trusted CfT bundle:
epi --computer-browser '/absolute/Google Chrome for Testing.app'
```

General desktop mode discovers/selects existing windows and exposes semantic/image observation, full input segments and explicit two-target drag. General segments require default Full Access without a manifest; bounded manifests retain the narrower legacy operations. Browser mode uses a new isolated profile and typed DOM operations; it is not the desktop/pixel profile. Browser binaries are not bundled. Only the separately qualified CfT build is covered by current evidence.

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
