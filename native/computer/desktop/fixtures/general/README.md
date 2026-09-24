# General Computer tool/UI scenarios

Opt-in macOS AppKit/WebKit tests of the installed `computer` tool. The suite
uses disposable windows, local HTML, no credentials, no external network and
no model API. Do not operate the keyboard or run another GUI suite concurrently.
Never delete an occupied/quarantined desktop lease to make a test run.

```sh
fixture_dir=$(mktemp -d /tmp/epi-general.XXXXXX)
swiftc native/computer/desktop/fixtures/general/GeneralFixture.swift \
  -o "$fixture_dir/GeneralFixture" -framework AppKit -framework WebKit
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/save-panel/benchmark.mjs \
  "$fixture_dir/GeneralFixture" "$PWD/packages/coding-agent/computer/bridge.js" \
  "$fixture_dir/results" 5 general
```

The count is rounds, not A/B pairs in this mode: thirteen scenarios per round,
fresh process/feature each time, serial execution, no retry. The save-panel
suite remains independently runnable for save/reopen and modal-sheet coverage.

| Scenario | Task | Independent oracle |
| --- | --- | --- |
| unicode-edit | Replace multiline Chinese, combining accents, emoji, tab | Exact editor string plus fresh AX value |
| continuous-edit | Ten different replacements in one session | Exact string and AX value after every edit |
| native-batch | Fill two native text fields in one segment | Both exact strings, two accessibility deliveries and confirmed final value |
| mixed-batch | Fill a document editor, then request a native field write | Synthetic first input, refused synchronous suffix, untouched second field; fresh exact ref and explicit judgement permit the second fill |
| window-switch | Main → second → main, edit each | Both editor strings, no cross-window contamination |
| pointer-click | Image-bound click | Exactly one owned canvas mouse-down |
| pointer-scroll | Image-bound scroll | Owned canvas receives nonzero scroll event |
| pointer-drag | Image-bound 200 ms drag | Mouse-down, drag events and endpoint in destination region |
| pointer-cancel | Abort a 3 s drag after the first received drag event, then reopen the session | Exactly one down/up, no follow-up click, no late drag after close, new session clicks once |
| web-form | Type Unicode and Return-submit | WebKit DOM read-only value plus submit-handler value |
| stale-reference | Consume semantic ref, attempt old input, recover | Exact stale error, unchanged body, fresh input succeeds |
| stale-image | Consume image ref, attempt old input, recover | Segment's exact stale_observation error, unchanged body, fresh input succeeds |
| cancel-restart | Abort before dispatch, close and recreate feature | Exact cancellation error, unchanged body, new session edits |

Normal tasks and protection/recovery cases are labeled separately in raw
samples. A correctly refused action is not counted as successful business input.
`needs_observation` is neither failure nor success by itself: editing requires
fresh AX and independent fixture state, then explicit reconciliation before new
work. Unknown or partially delivered input is never replayed.

Actions are exclusively through the real tool's `execute` path; result content
is fed into its context visibility tracker. Fixture stdin only requests state
or shutdown. WebKit JavaScript is a read-only test oracle, not a control path.
Image tests use deterministic in-image coordinates; they test native input and
reference handling, not a model's ability to infer coordinates from pixels.

`contract.json` fingerprints probe, native library, fixture and bridge;
`samples.jsonl` retains every attempt and per-call timing/status, with complete
text logs (no base64 screenshots). Timing includes cold bridge load, feature,
discovery, actions and readback; preopened fixture setup and awaited cleanup
are separate. All failure samples remain in denominators; small-sample P95 is
descriptive only. Missing cleanup proof stops the batch. At 60 s the probe
requests abort; at 90 s the supervisor records pending drain and waits, never
force-kills a native owner or advances unsafely.

Limits: embedded WebKit is not Safari/Chrome browser chrome, tabs or external
navigation; canvas scroll tests event delivery, not scrolling a long document;
window switching is deliberate, not external focus theft; cancellation covers
pre-dispatch and a single-window drag, not every action or cancellation race. Clipboard, IME composition, file pickers beyond
the save fixture, multi-display scaling, target disappearance, real browsers,
external focus theft, keyboard/cross-window cancellation, long-duration soak and model-led
tasks need distinct qualification. No OS permission/ownership checks are removed.

Execution status and results are maintained only in
`docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`.
