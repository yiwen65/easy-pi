# General image input without optional AX preparation

Apply `g02-image-readiness.patch` after `g02-owned-key-pair.patch` and its predecessors. SHA256: `b10e697002cb8a6c0465b3e0690cc9706cde63ae201eb9a0b21db9ee9830a60e`.

Previously every General action checked the AX preparation cache and potentially wrote application readiness attributes. A failed optional setter could therefore block image-only pointer input. Preparation now follows actual structural consumers: image move/click/scroll/drag and owned button actions skip it; structural/keyboard/window actions retain it. Structural postconditions prepare before their reads. Skipping preparation never inserts a cache success.

Actual OS permission, target identity, image/geometry freshness, budgets, cancellation and owned releases remain unchanged. This is not a general AX permission bypass or support for unknown foreground identity.

Verification:
- Production callback seam: three assertion failures before, nine tests passed after; coordinator independently reran all nine.
- Computer 50, controlled input 12, Skylight 18, core 85 and SDK 83 passed. Genuine generation/check/N-API/header/types passed; generated sources unchanged. Historical unrelated warnings/failures are not declared fixed.
- Installed original AgentSession/faux, same dedicated non-accessibility canvas: C376 old candidate produced one readiness write; C377 new candidate produced zero. Both delivered exactly one real mouse pair. C378 four-application workflow saved exact 612 bytes and verified the GUI-entered terminal checksum. 51 terminals/eight natural exits; borrowed apps retained.
- C375 initial fixture lacked `acceptsFirstMouse` and received no canvas effect; preserved as failed, not product qualification.
- `general/image-readiness-installed-verification.json`, `image-readiness-crossapp-verification.json`, `image-readiness-source-verification.json`: independent raw/hash/strict patch apply/byte/reverse proofs.
- `general/g02ir/check.log`: complete root check, 1447 files, no fixes; matching type/build/package/offline installation passed.

Actual GUI proves removal of the preparation mutation; the failing-setter case is covered by the native seam, not an OS-level injected error. No physical-source, real-provider, popup or whole-goal acceptance is implied.

Candidate SDK: `655f61930557199ff32a66e4e5be6c74d788dc2722fa1a59fb5882baacdbebc8`; N-API: `f3b62e8717d22bf762df4d67df946a46ceec3fe6db19c758890df02c0a87a629`. Production pins remain unpromoted.
