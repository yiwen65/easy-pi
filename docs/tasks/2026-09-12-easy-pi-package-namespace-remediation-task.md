# Task Plan: easy-pi package namespace remediation

- Created: 2026-09-12
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User-confirmed remediation contract in the current conversation

<!-- task-doc-section:background-goal -->
## Background and goal

`grok-tui` 是当前 `my-pi` 分支新增、由 easy-pi 维护的模块，但 package manifest 仍使用 `@earendil-works/pi-grok-tui`。easy-pi 还对多个 Pi 原生模块做了实质修改。目标是执行分层 namespace 整改：把明确属于 easy-pi 的新增能力迁移到 `@easy-pi/*`，同时保留 Pi 生态的旧 import 入口，不把基础 Pi-compatible 模块无条件全部改名。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 将 `packages/grok-tui` 的 canonical package name 改为 `@easy-pi/grok-tui`。
- 将 coding-agent、测试、TypeScript paths、lockfiles、shrinkwrap、构建和 standalone 打包接线更新为新 canonical 名称。
- 增加 `@earendil-works/pi-grok-tui` compatibility shim，单纯 re-export `@easy-pi/grok-tui`，不复制实现。
- 为新旧入口增加解析、导出一致性和打包覆盖验证。
- 保留 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`、`pi-agent-core` 及其他尚未迁移的基础包名。

### Non-goals

- 不将所有 Pi 基础包迁移到 `@easy-pi/*`。
- 不改变 plugin API、provider API、TUI 行为或 runtime 语义。
- 不发布 npm 包、不创建 release tag、不推送远端。
- 不运行或修改 `packages/coding-agent/test/tool-profile-eval/**`。
- 不重启或停止 AgentPort/live session。
- 不覆盖或清理现有无关 dirty work，包括 `README.md` 和 `assets/readme/architecture.svg`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `grok-tui` 是当前分支新增的 package，而非从 `origin/main` 继承的已有 package。 | `git diff origin/main...HEAD -- packages/grok-tui/package.json` 显示新增；提交 `f9a788a48` 的作者为 `yiwen65`。 |
| F-002 | 整改前 `grok-tui` package name 为 `@earendil-works/pi-grok-tui`，依赖 `@earendil-works/pi-tui`，且未标记为 private。 | 整改前的 `packages/grok-tui/package.json`。 |
| F-003 | easy-pi 已有产品专属 package 使用 `@easy-pi/*`。 | `packages/permissions/package.json` 和 `packages/subagent/package.json`。 |
| F-004 | 整改前代码、lockfile、shrinkwrap、TypeScript paths 和打包脚本都引用旧 grok-tui 名称。 | 整改前的 `rg` 检索 `@earendil-works/pi-grok-tui` 结果。 |
| F-005 | 当前 worktree 另有未提交 README 和 architecture asset，必须保留。 | `git status --short`：`M README.md`、`?? assets/readme/architecture.svg`。 |
| F-006 | 用户确认了分层整改、产品专属 canonical 包范围和 grok-tui 旧包兼容 shim。 | 当前对话中的结构化确认结果。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: `@easy-pi` namespace 可用于仓库内 canonical package；本次不执行外部 npm 发布，因此不验证 npm scope 权限。
- Assumption: 旧 `@earendil-works/pi-grok-tui` shim 作为仓库内兼容入口实现；外部消费者能否从旧 namespace 获取新版本属于未发布前的外部运营问题。
- Open question: None. 用户已确认本次 canonical 包和兼容范围。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `packages/grok-tui/package.json` 的 name 为 `@easy-pi/grok-tui`，其源码和内部消费者使用 canonical 新名称。
- 旧 `@earendil-works/pi-grok-tui` workspace shim 能构建，并导出与 canonical package 相同的公开 API/运行时实现。
- 不存在误留的旧 grok-tui 引用；兼容 shim 自身及其专门测试中的旧名称属于允许例外。
- lockfile、coding-agent shrinkwrap、TypeScript paths、构建脚本和 `pack:easy-pi` 均与新名称一致。
- Grok TUI 目标测试、兼容入口测试、类型检查和 standalone package 打包验证通过。
- `git status` 中现有 `README.md` 与 `assets/readme/architecture.svg` 仍保留，未被本任务覆盖或清理。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004`。
- Parallel batches: None; package rename, workspace manifest, lockfiles, generated artifacts and downstream validation share dependency state and are serialized.
- Serialization constraints: `package.json`, lockfiles, shrinkwrap, TypeScript paths, build scripts and pack script are shared integration surfaces; do not modify them concurrently.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Rename grok-tui canonical package and add compatibility shim

- Status: done
- Owner: coordinator
- Objective: Establish one `@easy-pi/grok-tui` implementation and one thin old-name compatibility entry.
- Inputs and prerequisites: Confirmed scope; current `packages/grok-tui` manifest/source/export surface.
- Scope or files: `packages/grok-tui/**`, new compatibility package under `packages/`, root TypeScript workspace inclusion as needed.
- Expected output: New canonical manifest and source-backed compatibility shim with no duplicate implementation.
- Dependencies: None.
- Execution steps:
  1. Rename the canonical manifest package name and repository metadata as appropriate.
  2. Create the old-name shim package with matching public exports and a dependency on the canonical package.
  3. Add package-level build metadata without touching unrelated packages.
- Acceptance criteria:
  - Canonical package resolves as `@easy-pi/grok-tui`.
  - Shim resolves as `@earendil-works/pi-grok-tui` and re-exports the canonical implementation.
- Verification method:
  - Inspect package manifests and run focused package builds/tests after integration wiring.
- Validation evidence: `npm run build --workspace=@easy-pi/grok-tui` passed; `npm run build --workspace=@earendil-works/pi-grok-tui` passed; both package test commands passed (canonical 12 tests, shim 1 test).
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Update dependency graph, generated metadata and packaging

- Status: done
- Owner: coordinator
- Objective: Make all repository and standalone packaging paths use the canonical name while retaining the shim only for compatibility.
- Inputs and prerequisites: T-001 done.
- Scope or files: `packages/coding-agent/package.json`, `packages/coding-agent/src/**`, relevant tests/docs, `tsconfig.json`, root/package lockfiles, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/package-lock.json`, `scripts/pack-easy-pi.mjs`, root build scripts.
- Expected output: Consistent dependency graph and standalone tarball staging.
- Dependencies: T-001.
- Execution steps:
  1. Replace internal grok-tui imports and dependency declarations.
  2. Update TypeScript path aliases and workspace/build references.
  3. Refresh lockfile/shrinkwrap/install-lock using repository-approved commands and inspect the resulting diff.
  4. Ensure the standalone bundle includes the canonical package and does not accidentally include the compatibility shim.
- Acceptance criteria:
  - Internal easy-pi code uses the canonical package.
  - Generated dependency metadata is internally consistent.
  - Standalone packaging includes the canonical runtime exactly once.
- Verification method:
  - Repository grep, lockfile checks, and isolated pack inspection.
- Validation evidence: `npm install --ignore-scripts` refreshed workspace links; both generated lock checks passed; coding-agent build passed; standalone `pack:easy-pi` staged `@easy-pi/grok-tui` as a bundled dependency and an isolated tarball install passed `--version`/`--help`.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Add compatibility and regression validation

- Status: done
- Owner: coordinator
- Objective: Prove old and new package entry points expose the same API and implementation without changing TUI behavior.
- Inputs and prerequisites: T-002 done.
- Scope or files: targeted tests under `packages/grok-tui/test/` and/or a focused compatibility test; no tool-profile-eval files.
- Expected output: Regression coverage for canonical import, legacy shim import, export parity, and runtime identity.
- Dependencies: T-002.
- Execution steps:
  1. Add the smallest focused test for shim export parity and shared runtime identity.
  2. Run Grok TUI tests and the focused coding-agent tests that import the package.
  3. Fix only rename-related failures.
- Acceptance criteria:
  - Canonical and legacy entry points pass the compatibility contract.
  - Existing Grok TUI behavior tests remain green.
- Verification method:
  - `node --test` for Grok TUI package tests and the repository-approved focused Vitest command for affected coding-agent tests.
- Validation evidence: canonical Grok TUI tests passed (12 tests); compatibility shim test passed (1 test); focused coding-agent Grok tests passed (17 tests).
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Run final repository checks and review scope

- Status: done
- Owner: coordinator
- Objective: Validate the complete change and confirm unrelated dirty work was preserved.
- Inputs and prerequisites: T-003 done.
- Scope or files: all task-owned changes; no unrelated file modifications.
- Expected output: Passing checks and final task document evidence.
- Dependencies: T-003.
- Execution steps:
  1. Run `npm run check` as required by repository rules, then immediately inspect status/diff scope.
  2. Run the requested targeted build/pack verification without publishing.
  3. Validate this task document and record exact results and remaining external-publication limitations.
- Acceptance criteria:
  - Required checks pass or any blocker is explicitly recorded.
  - No forbidden test path was run.
  - Existing unrelated dirty files remain intact.
- Verification method:
  - `npm run check`, targeted tests/build/pack commands, `git diff --check`, status review, task-document validator.
- Validation evidence: `npm run check` passed; `git diff --check` passed; task-document validation passed; final status review confirmed the pre-existing `README.md` and `assets/readme/architecture.svg` changes remain untouched. The repository check reported 3 pre-existing non-blocking `lint/style/useTemplate` infos in `packages/subagent/test/collaboration-contract.test.ts`; that unrelated file was not modified.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Before edits, record status and preserve the existing README/asset changes.
2. Build and test `packages/grok-tui` using its `node:test` suite.
3. Run focused coding-agent tests that exercise Grok runtime imports; never run `packages/coding-agent/test/tool-profile-eval/**`.
4. Run type/configuration checks and regenerate only the required lock metadata with `--ignore-scripts`.
5. Run `npm run check` after code changes, then inspect any formatter-generated changes immediately.
6. Build/pack the easy-pi standalone artifact into a temporary directory and inspect package names/dependency contents without publishing.
7. Run `git diff --check`, status review, and the task-document validator.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- The old namespace shim is only locally verifiable until an authorized publisher controls the `@earendil-works` scope; no npm publication is attempted.
- A package-name alias can accidentally load two runtime copies. The shim must re-export the canonical package and must not contain a second implementation.
- Lockfile generation may touch more files than intended; inspect immediately and preserve unrelated work.
- Repository `npm run check` uses `biome check --write`, which can modify files; status must be compared before and after.
- Existing Pi-compatible package names remain intentionally mixed with `@easy-pi/*`; stale grok-tui references must be distinguished from deliberate shim metadata.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-12: Task document created in execute mode after user confirmed the layered namespace remediation contract.
- 2026-09-12: T-001 started by coordinator; current package/export/build metadata inspected.
- 2026-09-12: Canonical `@easy-pi/grok-tui` package, legacy re-export shim, dependency wiring, generated lock metadata and standalone bundle wiring implemented.
- 2026-09-12: T-001, T-002 and T-003 completed after focused build/test/pack evidence; T-004 started for final repository checks and scope review.
- 2026-09-12: Full repository check passed; only pre-existing non-blocking lint infos were reported and unrelated formatting changes were restored.
- 2026-09-12: Final scope/status review passed; no publish, tag, session restart, forbidden test execution, or unrelated dirty-file cleanup occurred.
- 2026-09-12: Implementation committed as `279a00766` (`feat(coding-agent): align Grok TUI package namespace`).

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Canonical and compatibility builds passed; Grok TUI tests passed (12); compatibility shim test passed (1); focused coding-agent tests passed (17); lock/shrinkwrap checks passed; coding-agent build passed; standalone pack and isolated tarball installation passed with `easy-pi@0.1.0-beta.1`, `epi --version`, and `--help`; repository `npm run check`, `git diff --check`, and task-document validation passed.
- Limitations: The old shim was validated locally only; no npm publication or third-party Pi plugin matrix was run. `npm install --ignore-scripts` reported 3 moderate audit findings that predate this namespace change and were not remediated in this task.
