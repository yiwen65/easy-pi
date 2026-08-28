import type { ExecutionEnv } from "../types.ts";

const queues = new WeakMap<ExecutionEnv, Promise<void>>();

/** Serialize all v2 edit commits for one execution environment. */
export async function withV2MutationCoordinator<T>(env: ExecutionEnv, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(env) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	queues.set(env, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (queues.get(env) === tail) queues.delete(env);
	}
}
