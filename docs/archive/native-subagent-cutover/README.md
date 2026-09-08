# Native Subagent product cutover archive

Nonexecuting byte snapshots taken from the working tree after `8a562713d`, before T-008 retirement. Do not load these as extensions. They are outside the product package and compiler inputs.

| Snapshot | Original path | SHA256 |
| --- | --- | --- |
| `easy-pi.ts.txt` | `packages/coding-agent/src/extensions/easy-pi.ts` | `5d51776b2cf0ea67eec1fcc8ff03287793428fcde3d87af9aa66919ce7987ad2` |
| `easy-pi-harness.test.ts.txt` | `packages/coding-agent/test/easy-pi-harness.test.ts` | `09bf2c53526df869d7a408590ba88b539ae92e18ba3c13ecbf662fa2fa9ff4e1` |
| `product-launcher.ts.txt` | `packages/coding-agent/src/extensions/product-launcher.ts` | `983c9848fbd523de37761decd871ef915903062e7577cfaa7987f736f78eced2` |

The harness snapshot intentionally includes the pre-existing uncommitted `historyMaintenance: !childContext` change. Legacy Subagent sources/tests, including uncommitted delivery-cleanup work, remain in place as recovery material, but are no longer exported or included in product builds. No old ledger, worktree, session or rollback snapshot was removed or recovered.

The active harness now defaults to native same-process collaboration. Legacy process-child launches fail closed; there is no automatic conversion, replay or history cleanup. Existing processes are not hot-switched. T-006 history disposition/budgets and T-007 final recovery/package acceptance remain separate work.
