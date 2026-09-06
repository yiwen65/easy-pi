import { CollaborationError, type CollaborationResults, collaborationWaitMs } from "./collaboration-contract.ts";

type WaitResult = CollaborationResults["wait_agent"];

/** Activity only; message truth lives in the transactional team snapshot. No polling or task cancellation. */
export class CollaborationMailboxActivity {
	private readonly waiters = new Map<string, { check: () => void; cancel: () => void }>();
	private readonly userInput = new Set<string>();
	private closed = false;

	notify(path: string): void {
		this.waiters.get(path)?.check();
	}
	notifyUserInput(path: string): void {
		this.userInput.add(path);
		this.notify(path);
	}
	consumeUserInput(path: string): void {
		this.userInput.delete(path);
	}

	wait(path: string, pending: () => boolean, timeout?: number, signal?: AbortSignal): Promise<WaitResult> {
		const milliseconds = collaborationWaitMs(timeout);
		if (this.closed || signal?.aborted)
			return Promise.reject(new CollaborationError("interrupted", "Mailbox wait interrupted"));
		if (this.waiters.has(path)) return Promise.reject(new CollaborationError("busy", "Agent is already waiting"));
		return new Promise((resolve, reject) => {
			const finish = (result?: WaitResult, error?: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				this.waiters.delete(path);
				if (error) reject(error);
				else resolve(result!);
			};
			const cancel = () => finish(undefined, new CollaborationError("interrupted", "Mailbox wait interrupted"));
			const check = () =>
				queueMicrotask(() => {
					if (this.waiters.get(path)?.cancel !== cancel) return;
					try {
						if (this.userInput.has(path)) finish({ reason: "user_input", timed_out: false });
						else if (pending()) finish({ reason: "mailbox", timed_out: false });
					} catch (error) {
						finish(undefined, error);
					}
				});
			const timer = setTimeout(() => finish({ reason: "timeout", timed_out: true }), milliseconds);
			this.waiters.set(path, { check, cancel });
			signal?.addEventListener("abort", cancel, { once: true });
			check();
		});
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.values()) waiter.cancel();
		this.userInput.clear();
	}
}
