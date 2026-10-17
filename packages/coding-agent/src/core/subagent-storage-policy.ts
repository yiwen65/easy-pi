/** Global operator policy. Zero disables a time/byte threshold; GC requires explicit opt-in. */
export interface SubagentStorageSettings {
	autoGc?: boolean;
	maxAgeDays?: number;
	maxTeamBytes?: number;
	maxTotalBytes?: number;
	logMaxAgeDays?: number;
	logMaxTotalBytes?: number;
}

export interface SubagentStoragePolicy {
	autoGc: boolean;
	maxAgeDays: number;
	maxTeamBytes: number;
	maxTotalBytes: number;
	logMaxAgeDays: number;
	logMaxTotalBytes: number;
}

const DAY_MS = 86_400_000;

/** Reject malformed destructive policy rather than silently enabling or weakening it. */
export function parseSubagentStoragePolicy(value: unknown): SubagentStoragePolicy {
	const policy: SubagentStoragePolicy = {
		autoGc: false,
		maxAgeDays: 0,
		maxTeamBytes: 0,
		maxTotalBytes: 0,
		logMaxAgeDays: 0,
		logMaxTotalBytes: 0,
	};
	if (value === undefined) return policy;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid subagentStorage setting: expected an object");
	}
	for (const [key, setting] of Object.entries(value)) {
		if (!Object.hasOwn(policy, key)) throw new Error(`Invalid subagentStorage setting: unknown field ${key}`);
		if (key === "autoGc") {
			if (typeof setting !== "boolean") throw new Error("Invalid subagentStorage.autoGc: expected boolean");
			policy.autoGc = setting;
		} else {
			if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < 0) {
				throw new Error(`Invalid subagentStorage.${key}: expected a non-negative safe integer`);
			}
			if ((key === "maxAgeDays" || key === "logMaxAgeDays") && !Number.isSafeInteger(setting * DAY_MS)) {
				throw new Error(`Invalid subagentStorage.${key}: duration overflows milliseconds`);
			}
			policy[key as Exclude<keyof SubagentStoragePolicy, "autoGc">] = setting;
		}
	}
	return policy;
}

export function storageDaysToMs(days: number): number {
	return days * DAY_MS;
}
