/** Clone the plain schema data used by an immutable tool plan. */
export function cloneToolSchema<T>(value: T): T {
	if (Array.isArray(value)) return value.map(cloneToolSchema) as T;
	if (value && typeof value === "object") {
		const clone: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) clone[key] = cloneToolSchema(child);
		return clone as T;
	}
	return value;
}
