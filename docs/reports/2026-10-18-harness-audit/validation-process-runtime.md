# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

Implemented all assigned runtime fixes after deterministic red reproductions. Recommended status: ready for coordinator validation, not acceptance. T-139 covers only Agent-loop ownership. Base observed: f7606c3df763e4dcbc75261211346e67124ee628.

Task closure evidence:
- T-130/F01: abort during stat/shell/prepare previously launched a task; admission signal now prevents launch, with zero tasks/log writers. Added cwd and Bash→manager cancellation tests; admitted/adopted tasks remain independent.
- T-139/F10 Agent: explicit steering/follow-up inputs and non-continuing turns reset repetition history. Four independent repeated requests now complete instead of stopping at three.
- T-140/F11: fingerprints include image data identity; changing images continue, identical images still trigger the guard.
- T-142/F13: cancellation gates prevent late grep/find search spawns after asynchronous preparation. Existing shared fd probe remains independent.
- T-143/F14: both mutation queues canonicalize nearest existing ancestors. Controlled alias overlap max-active changed 2→1, including absent→created targets.
- T-144/F15: shutdown now reports process-plus-writer settlement, not just terminal status. One open writer keeps its task owned; lease release stays 0 until close, then becomes 1; cleanup removes the record only after settlement.
- T-145/F16: only in-flight shutdown joins are cached; retries after eventual settlement complete and permit reuse.
- T-146/F17: independent streaming UTF-8 decoders preserve split/interleaved output and flush partial suffixes. Seven raw bytes previously yielded six replacement characters; now yield 中😀 with totalBytes=7. BOM preservation covered.
- T-147/F18: abort/start-callback/output-callback failure prevents timeout promotion while awaiting exit. Zero adoptions; original errors retained. Numeric acknowledged exits and successful-adoption independence remain valid.
- T-148/F19: additive EventStream.fail(error) rejects iterator/result, preserves queued events, and avoids unused-result unhandled rejection; both raw loop wrappers handle producer rejection. Four prior hanging/unhandled cases now settle.
- Assigned baseline follow-up: reproduced bash-persistence 30 pass/1 failure (stream.path undefined with managed fd). Test now uses createWriteStream's path argument; product contract unchanged; all 31 pass.

Changed files (18):
Sources:
packages/agent/src/agent-loop.ts
packages/agent/src/no-progress.ts
packages/agent/src/harness/env/background-task-manager.ts
packages/agent/src/harness/env/background-task-types.ts
packages/agent/src/harness/env/node-process-executor.ts
packages/agent/src/harness/tools/bash.ts
packages/agent/src/harness/tools/file-mutation-queue.ts
packages/ai/src/utils/event-stream.ts
packages/coding-agent/src/core/tools/find.ts
packages/coding-agent/src/core/tools/grep.ts
packages/coding-agent/src/core/tools/file-mutation-queue.ts
Tests:
packages/agent/test/runtime-progress-regression.test.ts (new)
packages/agent/test/harness/runtime-process-regression.test.ts (new)
packages/agent/test/harness/file-mutation-missing-alias.test.ts (new)
packages/ai/test/event-stream-failure.test.ts (new)
packages/coding-agent/test/search-tool-cancellation.test.ts (new)
packages/coding-agent/test/file-mutation-missing-alias.test.ts (new)
packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts

Verification:
All Vitest checks used package cwd and node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run with named files. Exact file lists/commands and red/green evidence are recorded in /tmp/pi-runtime-verification.md.
- Final agent: 15 files, 191/191 passed (/tmp/pi-runtime-agent-final.log).
- Final coding-agent: 7 files, 146/146 passed (/tmp/pi-runtime-coding-final.log).
- Final AI: event-stream-failure, response-lifecycle, openai-responses-terminal-event: 38/38 passed (/tmp/pi-runtime-stream-final.log).
- bash /tmp/pi-runtime-repeat.sh: ten controlled repetitions of 26 agent + 6 coding regressions, 320/320 passed (/tmp/pi-runtime-repeat-final.log). Deferred gates/fake timers/queue barriers, no timing sleeps in new races.
- Scoped Biome over all 18 files and tracked diff whitespace check passed.
Neighbor tests caught an overly broad ABORTED mapping; restored existing manager-shutdown SPAWN_ERROR behavior. Added BOM guard after decoder review caught stripping; corrected with ignoreBOM:true.

Source anchors: agent-loop.ts:78,118,304,444; no-progress.ts:26; background-task-manager.ts:172,199,204,393,417,536,701; node-process-executor.ts:320; EventStream.fail at event-stream.ts:56.

Limits: root npm run check/build and full suites intentionally not run; coordinator owns them. No Windows execution, real APIs/credentials, dependencies, commits, AgentHarness/storage/session source changes, or shared documentation edits. Image identity uses full data rather than a digest; no memory/throughput improvement claimed. Alias locking remains best-effort against external namespace changes.

Documentation for coordinator: Agent README Low-Level API should explain raw producer failures reject iteration/result after queued events (no synthetic successful agent_end), distinct from unchanged Agent/provider error events. SDK background section should state admission-only cancellation, independence after admission/adoption, and retryable process-plus-writer shutdown settlement.
