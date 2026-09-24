# Controlled browser actions

The browser profile operates one native-owned isolated Chrome session. It does
not attach to personal profiles or expose scripts, arbitrary keys or coordinates.

## Observe after an action

Set the optional top-level `observeAfter: true` on `navigate`, `execute`, `click`
or `select_option` to include a fresh semantic observation in the same tool
result. For example:

```json
{"request":{"op":"navigate","url":"https://allowed.example/"},"observeAfter":true}
```

The URL still needs permission. Ref-based actions still require the exact
observation and target references visible in the current provider context.
This option is not accepted on `prepare` or `observe`, and it does not change
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

Use a qualified installation with its enclosing product dependencies available;
the `computer` package alone is not a standalone application. Run GUI fixtures
serially on an unlocked desktop. Real-model measurements and limitations are in
`../desktop/fixtures/real-model/RESULTS.md` and the authoritative task document.
