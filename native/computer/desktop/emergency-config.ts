/** Physical macOS keys; deliberately excludes layout-produced symbols and modifier-only keys. */
export function parseEmergencyChord(binding: string | readonly string[]): {
	key: string;
	modifiers: Array<"Control" | "Option" | "Shift" | "Command">;
} {
	const keys = typeof binding === "string" ? [binding] : binding;
	if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== "string")
		throw new Error("Computer emergency stop requires exactly one nonempty binding");
	const parts = keys[0].toLowerCase().split("+");
	const key = parts.pop()!;
	if (
		!/^(?:[a-z0-9]|[=\-[\]\\;',./`]|escape|esc|enter|return|tab|space|backspace|delete|home|end|pageup|pagedown|up|down|left|right|f[1-9]|f1[0-2])$/.test(
			key,
		)
	)
		throw new Error("Unsupported Computer emergency physical key");
	const modifiers: Array<"Control" | "Option" | "Shift" | "Command"> = [];
	for (const part of parts) {
		const modifier =
			part === "ctrl"
				? "Control"
				: part === "alt"
					? "Option"
					: part === "shift"
						? "Shift"
						: part === "super"
							? "Command"
							: undefined;
		if (!modifier || modifiers.includes(modifier))
			throw new Error("Unsupported or duplicate Computer emergency modifier");
		modifiers.push(modifier);
	}
	if (!modifiers.length) throw new Error("Computer emergency stop requires a modifier");
	// TUI delete means forward delete; native delete is the physical Backspace key.
	return { key: key === "delete" ? "forward_delete" : key, modifiers };
}
