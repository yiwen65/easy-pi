# Session identity cache diagnosis

- Status: done (bounded diagnosis; transport identity influence supported, no guarantee)
- Authority: 用户指出普通Pi同session续聊缓存命中高，要求继续，并明确“授权真实调用”。本轮自行收紧上限为16实际HTTP尝试/10分钟；model openai-codex/gpt-5.6-luna、max、SSE、合成输入。包含失败与重试，不复用已关闭的历史预算。
- Scope: 临时协议级实验，不改产品、全局设置、真实历史或当前会话；不build、commit、委派实现或触碰冻结evaluator。不会据此让生产父子共享transport身份。

## Question and discriminating comparison

普通同session续聊高命中与fork首次miss是否由传输session身份切换造成？将prompt_cache_key固定为同一fixture的逻辑key；parent冷请求、完全相同的warm请求，然后对相同续接正文分别使用parent sessionId和fresh sessionId。四组fresh prefix，same-first/new-first交替。只把首个续接作为未被续接自身预热的样本；第二臂有预热混淆，不单独证明父缓存复用。

当前Pi SSE将sessionId同时映射到session-id和x-client-request-id，所以这是实际session身份对照，不是孤立单个header的因果验证。before-send断言全部body相同，两臂headers只允许上述两项不同；parent warm全部body/headers相同；续接input含parent完整精确前缀，其他body字段相同。包括认证/account在内的headers只留hash，不存凭证。

## Protocol and evidence gates

- Installed compiled ModelRuntime，内存credential/catalog，CLI同款proxy设置；无SDK/native会话、个人context/skills、工具调用或真实历史。普通synthetic context，192条随机hash record约8k tokens。
- 四组，每组parent cold/warm + continuation same/new = 4请求，最多16。串行，maxRetries=0，实际fetch计数，首次fetch起10分钟abort守卫。
- 不添加已证实不支持的prompt_cache_options/breakpoint。使用store=false，与当前Codex adapter一致。
- 若warm raw cached_tokens不为正，仍保留两臂以观察是否复现，但标记为不具备正warm控制，不从该组推导唯一根因。
- 若状态/预算/网络失败，停止，不自动续预算或改模型。成功必须HTTP200、stop、无tools，并保留raw cached_tokens字段是否存在及cache_write_tokens。
- Same-first与new-first各两组。主要比较各组首个续接；同组第二臂是有序重放，不是独立样本。此样本量不足以证明生产稳定性、热指标、p99或WebSocket/并发安全。

## Execution log

- Dry `PI_OFFLINE=1 node /tmp/epi-session-cache-ab.mjs --dry`: passed，0 requests，数量/时间预算拒绝、body/prefix/header变量断言及关闭通过；artifact `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-session-cache-ab-WTpv7D/report.json`。
- This protocol test does not alter session IDs of any live root or child. Native fork integration and unsafe production identity sharing are not under test.

## Final result

Bounded experiment completed with16 actual HTTP200 responses in66282ms. All four parent warm controls positive. Actual request-body/prefix/hash invariants passed both before-send and independent offline verification. Resources closed; no product edits or additional inference after the16-request limit.

| Fixture | Parent cold | Parent warm | First continuation | Second continuation |
| --- | ---: | ---: | --- | --- |
| 1 | 0 | 7936 | same: 7936 | new: 0 |
| 2 | 0 | 7936 | new: 0 | same: 0 |
| 3 | 0 | 7936 | same: 7936 | new: 0 |
| 4 | 0 | 7936 | new: 0 | same: 7936 |

Values are raw cached_tokens, all fields explicitly present. All cache_write_tokens fields are present; this run reported0. Parent input8121–8191 tokens, continuation8152–8222. Across continuation arms same-session3/4 hit, new-session0/4; among the first continuations only, same-session2/2 hit and new-session0/2. These fractions describe this small sample, not production rate estimates.

### Interpretation

- **Measured:** Four positive warm controls; shared key and identical continuation wire bodies; same-session headers exactly equal to parent; new-session headers differ only in session-id/x-client-request-id; other headers (including authorization/account) have identical hash. Both orders tested twice. First same-session continuations reuse7936 cached tokens without any previous continuation request for that fixture; first new-session continuations both report0.
- **Supported inference:** Switching the transport session identity is an important candidate cause of reduced parent-cache reuse on this tested Luna/Codex path. The user's ordinary-session high-hit observation is consistent with this experiment. It is no longer appropriate to dismiss identity influence by citing later child-self-warming hits or generic Provider volatility.
- **Not established:** Individual responsibility of session-id versus x-client-request-id; server implementation (routing/affinity/cache partition/write timing); a universal necessary/sufficient session rule; native multi-agent concurrency safety. Fixture2 same-session second arm also misses, so preserving identity is not itself a guaranteed-hit mechanism.
- **Prior evidence reconciliation:** Earlier key-only experiment had no same-vs-new transport control; a repeatedly queried independent child can reuse its own cache without proving reuse of the parent's entry. That evidence did not exclude transport identity effects on the first continuation. This experiment is narrower and more discriminating, not a retroactive claim that all previous misses have one proven cause.
- **Recommendation:** Do not automatically share production parent/child IDs. Next causal test would separate the two identity headers; any proposed product fix must preserve independent native sessions and demonstrate no concurrent response/session cross-talk. No such extra calls or implementation are authorized by this completed budget. Shared cache key alone was held constant here and did not prevent all new-session misses.

### Evidence and verification

- Directory: `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-session-cache-ab-21QUCT`.
- Files retained: report.json, events.jsonl, request-1.json through request-16.json, summary.json. Full request bodies contain only this run's synthetic input and generated responses. Credentials remain memory-only, headers are hashes.
- report.json SHA256: `90048e2b6b703a4ac8fb272473de824a60b771fc68de03f1131e510b79e6377b`.
- Start1789117781204; original deadline1789118381204; end1789117847486.16 requests, no retry, all200, shutdown=true. Budget is closed.
- Raw usage totals: input130764 (including55552 cached), output673, total131437. Not a billing estimate or latency-benefit claim.
- Independent offline check verified contiguous16 attempts, all raw cache field presence, model/max/store, complete parent replay identity, complete continuation-body equality, prefix preservation, fixed cache key, nonidentity header equality, and exactly the two intended changed identity headers. Process check found no remaining diagnostic Node.
- Temporary harness and offline verification script removed after verification; retained synthetic evidence and logs. LEARNS.md not edited under diagnosis-only scope.
