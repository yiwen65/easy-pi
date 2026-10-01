# Real-model Chrome / Computer benchmark

This opt-in suite runs the configured **real model through AgentSession and the installed `computer` tool**, against an isolated, visible Chrome for Testing. It is not a scripted-model test. Task completion is checked independently of the model's answer. Failed attempts and setup failures remain in the results.

**Business qualification remains partial.** The current browser profile supports single-select controls and the explicitly scoped single HTML dialog; browser-native prompts remain refusal boundaries. Historical results are retained in [RESULTS.md](./RESULTS.md); current installation hashes, qualifications and unresolved failures are tracked in the [task document](../../../../../docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md). Do not interpret an older unsupported result as the current capability contract.

Browser transitions use `{"request":{"op":"click","ref":"observation-ref","target":"element-ref"}}`, followed by observe. Both references must be present in the current model observation. `action_submitted` is not business success. Use observed selectors for batch targets after the first mutation; old element refs cannot rebind. `press.value` is an expected resulting value, not a keyboard key. An unseen `press.expect` returns `postcondition_not_observed`; a later batch ref returns `batch_ref_after_mutation`, both before any input. Refresh and correct the request, rather than replaying a partially completed batch. Desktop pixel-click syntax is unchanged.

## Scope and mainstream benchmark mapping

| Benchmark / mechanism | Implemented here | Qualification boundary |
| --- | --- | --- |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Eight original HTML tasks: click, text, checkboxes, list, tabs, drag, scroll, login | Seed 42; original raw reward; adapted 180-second deadline and full-browser viewport. **Not official aggregate score**. One seed is smoke coverage, not a distribution. |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | Similar observation/action/oracle separation; actual easy-pi tool profiles | Not the BrowserGym action space or official runner. Desktop AX+image and experimental browser DOM profiles are reported separately. |
| [WebArena](https://github.com/web-arena-x/webarena) / VisualWebArena | Local form, record search/navigation, cross-tab reference, scrolling, modal dialog | Mechanism mapping only. Hosted application datasets, resets, full task distribution and official evaluators are **not installed/run**. |
| WorkArena (linked from BrowserGym) | Form/list/navigation mechanisms | No ServiceNow instance/account; no official WorkArena result. |
| [OSWorld](https://github.com/xlang-ai/OSWorld) / [OSWorld-V2](https://github.com/xlang-ai/OSWorld-V2) | Existing adjacent general/save-panel fixtures cover editing, save/reopen, windows, pointer input, cancellation, stale refs | These are local macOS fixtures, not official VM tasks. Official images, task access, cross-app file/workflow evaluators remain separate prerequisites. |

Remaining Chrome qualification categories: back/forward/history, download/upload through native file pickers, clipboard roundtrip, nested frames, trusted keyboard handling, broader dynamic content, native browser prompt handling, tab close/reorder, offline navigation, long-running sessions. Remaining desktop categories: cross-app document workflows, native IME composition, multi-display/scale changes, keyboard/cross-window mid-input cancellation and external focus takeover. Owned single-window mid-drag cancellation is covered by the adjacent general fixture; that does not qualify the other cancellation paths. Never classify an unrun item as passing.

## Run

Prerequisites: supported macOS/Node version, installed qualified native package, existing model credentials, dedicated CfT bundle, local MiniWoB checkout. No credential values are copied or printed. GUI runs must be serial, and the previous owner must have closed cleanly.

```sh
node --test native/computer/desktop/fixtures/real-model/*.test.mjs

PI_REAL_MODEL_EVAL=1 ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/run.mjs \
  /absolute/new-output-directory \
  '/absolute/Google Chrome for Testing.app' \
  /absolute/miniwob-checkout \
  all openai-codex gpt-6-sol semantic desktop
```

The output directory must not already exist. Replace `all` with comma-separated task IDs to run a bounded subset. Strategies: `baseline`, `efficient` (image-first batching), `semantic` (AX-first, fresh returned evidence). Mode `browser` exercises the experimental bounded DOM profile instead; its capabilities are narrower and results must not be pooled with desktop results. Optional trailing arguments are the numeric seed (default `42`) and an absolute candidate `bridge.js` path (default: installed package). This allows candidate qualification without replacing the installation; the contract records its path and hashes. Cross-tab retention is not yet independently qualified in browser mode.

The model-free `background-fill-guard.mjs` accepts absolute output directory,
CfT bundle, compiled `../general/GeneralFixture.swift` binary and bridge paths,
then optional `background` (default) or `foreground`. Run with
`ALLOW_GUI_TESTS=true`. It establishes an owned competing window, observes the
web field, sends one fill, and checks exact DOM/AX values plus an unchanged
competing editor. Foreground mode explicitly activates Chrome first as a causal
control. All input goes through the tool; no fill is replayed. Failed samples
and awaited native/fixture/browser cleanup are retained in `result.json`.

Limits: 24 model turns/task, 180 seconds for model/tool execution, 2048 output tokens/turn, no provider retry. Reported cumulative cost at/above USD 10 prevents starting another request/task; this is **not a prepaid hard spending cap**, because an in-flight response may cross the threshold and provider cost reporting can be incomplete. Setup and cleanup are separately timed. Cancellation waits for native drain, not a fabricated timeout success. Run processes serially; cost limits do not aggregate automatically across separate invocations.

The desktop fixture uses an empty profile, `--use-mock-keychain`, disabled sync/extensions/background networking, loopback-only task server and CDP. The model only receives `computer`, no shell/filesystem/network/evaluator tool. CDP is used by trusted harness setup, independent result checks and graceful close, never to perform task actions. Browser mode uses the native-owned isolated profile lifecycle. Profiles and failed evidence are retained for diagnosis, not force-deleted.

## Evidence and acceptance

`chrome-dynamic` processes three records in one browser session. Each save
removes the form, briefly shows a loading state, and creates new controls with
the same labels. Notes contain the distinct record ID; the independent oracle
requires all three exact records in order. This tests dynamic replacement and
fresh observations, not long-duration stability or an official benchmark score.

`contract.json` records model, strategy, tool profile, seed, native/bridge/probe/fixture hashes, MiniWoB commit and limits; `sources/` freezes the harness version. Each attempt retains tool calls, assistant actions (not hidden reasoning), usage, screenshots, independent oracle, timing, cleanup proof and failure. `summary.json` retains **all** attempts and reported costs. `node native/computer/desktop/fixtures/real-model/report.mjs /absolute/output` summarizes durations and refusal codes without dropping failures.

Failed desktop attempts also record a read-only `pageState` after native input
has drained and before Chrome closes: document readiness, visibility/focus,
body bounds and at most 4096 characters of visible text. The exact loopback
fixture origin is checked before reading content. Foreign origins or failed
inspection remain explicit unknowns. This diagnostic is never sent to the model,
used to pass the task, or used to replay input. `diagnosticMs` is included in
cleanup time, not task/model/tool time. Local request-budget exhaustion is
classified as `model_budget_exhausted`, not a provider outage; limits are unchanged.

Business success requires the exact independent result, real model and tool calls, and clean native/Chrome closure. A correctly refused stale reference is protection success, **not task success**. Model narration or `inputCommitted` is never the task oracle. Report setup/failed/interrupted attempts separately but keep them in the denominator. P50/P95 of successful tasks exclude failed durations explicitly; small-N P95 is not a reliability claim.

For an optimization: freeze dataset/seed/model/native version, preserve the same oracle, alternate A/B order for repeated pairs, retain every failure and count calls/bytes/model time/tool time. Do not promote prompt changes based on one faster failed run, or pool distinct task families into a claimed speedup. A changed stale-image policy also needs negative controls for moved/replaced targets, overlays and unrelated windows; any weaker semantic guarantee must be explicitly accepted.

## Initial observed failures (2026-09-24)

Real `openai-codex/gpt-6-sol`, low reasoning, Chrome 153.0.8010.52; MiniWoB commit `33c3b4ddef8c6eb67c57a29663d844b1eda7e614`; installed native SHA256 `8b01d174bff81dc49101b3a85e692fbc8b4ceb7fbdf13c237e5411ad3d98d75a`.

Initial image-first Chrome run: navigation passed; form, cross-tab, scroll and dialog failed (1/5). All five closed cleanly. Task times were respectively 89.9, 128.6, 54.1, 69.6 and 61.0 seconds; these different tasks are not speed comparisons. Official MiniWoB click smoke timed out at 180 seconds after repeated `stale_image_observation`, despite correctly located target coordinates. Experimental browser profile failed `prepare` with `native_fault` (16.0 seconds, two model turns); no fallback/retry was hidden.

The native image-reference implementation compares the SHA256 of the entire PNG as well as window identity and geometry. A changing countdown elsewhere on the page can therefore invalidate the click. Other traces show `foreground_focus_unproved`, synthetic input delivered without a confirmed field value, and reuse of pre-mutation image refs inside a segment. These are separate failure classes, not proof that all checks should be removed. Target-region validation has been proposed but is not enabled pending explicit agreement on the weaker whole-window guarantee.

Harness bring-up failures are also retained: a document-readiness race and missing CLI-equivalent proxy-dispatcher initialization were fixed in the harness, not misreported as product speedups. Model provider availability is checked without silently switching models. Detailed current measurements and unresolved work belong in the workspace [task document](../../../../../docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md).
