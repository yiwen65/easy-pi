# General Computer: owned make-key completion

Apply `g02-owned-key-pair.patch` after `g02-segment-runtime-scope.patch` and its documented predecessors. SHA256: `bc83a7c2551d784b85bfb2a149fefbb828b020acf69ab3976ffa0d4e17038849`.

The controlled WindowServer activation sequence previously admitted both records independently. Cancellation after admission of record `0x01` could refuse matching record `0x02` without retaining a cleanup obligation. This is a paired protocol defect, not proof of physical mouse-button stickiness.

The sequence now prepares both records and captures one destination before admission, arms exactly-once synchronous completion inside first-record admission, and drains it under the existing tracked worker. Cancellation, ancestor revocation, deadline and exhausted primary budget cannot suppress owned matching completion. Cleanup rechecks PID/incarnation/window ownership without using the cancelled operation's admission gate. Ambiguous matching failure or identity loss quarantines; there is no retry or retargeting. Ordinary uncontrolled behavior is unchanged.

Pre-pair identity refusal and failed front requests do not invent an owned pair or quarantine obligation. Identity is rechecked after fronting. The front request and first record count as two primaries; matching cleanup is not counted as a third delivered primary.

## Verification

- Original cancellation/revocation callback regressions failed; corrected Skylight suite: 18 passed. Coordinator's three pre-pair refusal regressions also failed before the correction and passed after it.
- Controlled SDK: 83 passed; controlled core: 85 passed. Genuine bindings generation/check, N-API staging, ABI header and TypeScript checks passed. Inherited UBRN warnings remain.
- C369–C371, independently installed original AgentSession/faux: actual activation pair received, editable focus preserved without button commitment, stop/release with no model continuation, and four-application workflow saving exact 612 bytes with GUI-entered terminal checksum. 52 native terminals, six natural child exits, no forced teardown. Applications retained.
- `general/key-pair-source-verification.json`: strict patch apply, byte comparison and reverse verified.
- `general/key-pair-installed-verification.json` and `key-pair-crossapp-verification.json`: independently checked raw evidence.
- `general/g02kp/check.log`: complete root check, 1447 files, no fixes.

Cancellation *between records* is proven by the production callback seam, not by a desktop barrier experiment. C370 also reported foreground target change; the emergency shortcut is not proven to be the sole cause of interruption. Software HID is not physical-source proof. Expanded worker platform suite retained five failures and one ignore; it is not reported as all green.

Candidate SDK: `6072a48dcab6a64df995084ff2215a4e246eca2ea4c53f57c9a5645c1977215e`. N-API: `d6aa0aa3b96f1d4e2ab676c15796e6a79729a33612fc35f172854aafc4cf226f`. Production pins are not promoted. This increment is not whole-goal acceptance.
