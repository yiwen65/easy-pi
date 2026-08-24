# Session Handoff: High-Fidelity Context Compaction (EPIC-CCTX-001)

- Created: 2026-08-22T17:15:00+08:00
- Workspace: /Users/w/Projects/easy-pi/pi

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting (a parallel user-side session actively commits to this worktree).
> This handoff supplies context, not new authorization.

## Session summary

- Executed EPIC-CCTX-001 (`高保真 Context Compaction 子系统——Agent 实施任务书.md`): replaced pi's summary-only compaction with a high-fidelity subsystem (append-only event log, content-addressed artifact store, tool/side-effect ledger, versioned TaskContract fixed layer, deterministic reducer, atomic cut planner, typed snapshot store with CAS, validator+repair, trigger, transactional orchestrator, rollback/raw rebuild, injection guard, recall catalog, audit trail).
- The subsystem is pi's DEFAULT compaction (`full_pipeline`); the legacy summary-only compactor was removed. Old sessions' `CompactionEntry` items still render on resume (read-side kept, per user decision).
- All work was committed by the user-side parallel session (commits `885104573`, `5ea4768f3`, `b59d2e6bd`); that session continues extending it (uncommitted: `task-ledger.ts`, `goal-interpreter.ts` + tests).
- Real-model evidence (kimi-coding K3, via pi's production auth path): recorded long session (pi-mono, 100 entries ≈42k tokens) −71%/−72% tokens at 100% atom retention, oracle-consistent; full session (1018 entries ≈156k) 4/4 rounds, −39.6%; synthetic fixtures 100% retention; 429 rate-limit correctly fail-closed.
- Real CLI dogfood (pi-test.sh, RPC mode, K3): full_pipeline manual compact −70.4% (26497→7831), post-compaction needle recall 4/4; shadow/off modes bit-identical to legacy behavior.
- Full isolated suite `./test.sh` green at last run (coding-agent 2182 passed, all packages pass); `npm run check` currently RED only because of the parallel session's two in-flight files (see Unresolved).
- Authority task ledger: `docs/tasks/2026-08-22-hf-context-compaction-task.md` (validator-passed; T-001..T-305; note: docs/tasks is now gitignored by the parallel session's decision).

## User intent and success criteria

- Implement the 任务书's high-fidelity compaction as pi's default and remove the legacy mechanism (confirmed decisions: keep read-side rendering of old CompactionEntry; keep extension hooks but ignore custom free-text summaries).
- Validate with the real kimi-coding K3 model using pi's existing credentials (user authorized; new AGENTS.md rule: real API allowed when needed with explicit per-use approval).
- "生产灰度" authorized; honest scope: no external production surface exists in this repo, so the repo-internal maximum (shadow wiring, circuit-breaker drills, full-scale soak, CLI dogfood) was executed.

## Work completed and outcomes

- G0–G3 subsystem library (23 source modules in `packages/coding-agent/src/core/compaction/subsystem/`), 249 tests green + 6 manual-gate skips.
- CCTX-080 integration: `HfCompactionHost` + `agent-session.ts` wiring; flags `off|shadow|offload_only|structured_compaction|full_pipeline`; kill switch `compaction.enabled=false`.
- T-101..T-111: integration, shadow mode + runbook (`docs/compaction/04-rollout-runbook.md`), multi-agent primitives, eval harness (`test/compaction-subsystem/eval/`: atoms/grader/runner/fixtures + corpus-converter + batch-runner), real-model evals.
- T-201..T-204: default-on + legacy removal (compaction.ts 1187→609 lines) + migration of 10 existing test suites + docs updates.
- T-301/T-302: contract API (set/update/propose), recall_exact tool, RPC commands, stateDir persistence (events/artifacts/contracts/snapshots), tool ledger backfill with risk classification — committed by parallel session.
- Real defects fixed under real-model/corpus testing: schema item-level stripping, extraction truncation salvage + scaled maxTokens, offload scope widened to full history (giant atomic parallel batches), slim adapter payloads (entryId back-refs), orchestrator→extractor signal threading.

## Key decisions, constraints, and rationale

- Target layer: mature coding-agent v3 JSONL (not the harness scaffold, per .edru RSK-001/RSK-003).
- All LLM access via injected `CompleteFn`; vendor-neutral; compactor has no tools and untrusted-wrapped input.
- Token-gain gate (default 5%) on the full next request; tiny wiring tests set `minTokenGainFraction: -1` explicitly (documented test-only override).
- AGENTS.md amended: real provider APIs off-limits by default; allowed with explicit user approval, env-gated (`PI_REAL_MODEL_EVAL=1` pattern), targeted files only, never print/persist credentials.
- docs/tasks is gitignored (parallel session decision); the authority ledger is intentionally not committed.

## Files and artifacts

- Subsystem: `packages/coding-agent/src/core/compaction/subsystem/` (24 modules).
- Tests: `packages/coding-agent/test/compaction-subsystem/` (incl. `eval/` with real-model gate `real-model-eval.test.ts`).
- Docs: `docs/compaction/01..04` (inventory, ADR, integration status, runbook); `docs/tasks/2026-08-22-hf-context-compaction-task.md` (authority ledger); `LEARNS.md` (4 verified lessons).
- Parallel-session in-flight (uncommitted, theirs — do not touch): `subsystem/task-ledger.ts`, `subsystem/goal-interpreter.ts`, `types.ts`/`orchestrator.ts`/`prompt-builder.ts` modifications, `test/compaction-subsystem/{task-ledger,ledger-cas,goal-interpreter}.test.ts`, `test/suite/regressions/5109-exclude-tools.test.ts`, `.gitignore`.

## Commands, validation, and evidence

- Subsystem suite: `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/compaction-subsystem/` → 35 files, 249 passed, 6 skipped (real-model gates).
- Full isolated suite: `./test.sh` (credential-isolated) → all packages green at last full run.
- Real model: `PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run test/compaction-subsystem/eval/real-model-eval.test.ts --silent=false` (never in CI; requires kimi-coding credentials in pi auth store).
- `npm run check` currently fails ONLY on the parallel session's in-flight files: `subsystem/goal-interpreter.ts:119` (noImplicitAnyLet), `test/compaction-subsystem/ledger-cas.test.ts:11` (unused import).

## Unresolved items, risks, and unknowns

- T-304 (blocked): multi-model gate re-test (Anthropic/OpenAI) — needs explicit user approval per new AGENTS.md rule.
- T-305 (blocked): external production canary — no production surface exists in this repo (.edru UNK-002); runbook ready.
- Parallel session's in-flight task-ledger/goal-interpreter work (G1–G10 invariants) is mid-edit; check is red because of it; coordinate before touching those files.
- Known semantic changes to downstream consumers: compactor-call usage no longer in session usage stats; manual compact on tiny sessions can be rejected by the token-gain gate (fail-closed by design).
- Unverified: none outstanding in repo scope.

## Recommended continuation

1. (agent may do) Wait for/coordinate with the parallel session finishing task-ledger + goal-interpreter; then re-run `npm run check` and `./test.sh` and fix any drift only in owned files.
2. (agent may do, after user approval) T-304: run eval runner against a second/third provider model.
3. (user decision) T-305: production rollout per `docs/compaction/04-rollout-runbook.md` in the deployment environment.
4. (user decision) If desired, commit the task ledger despite the gitignore (requires overriding the parallel session's decision — ask first).
