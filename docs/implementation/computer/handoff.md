# Computer delivery handoff

## Local product

Delivery root: `.artifacts/computer/delivery/node24.15.0-darwin-arm64` in the source repository. This is an unpublished, source-snapshot-matched local product; version0.84.2 alone does not identify these bytes. Use `delivery-manifest.json` and `product/computer/manifest.json`, not same-version registry replacements. Node is not bundled.

```sh
./epi --version
./epi --help
./epi --computer --computer-manifest /absolute/path/to/reviewed-capabilities.yaml
# Owned isolated browser profile instead of desktop discovery:
./epi --computer-browser "/absolute/path/Google Chrome for Testing.app" \
  --computer-manifest /absolute/path/to/reviewed-browser-capabilities.yaml
```

Configure the usual model/provider separately. No credentials, proxy values, personal profiles or Chrome binary are included. Runtime needs neither Rust nor a native download/npm lifecycle hook. The shipped `product/computer` comes from qualified assets-v3, not the experimental installed tree containing benchmark/probe helpers. Twelve exact local workspace tarballs and a relative installation shrinkwrap are retained; external dependencies are fixed by their existing lock/integrity records. Running the ready directory does not require reinstalling.

For SDK use, import `createNativeComputerFeature` from the matching installed product, pass its `binding` as the session `computer`, and await feature `close()` at final host shutdown. See the source repository's `native/computer/PACKAGING.md` for packaging inputs and `native/computer/desktop/README.md` for the bridge. Custom SDK hosts must configure their normal provider HTTP routing; CLI routing is not automatically inherited by arbitrary scripts.

## Qualified outcome

- Native discovery, exact selection, semantic plans, owned images, click/scroll and limited keys use the existing Agent loop and shared scheduler; no hidden planner, arbitrary script tool, reconnect or replay fallback.
- Installed Node CLI modes, native child lifecycle, actual AgentSession desktop/browser fixtures and bounded real vision-provider click passed their documented gates.
- P08:30 paired forms, median32.6682s→19.0869s (**41.57% reduction**,95% paired interval41.41–41.76%); requests9→3. Disabled-Computer startup300 pairs passed the5% p95 regression gate. Cancellation/revocation stress:200 refused attempts, zero input. Last GUI receipt: clean C237, not a standing grant for future GUI work.
- Full check/offline build and targeted regressions passed in isolated snapshots. Full `./test.sh` retains the same nine historical failing names; do not describe the repository as all green.

Read [platform support](platform-support.md), [rollback](rollback.md), [benchmark summary](benchmark-summary.md), [P07 packaging](p07-packaging.md) and [P07 qualification](p07-qualification.md) before use. Bun and other platforms are not qualified; 11 of13 keys remain mapping-only. No formal task-p95, universal performance, zero-copy, external-effect rollback or reproducible-build claim.

## Provenance and evidence

The sole task/status authority is `docs/tasks/2026-09-18-computer-native-implementation-task.md`; stage navigation is [progress](progress.md). `.artifacts/computer/p08/delivery-verification.json` records successful repository-external extraction, exact manifest/internal-link verification, CLI/inert/native-load/faux smoke checks, and a separate offline `npm ci --ignore-scripts --omit=dev` with unchanged lock. The npm cache was previously hydrated; no cold-cache offline installation claim is made. The archive is `.artifacts/computer/delivery/node24.15.0-darwin-arm64.tar.gz`, with a sibling `.sha256` file. The ready payload contains14,215 manifest-hashed files; tests do not leave probe scripts in it. Full raw evidence remains under `.artifacts/computer/{p00,p01,p02,p03,p04,p04-browser,p05,p06,p06-trim,p07,p08}` and related incident directories. Do not publish raw desktop/provider evidence without separate review. Failed attempts and old unknown terminal states are retained, not converted into success by later runs.

The source worktree contains unrelated concurrent work. The delivery records its actual build snapshot rather than claiming it came solely from a clean Git revision. Computer-owned source commits must not absorb those unrelated changes. This handoff does not initiate an npm release, push, tag or public publication.
