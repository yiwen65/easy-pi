# General Computer delivery handoff

## Local product

Ready directory: `.artifacts/computer/general-delivery/node24.15.0-darwin-arm64`.
Archive: the same path plus `.tar.gz`, with a sibling `.sha256` file. Final acceptance and exact evidence are recorded in the [task authority](../../tasks/2026-09-18-computer-native-implementation-task.md); do not infer acceptance from a directory's existence.

Node24.15.0 is required and is not bundled. macOS arm64 only; Bun is unsupported.

```sh
./epi --version
./epi --help
./epi --computer
# Disable Computer without removing its files:
./epi --exclude-tools computer
```

Configure the normal provider separately and grant Accessibility/Screen Recording to the actual hosting application. No credentials, browser profiles, Chrome binary, Rust compiler or runtime download is bundled/required. General uses existing apps/profile state and default Full Access. Explicit bounded manifests support the narrower legacy operations, not General segments.

The visible renderer provides task feedback and the default global emergency chord is Ctrl+Alt+Escape (configurable by the host). Foreground work can interrupt the user, but input is not suppressed. A stop latches the feature and releases owned inputs; do not turn a JS timeout into a terminal receipt or revive a stopped binding.

For SDK use, import `createNativeComputerFeature` from this matching product, provide its binding to the existing AgentSession, await `session.shutdown()` and then await `feature.close()` at final shared-host shutdown. A child/session close does not own the whole shared host. See `native/computer/desktop/README.md`, `native/computer/PACKAGING.md` and the SDK ownership documentation.

## Qualified scope

[Workflow qualification](general-workflow-qualification.md) documents existing Chrome Canvas/iframe/Unicode, TextEdit/VS Code, GUI Terminal checksums, Finder rename/menu/doubleclick/scroll/drag, bounded recovery, cursor and stop. Most workflow planning uses faux; C482 separately verifies one real `gpt-6-astra/low` image decision. Real remote-input coexistence is accepted; local hardware is untested/nonblocking.

[Formal General measurements](general-benchmark-results.md):100 equivalent eight-step AX form pairs, median18.8425→4.5582s (75.81% reduction), p9519.0040→4.8026s, three timed faux requests in each arm. General has four additional discover/select preparation requests outside the warm-selected timing boundary. This is not universal GUI/model speed. Observation and disabled-startup gates passed; original failed pilots, interrupted1× cohort and renderer RSS failure remain recorded.

No arbitrary script tool, second Agent loop, recording/replay system, automatic dirty-lease recovery or unknown-input replay is introduced. Some targets cannot be operated safely without foreground access or a fresh observation. See [platform support](platform-support.md) and [rollback](rollback.md).

## Source and artifact integrity

Version0.84.2 alone does not identify these fork bytes. Use `delivery-manifest.json`, `product/computer/manifest.json`, and the archive checksum. Twelve exact workspace tarballs and a relative-path shrinkwrap support reinstallation; never replace them with same-version upstream registry packages. The ready directory needs no install command. Offline reinstall verification uses a previously hydrated cache, not a cold-cache promise.

Final native selection:

- SDK `b7e0ad955c1fcf7808842bc10286fb76ad3fbb6829ea78172fb4c1e6db66217b`
- N-API `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`
- Renderer `1195e23ecdad946a7090f338357e41042ceaa1333daa18203ea7bfc0ee8c2fa3`
- Consolidated General source patch `3ba3ff7a7fef9d8ec1c3b944ea50667a721a4ce19319faa146b6a43d6c1b2d35`, after the documented qualified P06 fast base.

The source snapshot includes contemporaneous unrelated repository work; provenance records actual bytes, not a fictional clean-only build. Raw evidence remains under `.artifacts/computer/general/`; it is not bundled for public release. Repository-wide test failures and their historical comparison are reported by the final audit, not suppressed. Test probes must not be left in the ready payload.

Historical P08 remains unchanged at `.artifacts/computer/delivery/node24.15.0-darwin-arm64.tar.gz`, SHA256 `b2a0012b035a8d1e5e75a475df9f5211dcb70973a5b46fd5265a0d02f96871bb`. It is a narrower, separately matched rollback product, not an interchangeable SDK for General. No npm publication, push or tag is implied by this local delivery.
