# P07 product qualification

Sole status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`.
Packaging/runtime limits: [p07-packaging.md](p07-packaging.md).

## Actual installed product

All tests used the matching product installed outside the monorepo. No workspace symlink was used to resolve runtime dependencies.

- CLI print and JSON: explicit Computer schema, ordinary faux-provider request, stable schema and shutdown with zero native load.
- RPC: actual stdin JSONL prompt, provider reply, `agent_end`, EOF shutdown and zero native load.
- TUI: dedicated owned tmux session, actual prompt/reply (`COMPUTER_MODE_OK`) and normal Ctrl-D shutdown; no other terminal touched.
- Filters: exclusion and no-tools suppress Computer; explicit allowlist overrides no-tools; default coding omits Computer. Each case ran the real installed CLI.
- SDK GUI: real AgentSession/faux discovery → selection → two screenshots → Tab/Return. Six genuine native terminals, two natural exits, independent image/key oracle; clean **C170**.
- Native child: a forked installed binding ran discovery → selection → capture through its own real AgentSession. Three native terminals, no input, two natural exits; clean **C173**.

Mode tests qualify activation and the ordinary request/lifecycle path. Actual native GUI delivery was tested through the shared SDK AgentSession path, not independently repeated in every display mode.

## Real model image/action loop

Approved provider configuration was read without logging/persisting credentials: `openai-codex`, `gpt-6-astra`, `openai-codex-responses`, image-capable. Selected OAuth credentials and refreshed credentials stayed in memory; the private auth file was not used as a writable test store.

The successful run used **gpt-6-astra / low**, with at most two provider requests, 1,024 output-token limit per request and no provider retry. Local faux bootstrap discovered and selected only the dedicated fixture. A supported context transform removed the complete catalog exchange before real inference, preserving the capture tool-call/result pair and one exact image. The provider-boundary guard verified the PNG hash and absence of catalog text. A fixture-only tool-call guard allowed one click on the current image, not arbitrary actions.

The model selected image pixel **(139, 102)**. The independent fixture observed exactly one matching down/up at canvas **(128.578125, 119.738095)**, inside the red rectangle, without foreground activation or keyboard input. The tool retained its unconfirmed-external-effect semantics; the independent oracle, not the tool, proved fixture success.

- Two successful real requests: `toolUse`, then `stop`.
- Reported total tokens: **10,533**. Usage-derived costs are provider-catalog estimates, not a billing receipt.
- Four native terminals, two natural exits, full native close/destruction; clean **C172**.
- Raw image SHA256: `3c2ec424145711a577cb8b2da855a38a625c3fd91e63dfd795e4cd27cb0cc117`.

Independent proof: `.artifacts/computer/p07/real-image-success-verification.json`.

## Preserved failed attempts and diagnosis

The first real GUI evaluation issued one provider request but returned no accepted click result. Its probe retained only a static assertion category, so the exact original response cause is **not recoverable**. It sent no native input, recorded three native terminals and natural owner1/fixture0 exits, and closed cleanly to C171. No unknown action was replayed.

Two separate one-request, no-GUI diagnostics using the saved fixture screenshot returned transport errors (`ECONNRESET`, then direct connection timeout), with zero reported usage. A no-model paired HEAD probe showed Node's default fetch timing out while the installed product's existing `configureHttpDispatcher` reached HTTP403 through the configured proxy. This established the test host's missing routing setup, not an SDK/native defect or proof of every original failure's unique cause.

The first corrected GUI parent failed **before ready or native construction**: its inherited child launcher stripped proxy variables, and Bash3.2 nounset rejected an empty array. A new isolated parent forwards only reviewed proxy environment names, logs no proxy values, and handles the empty case. Two no-GUI subprocess tests passed. The next fresh fixture, using the existing product HTTP dispatcher and unchanged Computer assets, produced the successful two-request loop above.

Total real-provider attempts in this phase: **5** (three unsuccessful attempts, two successful requests). There was also one pre-ready attempt with **zero** provider requests. All failed raw evidence and old harnesses remain. No lease recovery or runtime/native change was needed.

## Context and regression gates

- Actual AgentSession/faux: **7 tests** across final-context visibility, omission, reload, blockImages, non-vision models, schema stability, paired tool calls/results and actual manual compaction.
- Compaction commits a real replacement checkpoint. The active replacement equals `session.messages`; estimation and provider projection use that view, and the absent image permanently loses authority. No `before_provider_request` image deletion was introduced.
- Native/root graph types: exit0.
- Final isolated `build:offline` and full `npm run check`: exit0; **1,420 files/no fixes**, Computer/session **204 passed + 5 existing skips**, controller **38 passed**, source drift0.
- Full no-key `./test.sh`: exit1, **the same nine failing test names as the saved P03 baseline**, no added/removed failures. These remain outside Computer qualification; the whole repository is not claimed green.

Evidence under `.artifacts/computer/p07/`: `product-modes-verification.json`, `mode-tui-verification.json`, `product-gui-verification.json`, `product-child-verification.json`, `phase-compaction`, `phase-context-loop`, `phase-all-types`, `phase-final-check/test-comparison.json`, and corresponding raw command/log/exit files.

P07 is a qualified narrow Node/macOS delivery. Bun remains unsupported with separately recorded failures. P08 formal paired performance, final support matrix and handoff are separate gates; no performance conclusion follows from these qualification timings.
