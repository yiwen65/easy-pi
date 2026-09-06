import { describe, expect, it } from "vitest";
import {
	classifyRetryReason,
	decideRetry,
	MAX_RETRY_FEEDBACK_CHARS,
	type RetryDisposition,
	retryDelayMs,
} from "../src/retry-policy.ts";
import type { TaskTerminalReason } from "../src/types.ts";

describe("retry policy", () => {
	it("classifies every current terminal reason explicitly", () => {
		const expected = {
			completed: "terminal",
			model_error: "transient",
			process_error: "transient",
			protocol_error: "repairable",
			invalid_handoff: "repairable",
			timeout: "transient",
			cancelled: "terminal",
			budget_exhausted: "terminal",
			transport_limit: "repairable",
			loop_detected: "repairable",
			validation_failed: "repairable",
			invalid_focus_path: "terminal",
			path_violation: "repairable",
			task_rejected: "terminal",
			task_inconclusive: "terminal",
			dependency_failed: "terminal",
			retry_exhausted: "terminal",
			merge_conflict: "terminal",
			provider_circuit_open: "terminal",
			interrupted: "transient",
		} satisfies Record<TaskTerminalReason, RetryDisposition>;

		for (const [reason, disposition] of Object.entries(expected)) {
			expect(classifyRetryReason(reason)).toBe(disposition);
		}
	});

	it("fails closed for unknown future or malformed reasons", () => {
		expect(classifyRetryReason("future_reason")).toBe("terminal");
		expect(classifyRetryReason(undefined)).toBe("terminal");
		expect(classifyRetryReason({ reason: "process_error" })).toBe("terminal");
		expect(decideRetry({ reason: "future_reason", error: "try again" })).toEqual({
			disposition: "terminal",
			shouldRetry: false,
		});
	});

	it.each(["model_error", "process_error", "timeout", "interrupted"] as const)(
		"retries transient %s without model-facing repair instructions",
		(reason) => {
			expect(decideRetry({ reason, error: "temporary failure" })).toEqual({
				disposition: "transient",
				shouldRetry: true,
			});
		},
	);

	it.each([
		"Child model stopped with error: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)",
		"Child model stopped with error: ECONNRESET before secure TLS connection was established",
		"Codex error: Our servers are currently overloaded. Please try again later.",
		"503 service unavailable",
		"599 server error",
	])("marks provider availability failure as an unlimited infrastructure retry: %s", (error) => {
		expect(decideRetry({ reason: "model_error", error })).toEqual({
			disposition: "transient",
			shouldRetry: true,
			unlimited: true,
		});
	});

	it("does not make ordinary model failures or rate limits unlimited", () => {
		for (const error of ["Model returned an invalid response", "429 rate limit exceeded"]) {
			expect(decideRetry({ reason: "model_error", error })).toEqual({
				disposition: "transient",
				shouldRetry: true,
			});
		}
	});

	it("recognizes a network diagnostic wrapped as a child process error", () => {
		expect(
			decideRetry({ reason: "process_error", error: "Child Pi exited: fetch failed (ECONNRESET)" }),
		).toMatchObject({
			shouldRetry: true,
			unlimited: true,
		});
	});

	it("fails closed for deterministic process configuration errors", () => {
		expect(decideRetry({ reason: "process_error", error: "spawn pi-child ENOENT" })).toEqual({
			disposition: "terminal",
			shouldRetry: false,
		});
		expect(decideRetry({ reason: "process_error", error: "unsupported runtime option" }).shouldRetry).toBe(false);
	});

	it("uses deterministic bounded exponential delay only for transient retries", () => {
		const transient = decideRetry({ reason: "model_error", error: "provider unavailable" });
		const first = retryDelayMs(transient, 1, "run\0task");
		const second = retryDelayMs(transient, 2, "run\0task");
		expect(first).toBeGreaterThanOrEqual(800);
		expect(first).toBeLessThanOrEqual(1_200);
		expect(second).toBeGreaterThan(first);
		expect(retryDelayMs(transient, 20, "run\0task")).toBeLessThanOrEqual(72_000);
		expect(retryDelayMs(decideRetry({ reason: "validation_failed" }), 1, "run\0task")).toBe(0);
	});

	it.each([
		"completed",
		"cancelled",
		"budget_exhausted",
		"invalid_focus_path",
		"task_rejected",
		"task_inconclusive",
		"dependency_failed",
		"retry_exhausted",
		"merge_conflict",
	] as const)("does not blindly retry terminal %s", (reason) => {
		expect(decideRetry({ reason, error: "try again" })).toEqual({
			disposition: "terminal",
			shouldRetry: false,
		});
	});

	it("creates bounded, control-free feedback for repairable failures", () => {
		const decision = decideRetry({
			reason: "invalid_handoff",
			error: "\u001b]0;hostile\u0007bad\n\tfield\u202E".repeat(30),
			maxFeedbackChars: 180,
		});

		expect(decision.disposition).toBe("repairable");
		expect(decision.shouldRetry).toBe(true);
		expect(decision.feedback).toContain("invalid_handoff");
		expect(decision.feedback).toContain("untrusted data");
		expect(decision.feedback?.length).toBeLessThanOrEqual(180);
		expect(decision.feedback).not.toMatch(/[\p{Cc}\p{Cf}]/u);
	});

	it("enforces the controller ceiling and safely renders hostile diagnostics", () => {
		const oversized = decideRetry({
			reason: "validation_failed",
			error: "x".repeat(MAX_RETRY_FEEDBACK_CHARS * 2),
			maxFeedbackChars: MAX_RETRY_FEEDBACK_CHARS * 10,
		});
		expect(oversized.feedback).toHaveLength(MAX_RETRY_FEEDBACK_CHARS);

		const hostile = decideRetry({
			reason: "validation_failed",
			error: {
				toString() {
					throw new Error("hostile coercion");
				},
			},
		});
		expect(hostile.feedback).toContain("could not be rendered");
	});

	it.each(["protocol_error", "transport_limit", "loop_detected", "validation_failed", "path_violation"] as const)(
		"provides repair guidance for %s even without a diagnostic",
		(reason) => {
			const decision = decideRetry({ reason });
			expect(decision).toMatchObject({ disposition: "repairable", shouldRetry: true });
			expect(decision.feedback).toContain(reason);
		},
	);
});
