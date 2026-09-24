# Real-model Chrome / Computer benchmark

This opt-in suite runs the configured **real model through AgentSession and the installed `computer` tool**, against an isolated, visible Chrome for Testing. It is not a scripted-model test. Task completion is checked independently of the model's answer. Failed attempts and setup failures remain in the results.

**Lifecycle recovery verified; business qualification remains partial:** the installed preflight fix prevents the reproduced environment failure from creating browser side effects. Authorized helper restart restored prepare/close, including three real-model tasks. Those tasks still failed their business oracles; see [measured results and remaining failures](./RESULTS.md).

## Scope and mainstream benchmark mapping

| Benchmark / mechanism | Implemented here | Qualification boundary |
| --- | --- | --- |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Eight original HTML tasks: click, text, checkboxes, list, tabs, drag, scroll, login | Seed 42; original raw reward; adapted 180-second deadline and full-browser viewport. **Not official aggregate score**. One seed is smoke coverage, not a distribution. |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | Similar observation/action/oracle separation; actual easy-pi tool profiles | Not the BrowserGym action space or official runner. Desktop AX+image and experimental browser DOM profiles are reported separately. |
| [WebArena](https://github.com/web-arena-x/webarena) / VisualWebArena | Local form, record search/navigation, cross-tab reference, scrolling, modal dialog | Mechanism mapping only. Hosted application datasets, resets, full task distribution and official evaluators are **not installed/run**. |
| WorkArena (linked from BrowserGym) | Form/list/navigation mechanisms | No ServiceNow instance/account; no official WorkArena result. |
| [OSWorld](https://github.com/xlang-ai/OSWorld) / [OSWorld-V2](https://github.com/xlang-ai/OSWorld-V2) | Existing adjacent general/save-panel fixtures cover editing, save/reopen, windows, pointer input, cancellation, stale refs | These are local macOS fixtures, not official VM tasks. Official images, task access, cross-app file/workflow evaluators remain separate prerequisites. |

Remaining Chrome qualification categories: back/forward/history, download/upload through native file pickers, clipboard roundtrip, nested frames, trusted keyboard handling, dynamic content, native browser prompts, tab close/reorder, offline navigation, long-running sessions. Remaining desktop categories: cross-app document workflows, native IME composition, multi-display/scale changes, mid-drag cancellation and external focus takeover. Never classify an unrun item as passing.

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

The output directory must not already exist. Replace `all` with comma-separated task IDs to run a bounded subset. Strategies: `baseline`, `efficient` (image-first batching), `semantic` (AX-first, fresh returned evidence). Mode `browser` exercises the experimental bounded DOM profile instead; its capabilities are narrower and results must not be pooled with desktop results. Optional final argument is the numeric seed (default `42`). Cross-tab retention is not yet independently qualified in browser mode.

Limits: 24 model turns/task, 180 seconds for model/tool execution, 2048 output tokens/turn, no provider retry. Reported cumulative cost at/above USD 10 prevents starting another request/task; this is **not a prepaid hard spending cap**, because an in-flight response may cross the threshold and provider cost reporting can be incomplete. Setup and cleanup are separately timed. Cancellation waits for native drain, not a fabricated timeout success. Run processes serially; cost limits do not aggregate automatically across separate invocations.

The desktop fixture uses an empty profile, `--use-mock-keychain`, disabled sync/extensions/background networking, loopback-only task server and CDP. The model only receives `computer`, no shell/filesystem/network/evaluator tool. CDP is used by trusted harness setup, independent result checks and graceful close, never to perform task actions. Browser mode uses the native-owned isolated profile lifecycle. Profiles and failed evidence are retained for diagnosis, not force-deleted.

## Evidence and acceptance

`contract.json` records model, strategy, tool profile, seed, native/bridge/probe/fixture hashes, MiniWoB commit and limits; `sources/` freezes the harness version. Each attempt retains tool calls, assistant actions (not hidden reasoning), usage, screenshots, independent oracle, timing, cleanup proof and failure. `summary.json` retains **all** attempts and reported costs. `node native/computer/desktop/fixtures/real-model/report.mjs /absolute/output` summarizes durations and refusal codes without dropping failures.

Business success requires the exact independent result, real model and tool calls, and clean native/Chrome closure. A correctly refused stale reference is protection success, **not task success**. Model narration or `inputCommitted` is never the task oracle. Report setup/failed/interrupted attempts separately but keep them in the denominator. P50/P95 of successful tasks exclude failed durations explicitly; small-N P95 is not a reliability claim.

For an optimization: freeze dataset/seed/model/native version, preserve the same oracle, alternate A/B order for repeated pairs, retain every failure and count calls/bytes/model time/tool time. Do not promote prompt changes based on one faster failed run, or pool distinct task families into a claimed speedup. A changed stale-image policy also needs negative controls for moved/replaced targets, overlays and unrelated windows; any weaker semantic guarantee must be explicitly accepted.

## Initial observed failures (2026-09-24)

Real `openai-codex/gpt-6-sol`, low reasoning, Chrome 153.0.8010.52; MiniWoB commit `33c3b4ddef8c6eb67c57a29663d844b1eda7e614`; installed native SHA256 `8b01d174bff81dc49101b3a85e692fbc8b4ceb7fbdf13c237e5411ad3d98d75a`.

Initial image-first Chrome run: navigation passed; form, cross-tab, scroll and dialog failed (1/5). All five closed cleanly. Task times were respectively 89.9, 128.6, 54.1, 69.6 and 61.0 seconds; these different tasks are not speed comparisons. Official MiniWoB click smoke timed out at 180 seconds after repeated `stale_image_observation`, despite correctly located target coordinates. Experimental browser profile failed `prepare` with `native_fault` (16.0 seconds, two model turns); no fallback/retry was hidden.

The native image-reference implementation compares the SHA256 of the entire PNG as well as window identity and geometry. A changing countdown elsewhere on the page can therefore invalidate the click. Other traces show `foreground_focus_unproved`, synthetic input delivered without a confirmed field value, and reuse of pre-mutation image refs inside a segment. These are separate failure classes, not proof that all checks should be removed. Target-region validation has been proposed but is not enabled pending explicit agreement on the weaker whole-window guarantee.

Harness bring-up failures are also retained: a document-readiness race and missing CLI-equivalent proxy-dispatcher initialization were fixed in the harness, not misreported as product speedups. Model provider availability is checked without silently switching models. Detailed current measurements and unresolved work belong in the workspace [task document](../../../../../docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md).
