# Codex cache capability diagnosis

- Status: done (bounded diagnosis; proposed cache configuration unsupported)
- Authority: 用户“Continue verifying”，随后明确授权新增最多12次实际请求/10分钟，luna/max/SSE，仅合成材料与临时测试脚本；失败与重试计入预算，父子session ID独立；不改产品、设置或当前会话。
- This budget is separate from the completed 18-request cache-key experiment; its results are not rerun or retroactively changed.

## Scope and evidence gates

先验证ChatGPT Codex端点对公共Responses缓存参数的支持，而非假定文档可直接用于gpt-5.6-luna。使用installed compiled ModelRuntime及test-only onPayload，内存credential/catalog，CLI同款proxy初始化，禁用重试，实际fetch守卫计数及超时。只使用合成system/messages，无真实历史、技能或工具执行；这是协议级fork-shaped请求实验，不是native spawn验收。

固定模型openai-codex/gpt-5.6-luna、max、SSE、store=false。父子独立session-id/x-client-request-id，同一逻辑prompt_cache_key。父warm必须完整body/header相同；首次child必须完整保留parent wire input前缀及其他body字段。参数组合为prompt_cache_options={mode:explicit,ttl:30m}及父user input_text末端prompt_cache_breakpoint={mode:explicit}。

## Execution plan

1. Dry precheck: no inference; verify selected model/effort, mutation schema, bounded guard and shutdown.
2. Fresh candidate parent cold/warm/first-child. If accepted, run fresh baseline, baseline, candidate fixtures (3 requests each, maximum12) to reverse order without replaying a child to warm itself.
3. If the initial combined request is rejected, do not claim efficacy. Split probes: unchanged baseline, options only, breakpoint only, mode only, ttl only, implicit+ttl. Stop after bounded capability diagnosis. HTTP200 alone is only acceptance, not semantic support.
4. Retain synthetic request bodies, raw usage presence/zero distinction, safe error messages and hashed headers. No credentials or complete SSE transcripts persisted. Check resources stopped; remove temporary script; report known/unknown.

## Static findings

- packages/ai/src/api/openai-codex-responses.ts buildRequestBody sends prompt_cache_key but does not generate prompt_cache_options or explicit breakpoints; convertResponsesMessages called with includeSystemPrompt=false.
- packages/ai/src/api/openai-responses.ts has separate explicit-cache compatibility wiring; this does not establish Codex backend support.
- Local sibling codex source separates prompt_cache_key override from transport identity, but local checkout is not evidence of latest upstream or server implementation.
- Prior experiment raw request file at the previously recorded epi-fork-cache-ab-JvTFcz location was absent during this continuation. Do not claim fresh revalidation of old raw requests or infer who removed them.

## Execution log

- Dry `PI_OFFLINE=1 node /tmp/epi-cache-capability.mjs --dry`: passed; 0 requests; model/max available, Node v24.15.0, resources closed. Artifact: /private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-cache-capability-bv1Mnh/report.json.
- Installed adapter SHA256: aa81b02522bbc0d4a2c518ca57af44431d22fb5fc73838777b1e17a778f30441.

## Final result

Completed capability diagnosis: the tested ChatGPT Codex endpoint/model explicitly rejects both public-API cache options and explicit breakpoints. No production changes, builds or commits. The first-fork efficacy comparison was not run because the capability gate failed; no cache-hit guarantee or session-ID root cause was established.

| Request | Probe | HTTP | Server result |
| --- | --- | --- | --- |
| 1 | explicit+30m options and breakpoint | 400 | Unsupported parameter: prompt_cache_options |
| 2 | baseline without new cache parameters | 200 | ACK; input5511, output5, raw cached_tokens=0, cache_write_tokens=0 |
| 3 | explicit+30m options only | 400 | Unsupported parameter: prompt_cache_options |
| 4 | breakpoint only | 400 | invalid_parameter: prompt_cache_breakpoint is not supported on this model |
| 5 | explicit mode only | 400 | Unsupported parameter: prompt_cache_options |
| 6 | 30m ttl only | 400 | Unsupported parameter: prompt_cache_options |
| 7 | implicit+30m options | 400 | Unsupported parameter: prompt_cache_options |

- 7 actual requests total (including6 rejections), 21411ms from first request to shutdown; no retries or network failures. Stop early rather than spend remaining5 requests on unsupported configuration.
- Original start1789117224209, deadline1789117824209; this run ended1789117245620. Budget is closed at task completion, not automatically available for future work.
- Evidence directory: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-cache-capability-qJcssX`; contains report.json, events.jsonl and request-1.json through request-7.json. Actual request model/reasoning/store and parameter presence verified before send; raw error messages distinguish endpoint option rejection from model breakpoint rejection.
- The parameter probes use separate fresh synthetic prefixes/session identities, not paired latency/caching samples. They establish explicit rejection, not a cache-rate comparison. No child requests were sent because the first candidate failed.
- Public GPT-5.6+ documentation cannot be assumed to describe the named gpt-5.6-luna model behind this Codex route. Rejections are specific to tested endpoint/model/account/time; no claims about other models or public API support.
- Recommended next direction: retain strict prefix checks and independent transport identities. Shared logical key remains a candidate, not a guarantee or proven fix. Do not inject the rejected fields into production. A hard guarantee requires a supported Provider cache contract, not a client-side session-ID change.
- Independent offline validation: all7 request body hashes, model/max/store, cache parameter placement, exact rejection messages, contiguous count and shutdown passed. report.json SHA256: `dbaacbaafcf342d76282e566f93fe611dd67ea5c5f2f6458154ea51eb35961ec`.
- Cleanup: harness abort timer cleared and fetch streams settled; no diagnostic Node remains. Temporary script removed after offline evidence validation; synthetic evidence retained. No native sessions were created in this protocol-level probe.
