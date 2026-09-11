# Cache header isolation diagnosis

- Status: done (bounded header isolation completed)
- Authority: 用户已授权真实调用，并要求“继续验证，直至得出结论”。本轮明确收紧到24次实际模型HTTP尝试/10分钟，包含失败/重试；Luna/max/SSE、合成材料，诊断而非产品修改。旧预算均已关闭。
- Boundaries: 不改产品、settings、真实history或当前会话；不build/commit/委派实现，不触碰冻结evaluator。混合header仅用于串行、无工具的临时协议实验；不修改任何native root/child身份。

## Question

上轮16请求中所有parent warm正，same-session续接3/4命中、new-session0/4；首次续接same2/2、new0/2。但是Pi sessionId同时改session-id和x-client-request-id，尚未分离两者。

## Experiment

八组fresh prefix，每组parent cold、exact warm、唯一一次continuation，共24请求。四种header变体各两次，顺序both/request/same/session/session/same/request/both，第二块反序。每组仅一个续接，不存在同组第二次续接的自身预热混淆。

| Variant | session-id | x-client-request-id |
| --- | --- | --- |
| same | parent | parent |
| session | new | parent |
| request | parent | new |
| both | new | new |

所有请求prompt_cache_key保持该组固定值，continuation完整保留父请求input前缀，其他body字段相同。对外fetch之前test-only替换指定header，其余headers逐字段hash比较；不能记录原始凭证。每组prefix/session/key全新，所以这是重复fresh-fixture比较，不是跨fixture相同body的配对。

使用installed compiled ModelRuntime，内存credential/catalog，CLI同款proxy初始化，maxRetries=0和实际fetch数量/时间守卫。无工具、native SDK会话、个人skills/context或真实历史。192条合成hash record约8k输入tokens；model openai-codex/gpt-5.6-luna、effort max、SSE、store=false，无不受支持的缓存参数。

Warm raw cached_tokens须为正才作为主要推断样本；失败则保留并明确标记，不用miss证明header因果。成功须HTTP200、stop、无tools、raw cache字段存在。只测首个续接，明确记录usage和HTTP时延，不从小样本声称稳定性/百分百保证/热改善。

## Preflight

- `node --check /tmp/epi-cache-header-isolation.mjs` passed.
- `PI_OFFLINE=1 node /tmp/epi-cache-header-isolation.mjs --dry` passed: 0 requests，24次/10分钟边界拒绝、四种header变体/精确前缀/parent replay断言通过，shutdown=true。
- Dry artifact: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-cache-header-isolation-GdnzVB/report.json`。

## Final result

24 actual requests, all HTTP200, 120574ms, all eight parent warm controls positive. First-continuation outcomes consistently separate by session-id, not x-client-request-id. Diagnostic conclusion: on the tested Luna/Codex/SSE path, changing session-id is the isolated factor supported by this experiment as disrupting first reuse of the parent's warm prefix. This is not a universal server guarantee or native integration acceptance.

| Variant | Parent warm (both replicas) | First continuation (replica1 / replica2) | Hits |
| --- | --- | --- | --- |
| same: both parent | 7936 / 7936 | 7936 / 7936 | 2/2 |
| session: only session-id new | 7936 / 7936 | 0 / 0 | 0/2 |
| request: only x-client-request-id new | 7936 / 7936 | 7936 / 7936 | 2/2 |
| both: both new | 7936 / 7936 | 0 / 0 | 0/2 |

### Conclusion and limits

- **Measured:** All8 fresh parent-cold requests0; all8 identical warm requests7936. Every fixture has exactly one continuation, so no previous continuation could prewarm it. Maintaining session-id gives4/4 positive first continuations; changing it gives0/4 even when the other identity header remains parent. Changing only x-client-request-id does not break reuse in either replica. Raw cached_tokens/cache_write_tokens fields explicitly present throughout; all cache writes reported0.
- **Client causal path:** Native children receive independent sessionId; current Codex SSE adapter maps that value to both session-id and x-client-request-id. Shared prompt_cache_key and exact serialized prefix alone did not overcome the changed session-id in these trials. Previous generic Provider-volatility explanations were too broad to exclude this specific client-side difference.
- **Supported conclusion:** session-id is the actionable distinguishing factor for this workload/endpoint/model/time, with two reversed-order blocks and positive warm controls. This substantially strengthens the prior combined-header evidence and supports the user's ordinary-session high-hit comparison.
- **Not proven:** Server routing/cache-partition implementation; all models/accounts/transports; lifelong or100% guaranteed hits. There are only two replicas per variant, with different synthetic prefixes across fixtures; no same-fixture counterfactual can avoid all cache warming. Earlier same-session second continuation did miss once, and historical other-model matrices differed. Do not replace those observations with a universal session-bound rule.
- **Implementation candidate, not performed:** Evaluate a separate Codex cache-affinity identity for preserve forks, while keeping native session/store identity and request IDs independent. Do not set child Agent.sessionId equal to parent or blindly share WebSocket connection/session keys. Any product change needs explicit implementation authority and tests for concurrent streams, abort/error routing, descendants, followups, and no response/history cross-talk. This experiment exercised serial SSE only and deliberately did not create native children.

### Evidence and verification

- Directory: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-cache-header-isolation-ikMBLF`.
- Retained files: report.json, events.jsonl, request-1.json through request-24.json, summary.json; request bodies are synthetic. No full SSE or credentials persisted; headers represented by per-field and aggregate hashes.
- report.json SHA256: `81414eea78e36b401241081fa71106a9355a7c68a211ec0885b10889658a72e7`.
- First request1789118432797, original deadline1789119032797, ended1789118553371; no retries, no network errors, shutdown=true.24-request budget exhausted and closed.
- Raw usage: input196466 including95232 cached, output601, total197067, cacheWrite0. Not a billing or latency-benefit claim.
- Independent offline verification passed all24 body hashes and sequence numbers, model/max/store, identical parent warm body/headers, exact continuation prefix and remaining body fields, fixed key, identical nonidentity headers, and exact per-variant changed-header sets. Process check found no residual diagnostic Node.
- No product/settings/build/commit/current-session changes. Temporary harness and verification scripts removed after validation; evidence retained. LEARNS.md unchanged under diagnosis-only scope.
