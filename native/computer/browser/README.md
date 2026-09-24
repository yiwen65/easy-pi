# Controlled browser actions

The browser profile operates one native-owned isolated Chrome session. It does
not attach to personal profiles or expose scripts, arbitrary keys or coordinates.

## Observe after an action

When the initial URL is known, combine preparation, navigation and observation:

```json
{"request":{"op":"prepare","url":"https://allowed.example/"},"observeAfter":true}
```

This uses the existing native stages in order, each waiting for its terminal
acknowledgement. Preparation cannot be retried; failure or cancellation stops
the remaining stages. No browser profile or target authority is reused.

For a generic SPAN/DIV that exposes `press`, use `click` with its own returned
element reference. This capability proves a direct click handler, not a value
postcondition. `execute.press.value` means the resulting control value (such as
a checkbox's `true`), not the element label. Activation without such a value
change should use `click` plus `observeAfter:true`, then inspect fresh UI for
the task result. Submission alone is not success; never replay unknown input.

Set the optional top-level `observeAfter: true` on `navigate`, `execute`, `click`
or `select_option` to include a fresh semantic observation in the same tool
result. For example:

```json
{"request":{"op":"navigate","url":"https://allowed.example/"},"observeAfter":true}
```

The URL still needs permission. Ref-based actions still require the exact
observation and target references visible in the current provider context.
This option is not accepted on `prepare` without a URL or on `observe`, and it does not change
the native-window or pixel-input protocols.

The action completes its native terminal acknowledgement before the read starts.
The read must also complete its own terminal acknowledgement before publishing
new evidence. Action status, completed steps and effect facts are preserved;
an appended observation does not turn submission into business success.

If the action fails, is cancelled or has an unknown outcome, no follow-up read
starts. If the follow-up read fails, the tool reports an error containing the
original action facts and `observationError`, without a new observation reference.
Do not replay the action: obtain fresh evidence and decide what remains.
Cancellation, context filtering and retirement cannot grant late references.

An explicit `observe` remains available when another read is actually needed.
Fewer model round trips do not by themselves prove lower end-to-end latency.

For an asynchronous update, optionally add `waitForText` with `observeAfter:true`.
It matches a case-insensitive literal substring in a displayed label or value,
limited to 256 UTF-8 bytes. It does not search hidden rows or execute expressions.
Only the final view is returned; a match alone is not business success.
Without this option there is no polling or added delay.

Successful nonmatching reads may repeat within a one-second polling budget.
An in-flight native read must still reach its terminal acknowledgement, so this
is not a hard one-second wall-clock deadline. Read failures are never retried.
Cancellation, retirement or timeout publishes no new reference. A timeout reports
`observation_condition_timeout` while preserving the action facts; do not replay
the action. Use a separate observation to decide what remains.

## Verification

When a semantic view is truncated, request a fresh bounded text search:

```json
{"request":{"op":"observe","text":"Tempor"}}
```

The filter is a case-insensitive literal substring of labels or values, limited
to 256 UTF-8 bytes. It is not a regular expression, selector or script. The
4 KiB display limit still applies. Each search rereads the current page and
replaces previous grants; only displayed rows receive references. Selector
uniqueness is checked against the full native observation, not just matches.
`filteredOut` counts excluded rows; missing matches do not prove absence from
the page. This option is not available to the native-window form profile.

Contract, fake-native terminal/cancellation, and actual provider-context tests
are under `test/`. The opt-in real Chrome qualification checks Unicode fill,
select, save, visible receipt, independent receipt and native close:

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/observe-after.mjs \
  /absolute/new-output /absolute/installed/computer /absolute/Chrome.app
```

Text-wait guards cover readiness, timeout, cancellation, a page leaving its
allowed origin, and a native alert appearing during the wait. Each verifies one
actual click and clean native closure; alerts are not automatically accepted:

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/wait-guards.mjs \
  /absolute/new-output /absolute/installed/computer /absolute/Chrome.app
```

Use a qualified installation with its enclosing product dependencies available;
the `computer` package alone is not a standalone application. Run GUI fixtures
serially on an unlocked desktop. Real-model measurements and limitations are in
`../desktop/fixtures/real-model/RESULTS.md` and the authoritative task document.
