# Interrupted model responses

OpenAI Responses, Azure Responses, and OpenAI Codex responses can recover completed output items after a retryable stream failure. Their adapters explicitly identify completed upstream items; local text-segment endings and best-effort JSON parsing do not authorize recovery.

When a response is interrupted:

1. Save the completed items as an assistant response checkpoint.
2. Execute complete tool calls using the existing sequential or parallel batch policy, after the stream has ended. Save the checkpoint before admitting tool effects, and await tool results before retrying.
3. Save the remaining incomplete content and original failure as a separate assistant message. Its usage accounts for the request; the checkpoint has zero usage.
4. If retry is enabled and its budget remains, remove the failure from active context and request another response using the checkpoint and tool results. Failure artifacts remain in the session transcript.

Checkpoints carry `isResponseCheckpoint: true`. They record completed progress, not a successful model response, and do not reset the retry budget. A text-only checkpoint can be continued without adding another user message. Completed reasoning is retained only with a following completed message or tool call; isolated reasoning remains in the failure artifact.

Calls with incomplete status or invalid final JSON are not recovered, even if a partial argument object can be parsed. Cancellation, quota/billing failures, and output-limit truncation do not execute recovery tools. Output-limit truncation retains its existing error-tool-result handling. Tool admission hooks and batch termination continue to apply.

Providers without an explicit trustworthy item-completion marker retain their existing whole-response retry behavior. There is no token-level stream resumption. A model may request the same operation again, and a process can exit after a tool effect but before its result is saved; this mechanism does not guarantee exactly-once effects or recovery from power loss.
