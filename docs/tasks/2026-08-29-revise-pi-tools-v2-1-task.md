# Task Plan: Revise Pi Tools V2.1 proposal

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to correct `docs/harness_tools/Pi Tools V2.1 完整增强方案.md` following the preceding evidence-based analysis.

<!-- task-doc-section:background-goal -->
## Background and goal

The proposal has a sound four-tool architecture but currently combines several releases of work, overstates transaction and global-ranking guarantees, conflicts with current run timeout semantics, and introduces overlapping Provider/Hook/Renderer abstractions. Revise it into a staged, internally consistent, executable roadmap while preserving its core vision.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- rewrite the proposal's scope, contracts, phases, risks, and acceptance gates;
- preserve the four model-visible tools and structured provider/runtime/renderer direction;
- make Search V2.1 the first bounded deliverable;
- move FFF, external directory sort, journal transactions, overlays, and default switching behind explicit later gates;
- align timeout, partial-result, workspace-policy, provider ownership, renderer reuse, and edit guarantees with current repository behavior.

Non-goals:

- implementing product code;
- modifying `docs/harness_tools/Pi Agent Tools v2.md`;
- claiming unverified FFF APIs, strict sandboxing, transaction atomicity, or model-schema superiority;
- changing current tool behavior.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Current search parses formatted native grep/find output before reformatting. | `packages/coding-agent/src/core/tools/local-search-provider-v2.ts`. |
| F-002 | Current read requires optional `readTextRange` and otherwise fails. | `packages/agent/src/harness/tools/read-v2.ts`. |
| F-003 | WorkspacePolicy is explicitly best-effort and not an adversarial filesystem boundary. | `packages/agent/src/harness/tools/workspace-policy.ts`. |
| F-004 | Current run treats timeout as a normal structured result, not a tool error. | `packages/agent/src/harness/tools/run-v2.ts`. |
| F-005 | Existing ToolDefinition already supports stateful partial/final rendering through renderCall/renderResult. | `packages/coding-agent/src/core/extensions/types.ts`. |
| F-006 | No FFF provider or dependency is currently present in repository package sources. | Focused repository search. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “修正方案” authorizes rewriting the referenced untracked proposal while preserving its intent, not implementing the underlying roadmap.
- Assumption: The corrected document should distinguish committed V2.1 scope from later experimental phases.
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- The document clearly separates V2.1 from later V2.x/V3 work.
- Search exact/approximate/partial semantics, cursor binding, and latency tradeoffs are explicit.
- Read fallback limitations and directory-pagination state are honest and bounded.
- Edit patch is an evaluated dialect, not an assumed canonical winner; journal guarantees account for external modifications and platform capabilities.
- TIMEOUT and SEARCH_PARTIAL are normal result states where applicable.
- Provider ownership, capability routing, existing renderer reuse, WorkspacePolicy limits, compatibility, and default-switch gates are specified.
- The revised roadmap has dependency-aware phases and measurable acceptance criteria.
- Only the referenced proposal and this task document are committed; the separate user file remains untouched.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002`.
- Parallel batches: Serialized because the rewrite and final consistency review affect one authority document.
- Serialization constraints: Coordinator owns the proposal and task document; no product files are modified.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Rewrite the proposal into a staged executable roadmap

- Status: done
- Owner: coordinator
- Objective: Replace overbroad or contradictory claims with explicit contracts, phased scope, risks, and gates.
- Inputs and prerequisites: Original proposal, preceding analysis, current repository evidence.
- Scope or files: `docs/harness_tools/Pi Tools V2.1 完整增强方案.md`.
- Expected output: Corrected Chinese architecture and delivery proposal preserving the four-tool vision.
- Dependencies: None.
- Execution steps:
  1. Define non-negotiable contracts and current-state baseline.
  2. Specify bounded V2.1 Structured Search scope.
  3. Move Read, Mutation, Journal, host stabilization, and default switch into gated phases.
  4. Correct error, security, lifecycle, renderer, migration, and evaluation semantics.
- Acceptance criteria:
  - No unconditional unsupported guarantee remains.
  - Each phase has explicit exclusions and acceptance gates.
- Verification method:
  - Full-document consistency review and Markdown checks.
- Validation evidence: Rewrote the proposal into a 1,286-line staged roadmap. V2.1 is now bounded to Structured Search; Read, Mutation, Journal, host stabilization, and default switching have separate prerequisites and acceptance gates. Unsupported unconditional guarantees were replaced with capability- and evidence-bound contracts.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Validate and deliver the corrected document

- Status: done
- Owner: coordinator
- Objective: Verify traceability, scope, formatting, and repository boundaries, then commit explicit paths.
- Inputs and prerequisites: T-001 rewrite.
- Scope or files: Revised proposal and this task document.
- Expected output: Valid, committed proposal with unrelated user file untouched.
- Dependencies: T-001.
- Execution steps:
  1. Search for stale contradictory claims and unresolved placeholder markers.
  2. Run task validator and `git diff --check`.
  3. Inspect status and commit explicit files.
- Acceptance criteria:
  - Overall acceptance criteria pass.
  - No product code or unrelated file is modified.
- Verification method:
  - Focused content searches, task validator, git diff/status.
- Validation evidence: Task validator passed; 96 fenced-code markers are balanced; no unresolved placeholder markers remain; focused semantic searches confirmed timeout/partial normal-result rules, WorkspacePolicy limits, provider ownership, renderer reuse, and conditional atomicity language. Git scope inspection showed only the revised proposal, this task document, and the untouched unrelated user document.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Documentation: read the complete rewritten proposal, search for TIMEOUT/error, strict global, atomicity, FFF, sandbox, cursor, and default-switch claims.
- Process: task validator, `git diff --check`, explicit git status/staging inspection.
- No code tests or `npm run check` are required for docs-only changes.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- The rewrite could lose useful end-state ideas. Mitigation: retain them as gated later phases rather than delete them.
- The plan could remain too abstract. Mitigation: give V2.1 a concrete schema, provider boundary, deliverables, exclusions, and acceptance criteria.
- The plan could imply compatibility promises unsupported by existing APIs. Mitigation: state capability-specific fallbacks and degraded behavior explicitly.
- Current blocker: None.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User requested correction of the proposal after review; task document created and T-001 started.
- 2026-08-29: Proposal rewritten with bounded V2.1 scope, corrected result/error semantics, conditional transaction guarantees, staged later capabilities, and measurable gates. T-001 done and T-002 started.
- 2026-08-29: Full documentation consistency checks, task validation, fence/placeholder checks, and repository scope inspection passed. T-002 done.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Both tasks and all acceptance criteria passed through full rewrite inspection, focused semantic searches, task validation, Markdown fence checks, and git scope review.
- Limitations: This is a corrected architecture and delivery proposal only; no product code or runtime behavior was implemented or validated.
