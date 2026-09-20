# Computer platform support

This is a qualified local Node delivery, not a general release or an OS sandbox.

| Surface | Qualification |
| --- | --- |
| Node 24.15.0 / macOS 26.5.1 (25F80) / arm64 | Qualified on Apple M5; genuine Cua/UniFFI/N-API |
| Other Node/macOS versions, Intel Mac, Linux, Windows | Unqualified; no support claim |
| Bun 1.3.11 | Unsupported. Computer explicitly refuses; ordinary CLI also fails on `node:sqlite`; binary build separately fails resolving `@easy-pi/web-search` |
| TUI, print, JSON, RPC, SDK | Installed-product activation/filter/lifecycle tested with faux provider; GUI tested through actual installed AgentSession, not separately repeated in every mode |
| Discovery / AX | Bounded window metadata, exact selection, complete AX observation, 1–8-step Fill/Press/AssertValue plans |
| Pixel | Owned PNG, current-image single-use click/scroll references, background fixture delivery at qualified scales |
| Keyboard | 13 closed non-text keys implemented; only Tab/Return have actual delivery qualification; other 11 are mapping/compile coverage |
| Browser | Owned blank CfT profile, exact PID/start/window/origin/frame/loader binding, top-level DOM operations; not trusted keyboard events, personal profiles or subframes |
| Vision model | Explicitly opted-in `openai-codex` / `gpt-6-astra`, low; two successful responses and one independently verified fixture click |

## Preconditions and boundaries

Grant Accessibility and Screen Recording to the actual application hosting Node through macOS settings. A different terminal/host may require different grants. Locked desktops, uncertain targets, modal surfaces, stale references and conflicting user input can refuse operations. Metadata discovery is not permission to read or control every window. Full Access remains process authority, not OS isolation.

Use a reviewed capability manifest when authorization must be bounded. Omitting it explicitly selects the unrestricted profile; a supplied empty or missing file must not silently downgrade to unrestricted. Browser executable paths are trusted host inputs, not model parameters. The separately supplied qualified CfT is **153.0.8010.52 mac-arm64**, revision1681091. Its official archive SHA256 is `6f67faa4b34dd551b53abb6fee24edeae470ab695b0b100ddc4885ff0be6724a`; content-manifest SHA256 `81c3f5a8de3998165d7fa0b8142bbb55a46420a01163bc03f48c9aac0084a872`. It is ad-hoc/linker signed, **not vendor signed**. No Chrome binary or personal profile is shipped. `--use-mock-keychain` avoids personal keychain access in the isolated profile.

Driver-owned terminal acknowledgement proves that owned work can no longer submit input; it does not undo or prove completion of external application effects. Unknown outcomes must not be replayed. A dirty lease stays quarantined until separately reviewed administrative recovery; timeout, process disappearance and reboot are not retroactive terminal receipts. See [rollback](rollback.md).

## Evidence limits

See [P07 qualification](p07-qualification.md) and [P08 measurements](benchmark-summary.md). The 41.57% median speedup is a deterministic AX form with faux inference, not a universal desktop/browser/model result or formal task-p95 claim. Full-suite verification retains exactly nine historical failures; the repository is not entirely green. Native buffer experiments show the tested consumer-released buffers were collected, not zero-copy or global leak freedom. No cold-cache, byte-reproducible-build or public-release qualification is claimed.
