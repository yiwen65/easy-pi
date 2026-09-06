# easy-pi permissions

Private workspace package for shared tool permission decisions and external-mutation journals. Product UI and extension registration belong to `packages/coding-agent`; task orchestration belongs to `packages/subagent`.

## Full Access contract

Full Access suppresses approval prompts and permits credential reads, including `.env`, credential-store paths, shell reads, and environment inspection. This is an explicit product policy, not an assurance that reading or disclosing credentials is appropriate for a task. Audit preview redaction remains separate from tool authorization.

Best-effort catastrophic-deletion checks remain active. These checks recognize selected shell forms; they are not an OS sandbox and cannot contain arbitrary programs or guarantee prevention of deletion. Tools retain the Pi process's host permissions.

Auto and Manual Allow retain their existing write-approval rules. The Full Access decision does not redefine those modes.

## Verification

`PI_OFFLINE=1 node --test test/permissions.test.ts` checks decisions on synthetic inputs; credential-path cases do not open those files. The mutation-journal tests use temporary files.

Distribution wiring and default product registration are tracked separately in `docs/tasks/2026-09-06-easy-pi-product-integration-task.md` at the repository root.
