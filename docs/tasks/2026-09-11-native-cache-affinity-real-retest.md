# Native cache affinity source real retest

- Status: done (source-native real retest passed; not built/installed)
- Authority: 用户“执行真实复测”。本轮限制最多12次实际模型HTTP尝试/10分钟，含失败和重试；仅openai-codex/gpt-5.6-luna、max、SSE、合成输入。不build、不改产品/settings/当前会话、不提交、不重放真实历史或冻结evaluator。
- Source under test: docs/tasks/2026-09-11-codex-fork-cache-affinity-task.md完成的源码修复，非旧dist。

## Plan and gates

通过临时Vitest配置复用workspace source aliases，直接加载源码SDK、Agent、native host和Codex adapter。Vite transform日志记录关键src模块实际加载，mock-token预检验证新cacheAffinityId确实发送共享session-id/独立x-client-request-id并强制SSE。不是对dist做运行时补丁，也不产出distribution build。

真实执行两组独立native root。每组root实际cold请求和原样warm重放，然后native工具spawn preserve child A（首个child请求）。第一组追加A的nested preserve、并发root siblings B/C、LRU卸载后的A explicit cold followup。预计10实际请求，保留2次硬限余量但不自动重复/修复模型输出。

- 首次A命中观察须配合正root warm控制；缺失/0不同，miss不自动重试刷命中。
- 测试不覆盖或重写产品的cacheAffinityId、promptCacheKey、sessionId、headers或transport。仅注入观察fetch、maxRetries=0及合并的budget abort signal。
- 实际body需model/max/store=false、无previous_response_id；child完整保留直接parent wire input前缀；共享root cache key/session-id，native/request ID独立。Root warm全部body/headers必须相同。
- Children使用native controller/SDK和已修复host。Host配置故意为auto，root配置SSE，验证产品自行把preserve child设为SSE；不启用WebSocket，任何WS尝试失败。
- 每个native turn最多一次stream/HTTP。模型只能返回指定的合成ACK/JSON，不调用工具。六个native工具由测试host显式调用，不是模型自由工作。结果contract必须valid、acceptance保持not_reviewed。
- B/C必须有实测请求时间重叠，各自result与history含自己的marker、不含对方marker；这只覆盖两个同时SSE请求，不是广泛并发安全保证。
- 原始usage、合成body和native sessions保留。认证/catalog仅内存读取，不持久化credential或原始headers。排除个人context/skills/extensions。使用CLI同款proxy初始化。

## Preflight evidence

- `/tmp/epi-native-affinity-real.config.mts`继承vitest.base.ts源码aliases，只include临时单一test，无默认/full-suite或冻结文件发现。
- `EPI_AFFINITY_DRY=1 PI_OFFLINE=1 node node_modules/vitest/dist/cli.js --run --config /tmp/epi-native-affinity-real.config.mts`: passed，0模型请求，新源码header/SSE smoke、native六工具与max、预算守卫、shutdown通过。
- Dry artifacts: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-native-affinity-real-JcuyQX`。
- `/tmp/epi-native-affinity-source-load.jsonl`确认加载api/openai-codex-responses.ts、agent.ts、sdk.ts、pi-child-session-host.ts、pi-collaboration-context.ts五个src模块。

## Final result

Passed within the authorized source-native/SSE scope. 10 actual requests, all HTTP200, no retries or WebSocket calls, 32558ms. Two fresh root warm controls each report9728 cached tokens; both first native preserve children reuse9728. All6 actual child requests (including nested, concurrent siblings and cold followup) report9728 cached tokens, with explicit raw field presence.

| Request | Fixture / native path | Phase | Input tokens | Raw cached_tokens |
| --- | --- | --- | ---: | ---: |
| 1 | 1 /root | cold | 9936 | 0 |
| 2 | 1 /root | exact warm replay | 9936 | 9728 |
| 3 | 1 /root/a | first preserve | 10704 | 9728 |
| 4 | 1 /root/a/nested | nested preserve | 11478 | 9728 |
| 5 | 1 /root/b | concurrent sibling | 10700 | 9728 |
| 6 | 1 /root/c | concurrent sibling | 10706 | 9728 |
| 7 | 1 /root/a | LRU cold followup | 11779 | 9728 |
| 8 | 2 /root | cold | 9859 | 0 |
| 9 | 2 /root | exact warm replay | 9859 | 9728 |
| 10 | 2 /root/a | first preserve | 10625 | 9728 |

### Verified behavior

- Test loaded current source modules, not dist. Source hashes recorded and independently rechecked after execution. New affinity smoke used fake credentials/local mock response before any real calls; it is not counted as a real request.
- Before-send and independent offline verification confirm fixed root cache key, shared root session-id, child-specific x-client-request-id/native ID, exact parent request prefix and unchanged non-input body fields, model/max/store=false and no previous_response_id. Between root and child supplied headers, only x-client-request-id differs. No test rewriting of affinity/body/headers/transport was performed.
- Two first native preserve children hit9728 each (2/2), rather than only a repeated child request hitting its own warmed cache. This is a small successful functional retest, not a production probability estimate or before/after statistical benchmark.
- Nested preserve inherits the root lineage. B/C HTTP intervals overlap by3138ms; each completed with its own exact JSON marker, and neither native history contains the other's marker. All child finals passed contract validation and retained acceptance=not_reviewed.
- LRU verified A unloaded before explicit followup; its native session ID was unchanged after reload, earlier A history was present, inherited cache headers restored, followup result correct and cached_tokens9728.
- All fixtures/controller/native resources closed. No residual test Vitest/Node process found. No build, global settings changes, current-session restart, product edits, or frozen evaluator use.

### Evidence and budget

- Actual run: `PI_REAL_MODEL_EVAL=1 PI_OFFLINE=1 node node_modules/vitest/dist/cli.js --run --config /tmp/epi-native-affinity-real.config.mts` — one targeted test passed.
- Directory: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-native-affinity-real-4kjHFN`.
- Retained: report.json, events.jsonl, request-1.json through request-10.json, summary.json and synthetic native/team files; `/tmp/epi-native-affinity-real-run.log` and source-load log retained. Ad-hoc config/test/offline-verifier scripts removed after verification.
- report.json SHA256: `ee2e06d12321f7941230ad0137f0d03b710be98975295448d71e6e5cd25b3de1`.
- Start1789123582413; deadline1789124182413; end1789123614971.10/12 requests consumed, budget closed without spending the remaining2.
- Raw usage: input105582 including77824 cached (73.7% including the two cold roots), output692, total106274; cacheWrite fields present and0. This is not an invoice, latency speedup, or a guarantee of future cache availability.

### Remaining limits

No WS parent→SSE child test, real cancellation/error-interleaving/stress test, build/install acceptance or current-session update. Only two concurrent SSE siblings were checked; this does not prove arbitrary service-side concurrency safety. Existing child histories without affinity metadata are not retrofitted. The earlier broad functional evaluation remains its own partial authority; this cache retest does not retroactively pass it. Installed dist remains unchanged until an explicitly authorized build.
