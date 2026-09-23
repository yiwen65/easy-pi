# Controlled discovery filtering before the reference budget

Apply `g06-discovery-query.patch` after `g03-discovery-capacity.patch` and its documented predecessors. SHA256: `6b6b414d4a13978f879747aaba0114bda5471353a520e32eff3c6f1811a7cf20`.

The host previously filtered app/title/focus only after native discovery. Thus 257 eligible but mostly irrelevant windows prevented a narrow query from returning its target. The controlled SDK now passes a bounded `ComputerWindowQuery` through canonical authorization; the platform filters before its unchanged 256-reference limit. Unfiltered or 257 matching rows still refuse. Filtered rows and unproved omissions have separate counts; neither grants a reference. Exact selection revalidation, cancellation and ownership remain unchanged. The legacy public `list_windows` schema is unchanged.

The increment contains nine authored files and five genuinely generated TypeScript/Python files. It changes the SDK method argument and Windows result ABI; **do not mix an old library with the new bridge/bindings**. Production pins remain unpromoted pending final delivery.

## Verification

Evidence: `.artifacts/computer/general/discovery-query/`.

- Three core/platform assertions failed before; after: contract 1, controlled core 107, platform Computer 83, SDK Computer 91 passed. These are selectors, not full upstream suites.
- A separate initial contract failure exposed serde accepting array-shaped structs; the shared parser now explicitly requires a closed object.
- Genuine generation/check, staging/N-API, header and TypeScript emission passed. Strict patch apply/byte comparison/reverse passed, including generated text. Old qualified binaries and upstream staged binaries were preserved.
- Host before: 11 passed, 2 failed. Final host/segment/drag checks: 43 assertion tests plus one fixture-load entry; renderer integration 3 and original AgentSession integration 13 passed. Both native type layers and isolated root check passed.
- Matching installed product: SDK `574acada8fd701ca5351e61abc7548ae515400dbedbc81d602afaeb3bcd675c1`, N-API `2e13bfdb600b24dca7a03d9cdd295aedd857ea2f72a48ebab10f2e4954b8e423`, unchanged helper `1195e23ecdad946a7090f338357e41042ceaa1333daa18203ea7bfc0ee8c2fa3`.
- C459 repeated C458's exact read-only query successfully. Desktop state had changed: zero old-task matches and 132 filtered eligible rows, so this is not live proof of the >256 boundary. Deterministic native regressions cover that boundary.
- C460 discovered/selected fresh task content in the existing Chrome process/profile and completed one Canvas click, cross-origin iframe Unicode submission and GUI tab navigation/closure through installed AgentSession. Independent HTTP effects and fresh Computer readback reconciled native unknown conditions; no uncertain input was repeated. Nineteen terminals, two natural exits, borrowed Chrome retained.

C458's original capacity failures and C456's earlier single completed click remain preserved. These are narrow discovery/workflow results, not overall General delivery or performance acceptance.
