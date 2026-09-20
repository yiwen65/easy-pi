import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface InputPin {
	paths: readonly string[];
	sha256: string;
}

/** Hash relative filename + NUL + file SHA-256 + LF, sorted by filename. No symlinks. */
export function verifyInputTree(root: string, pin: InputPin): void {
	const files = new Map<string, string>();
	const visit = (path: string): void => {
		if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) {
			throw new Error(`Invalid native input path: ${path}`);
		}
		let fullPath = root;
		for (const part of path.split("/")) {
			fullPath = join(fullPath, part);
			if (lstatSync(fullPath).isSymbolicLink()) throw new Error(`Native input is a symlink: ${fullPath}`);
		}
		const stat = lstatSync(fullPath);
		if (stat.isDirectory()) {
			for (const name of readdirSync(fullPath).sort()) visit(`${path}/${name}`);
		} else if (stat.isFile()) {
			files.set(path, createHash("sha256").update(readFileSync(fullPath)).digest("hex"));
		} else {
			throw new Error(`Native input is not a regular file/directory: ${fullPath}`);
		}
	};
	for (const path of pin.paths) visit(path);
	const hash = createHash("sha256");
	for (const path of [...files.keys()].sort()) hash.update(`${path}\0${files.get(path)}\n`);
	if (hash.digest("hex") !== pin.sha256) throw new Error(`Native input integrity mismatch: ${root}`);
}
