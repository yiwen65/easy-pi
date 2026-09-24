# Observed HTML select options

Apply `browser-select.patch` after `browser-dialog.patch` and its documented
predecessors. Four Rust source/test paths; existing MIT notices apply. No public
ABI, generated binding, renderer, permission or dependency change.

- Patch SHA256: `dba6f58f7c602c1ed47ec1265566bcb4285e4716d9ad8d7ed2315c383f2108d1`.
- SDK SHA256: `fd2ecf68deac2277f1213adeaa637935561f61a550868a473934da89bbec7aba`.
- N-API SHA256: `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`.

The real-model form previously stalled at a select: text fill was unsupported,
and structural rows displaced the actionable options from the 4 KiB model view.
Both defects have failing-before/passing-after regressions. Browser projection
now prioritizes actionable rows, publishes explicit capabilities and option
group labels, and grants only tokens actually present in the provider view.

`select_option` accepts the current observation and an observed option token,
not a guessed label or value. It uses the existing SDK click entry but a typed
native select dispatch. Observation proves OPTION and an enabled single SELECT
parent. Dispatch rechecks their identities, document/dialog containment,
disabled state, exact label and explicit value attribute. The fixed function
selects the exact option, emits input/change once and reads back the selected
option identity and value. Duplicate values therefore do not select the wrong
option. Multiple selects and custom ARIA widgets are not enabled. Existing
native ownership, target/window/frame checks and unknown-input no-replay remain.

Offline qualification: 12 native page tests, 21 CDP tests, 10 browser tests,
131 desktop/context tests passed (one renderer-value test skipped), 9 package
tests, unchanged UniFFI generation, native TypeScript check and root npm check.
Incremental patch apply, byte comparison and reverse check passed.

Opt-in actual-Chrome fixture:

```sh
ALLOW_GUI_TESTS=true node --import tsx native/computer/desktop/fixtures/real-model/select-guards.mjs \
  /absolute/new-results /absolute/qualified-sdk /absolute/computer-renderer /absolute/Chrome.app
```

Evidence `/tmp/epi-select.l1vU6w`: select guards 15/15 and neighboring dialog
guards 11/11, all native close acknowledgements and clean leases. Positive
cases cover single select, listbox presentation, Unicode, duplicate values and
dialog containment. Negative cases cover disabled option/group/select,
multiple select, moved/renamed/revalued/removed options and a parent becoming
disabled/multiple; fixture-side input/change counts remain zero.

Candidate installed after clean lease C054b; previous package is preserved at
`/tmp/epi-select.l1vU6w/installed-before`. Real-model qualification results are
recorded separately in `native/computer/desktop/fixtures/real-model/RESULTS.md`.
This is not a latency A/B or full benchmark score. Long-lived easy-pi processes
must restart normally to load the changed library.
