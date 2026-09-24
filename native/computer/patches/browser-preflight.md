# Browser process-catalog admission

Apply `browser-preflight.patch` after `readiness-fast.patch`. Two native Rust
paths; existing MIT notices apply. No ABI, dependency or permission changes.

- Patch SHA256: `f7fe6bddf6c4e78590a6624e6050d4cfb5f7589eb2cb305458aee42e0223fcf4`.
- SDK SHA256: `722909c67f7a1fccc28e6ab0f9dea01ee48f207b7e184be148d8dbac419ede54`.
- N-API and renderer unchanged. Materials include source hashes and build proof.

Reproduction: a same-user, launchd-owned WeWork IPCHelper returned ENOENT from
`proc_pidpath`. The existing complete process catalog correctly rejected that
unreadable image, but only after launching isolated Chrome. The same catalog
failure then prevented filesystem cleanup proof, quarantining the desktop.
This is not evidence of a child-reaping race or permission denial.

The candidate checks catalog readability before copying files or launching the
browser. Only transient catalog changes are reread within a one-second budget;
creation is never replayed. Root identity and terminal cleanup checks remain.
This cannot guarantee cleanup if the environment changes after admission, and
does not make an unreadable process acceptable. It fixes avoidable side effects
and quarantine for a pre-existing failure, not every browser preparation failure.

Two native regression tests and four browser-tool tests passed. The tool retains
only fixed diagnostic codes; arbitrary native messages remain redacted. Locked
offline release and genuine UniFFI check passed. Existing upstream Rust warnings
about unused code/unsafe and duplicate rpaths remain; no warning-free Rust claim.
Independent patch apply, byte comparison and reverse passed. Package tests 9/9,
desktop load tests 124 pass/1 skip, and root `npm run check` passed.

Real SDK comparison in the same broken environment:

- Before: `image_path_unavailable`, inputCommitted=true, close=Quarantined, D04f8.
- Candidate: same refusal, inputCommitted=false, close proved, C04f9.
- Installed SDK: same safe refusal and proved close, C04fa.
- Installed Computer tool: paused/image_path_unavailable, proved close, C04fb.

Incident D04f7 and diagnostic D04f8 were separately inspected and manually
recovered under exclusive lock, preserving inode/generation. No automatic dirty
recovery was added. Evidence and prior package: `/tmp/epi-repair.BJD4uG`.
WeWork normal quit/reopen did not restart its independent helper. After explicit
user approval, launchctl stop/start of that exact helper changed PID 564 to 64621;
the catalog changed from one unreadable path to zero. Native prepare/close then
passed (C04fc). Three real-model tasks also prepared and closed cleanly (C04fd–ff).
Their business oracles failed for separate action-contract/provider issues;
successful lifecycle recovery is not a claim that those tasks passed.
