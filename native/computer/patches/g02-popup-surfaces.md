# General popup surfaces

Apply `g02-popup-surfaces.patch` after `g02-image-readiness.patch` and its predecessors. SHA256: `4ba6a5118295d39c82681e16f43b600bacca2d80ba88a4c8c09fe5a457576574`.

General discovery, exact reselection and point geometry now share eligible all-layer window metadata. Legacy layer-0 enumeration and all-layer ownership scans keep their previous scope. A separately composited menu needs its own discovered reference, selected session and screenshot; a parent image does not grant its child.

Nonzero-layer candidates require an application identity, positive finite geometry, on-screen visibility and no known off-Space membership. Known hidden accessories are excluded before the existing 256-candidate budget. Unknown visibility remains countable and unselectable, rather than being treated as proven absent. Other in-scope rejected rows retain omission counts. This is not a complete compositor inventory; more than 256 in-scope candidates still refuse. Owned renderer filtering, PID/birth/geometry checks, image equality, permission and release rules remain.

## Evidence

- Layer eligibility/point regressions: three assertions failed before; after correction, layer/identity/geometry/renderer tests passed.
- C379/C380 exposed `discovery_limit_exceeded` before input: 315 compositor rows comprised 217 layer-0, 24 visible accessories and 74 hidden accessories. A second three-assertion regression reproduced the filter-order defect; the corrected predicate retains 241 candidates without increasing the row budget.
- Final popup tests 11, Windows 18, discovery 7, Computer 53, input 12, Skylight 18, core 85 and SDK 83 passed. Coordinator independently reran popup tests. Genuine generation/check/N-API/header/types passed; generated source unchanged.
- C381 installed original AgentSession/faux: explicitly selected Finder popup CG10996, distinct from parent10987, layer101. Actual 518×874 source captured at303×512; image-selected **Duplicate** was delivered through the background route and produced exactly one byte-identical copy. Task window closed; Finder retained. Twenty terminals/two natural exits.
- C382 same installed product: four-app workflow saved exact612 bytes and verified a GUI-entered terminal checksum; 41 terminals/two natural exits.
- `general/popup-installed-verification.json`, `popup-eligible-crossapp-verification.json`, `popup-source-verification.json` independently seal raw evidence and strict apply/byte/reverse validation. `general/g02pe/check.log` records complete root check,1447 files/no fixes, plus matching independent installation.

Initial stale-image refusals and the single fresh-image retry are preserved. This does not prove physical-source input, real-provider autonomy, visible cursor above a high-layer menu, or whole-goal acceptance. Historical unrelated warnings/failures remain.

Candidate SDK: `d390a1bbee9ac92c3df86e69f3be095b4fdf7c271d47c701701b701cbe588931`; N-API: `e39ed9983d325334e30cbf216ae937d364220ad3120e31eaf9cb0e8c41963362`. Production pins remain unpromoted.
