# Scoped HTML dialog support

Apply `browser-dialog.patch` after `browser-preflight.patch` (and its documented
predecessors). Four Rust source/test paths; existing MIT notices apply. No public
ABI, generated binding, permission, renderer or dependency change.

- Patch SHA256: `2a5baa9abaae4545f7b7de9edf33911a75d158a74aadad690bd5befe7e79bf26`.
- SDK SHA256: `222302e7c9fb6cdca8faa5775346e1deed504deece18c05c5d5a46d83a87f914`.
- N-API SHA256: `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`.

Previously, the real model opened the benchmark HTML dialog successfully, but
the next observation failed with `unexpected_modal_surface`. A single-dialog
regression reproduced this before the patch. The user explicitly authorized
support for one current-page HTML dialog, with no input outside it.

Observation now retains the dialog backend identity, requires DOM metadata to
prove an open `DIALOG`, and disables actions outside its AX subtree. ARIA-only
dialogs and `alertdialog` remain unsupported. At dispatch the exact dialog DOM
object is resolved and passed as a typed CDP argument, never interpolated script.
Fixed fill/click functions check the document, open-dialog count, exact dialog
identity and target containment immediately before mutation. A dialog appearing
after a non-dialog observation also refuses input. Existing native-window,
target, frame, origin, ownership, cancellation and terminal checks remain.

This is a restricted DOM route, not general browser modal support. Multiple
dialogs, native browser prompts and subframes are not enabled. No select-option
operation is added by this patch. Dispatch exceptions retain the conservative
`browser_input_unconfirmed` classification; a wire submission is not proof that
the page was mutated, and must not be automatically replayed.

Offline qualification: 11 page tests, 21 CDP tests, unchanged UniFFI check,
129 desktop/context tests passed (one renderer-value test skipped), 9 package
tests, explicit native TypeScript check and root `npm run check`. Existing Rust
warnings about unused unsafe/code and duplicate rpaths remain. The incremental
patch was independently applied, compared byte-for-byte, and reversed.
The skipped renderer-value test was subsequently run explicitly against the
installed SDK and passed (1/1).

The opt-in actual-Chrome guard runner is
`native/computer/desktop/fixtures/real-model/dialog-guards.mjs`:

```sh
ALLOW_GUI_TESTS=true node --import tsx native/computer/desktop/fixtures/real-model/dialog-guards.mjs \
  /absolute/new-results /absolute/qualified-sdk /absolute/computer-renderer /absolute/Chrome.app
```

It creates isolated native-owned Chrome sessions, checks genuine terminal and
close acknowledgements, records fixture-side writes, and stops on unproved
cleanup. Eleven scenarios cover successful Unicode fill/submit, outside input,
ARIA-only dialog, multiple dialogs, subframe, and post-observation appearance,
movement, closure, replacement, second dialog, and native alert. It is not a
real-model benchmark. Native-alert/subframe observation can fail at the prior
authorization attestation boundary as `authorization_host_failed`; the runner
checks this exact outer code and `inputCommitted=false`, not arbitrary errors.

Evidence root: `/tmp/epi-dialog.UEensN`. Initial harness attempts are preserved:
one expected subframe rejection at the wrong phase; another expected an internal
code instead of the outer authorization code. These were harness assertions,
not page writes or cleanup failures. A later immediate-on-load native alert
exposed a distinct navigation race: navigation was cancelled by the 15-second
watchdog, with terminal and close proved. That failure remains recorded in
`qualified-guards`; it is not fixed by this patch. The final guard protocol
triggers native alert only after navigation and a fixture handshake, testing
already-open prompt refusal separately. See the task document and real-model
`RESULTS.md` for final GUI and installed-package results.

Final stable-page guards: 11/11, all native close acknowledgements and clean
leases. Installed-package real model: dialog PASS 37.640 seconds / 11 turns,
navigation PASS 37.580 seconds / 13 turns; exact independent and visible receipts,
both closed. Reported model cost 0.0702204 USD, final lease C0531. This is no
latency A/B or full benchmark success claim. Previous installation is preserved
at `/tmp/epi-dialog.UEensN/installed-before`; long-lived processes must restart
normally to load the changed library.
