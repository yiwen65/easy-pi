export {
	BackgroundTaskManager,
	type BackgroundTaskManagerOptions,
	type BackgroundTaskOutput,
	type BackgroundTaskRecord,
	type BackgroundTaskStatus,
	DEFAULT_BACKGROUND_TIMEOUT_MS,
	DEFAULT_STOP_GRACE_MS,
	isTerminalTaskStatus,
} from "./harness/env/background-task-manager.ts";
export {
	killNodeProcessTree,
	type NodeProcessExecutionOptions,
	type NodeProcessExecutionResult,
	NodeProcessExecutor,
	type NodeProcessExecutorOptions,
	type NodeProcessShellConfig,
	terminateNodeProcessTree,
} from "./harness/env/node-process-executor.ts";
export { NodeExecutionEnv, type NodeExecutionEnvOptions } from "./harness/env/nodejs.ts";
export * from "./index.ts";
