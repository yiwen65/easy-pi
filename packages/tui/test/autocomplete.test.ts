import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const resolveFdPath = (): string | null => {
	const command = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout) {
		return null;
	}

	const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
	return firstLine ? firstLine.trim() : null;
};

type FolderStructure = {
	dirs?: string[];
	files?: Record<string, string>;
};

const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	const dirs = structure.dirs ?? [];
	const files = structure.files ?? {};

	dirs.forEach((dir) => {
		mkdirSync(join(baseDir, dir), { recursive: true });
	});
	Object.entries(files).forEach(([filePath, contents]) => {
		const fullPath = join(baseDir, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, contents);
	});
};

const fdPath = resolveFdPath();
const isFdInstalled = Boolean(fdPath);

const requireFdPath = (): string => {
	if (!fdPath) {
		throw new Error("fd is not available");
	}
	return fdPath;
};

const getSuggestions = (
	provider: CombinedAutocompleteProvider,
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	force: boolean = false,
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for root directory");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				assert.strictEqual(result.prefix, "/A", "Prefix should be '/A'");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.strictEqual(result, null, "Should not trigger for slash commands");
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.notEqual(result, null, "Should trigger for absolute paths in command arguments");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});
	});

	describe("CJK file boundaries", () => {
		let baseDir = "";
		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-boundaries-"));
		});
		afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

		test("recognizes @ after CJK punctuation without consuming prose", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["查看，", "\u3000", ..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】"]) {
				for (const force of [false, true]) {
					const line = `${before}@REA 后文`;
					const cursorCol = before.length + "@REA".length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "@REA");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["@README.md"],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}@README.md  后文`);
					assert.strictEqual(applied.cursorCol, `${before}@README.md `.length);
				}
			}
		});

		test("preserves CJK letters and embedded @ in attachment paths", async () => {
			setupFolder(baseDir, { files: { "文档/说明.md": "text", "文档@备份/说明.md": "backup" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["", "查看，"]) {
				for (const directory of ["文档", "文档@备份"]) {
					const prefix = `@${directory}/说`;
					const line = before + prefix;
					const result = await getSuggestions(provider, [line], 0, line.length);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[`@${directory}/说明.md`],
					);
				}
			}
		});

		test("does not interpret email or @ after ASCII or CJK letters as attachments", async () => {
			setupFolder(baseDir, { files: { "README.md": "text", "example.com": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["user", "查看", "あ", "カ", "한", "ㄅ", "𠮷", "か\u3099", "禰\u{e0100}", "々", "Ａ"]) {
				for (const name of ["REA", "example.com"]) {
					const line = `${before}@${name}`;
					assert.strictEqual(await getSuggestions(provider, [line], 0, line.length), null, line);
				}
			}
		});

		test("quotes separator-containing directories and continues at the closing quote", async () => {
			// Windows filenames cannot contain literal tabs.
			for (const separator of [" ", ...(process.platform === "win32" ? [] : ["\t"]), "\u3000", "，", "。"]) {
				const directory = `my${separator}folder`;
				setupFolder(baseDir, { files: { [`${directory}/test.txt`]: "text" } });
				const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
				for (const marker of ["", "@"]) {
					const line = `${marker}my`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result);
					const item = result.items.find((entry) => entry.value === `${marker}"${directory}/"`);
					assert.ok(item, directory);
					const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
					assert.strictEqual(applied.cursorCol, applied.lines[0]!.length - 1);
					const continued = await getSuggestions(provider, applied.lines, 0, applied.cursorCol, true);
					assert.ok(continued);
					assert.strictEqual(continued.prefix, `${marker}"${directory}/`);
					assert.deepStrictEqual(
						continued.items.map((entry) => entry.value),
						[`${marker}"${directory}/test.txt"`],
					);
				}
			}
		});

		test("completes quoted CJK paths after prose without duplicating quotes", async () => {
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `我的${separator}文档`;
				setupFolder(baseDir, { files: { [`${directory}/说明.md`]: "text", "文档/说明.md": "other" } });
				const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
				for (const marker of ["", "@"]) {
					const before = "查看：";
					const line = `${before}${marker}"${directory}/说"后文`;
					const cursorCol = line.indexOf('"后文');
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, `${marker}"${directory}/说`);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[`${marker}"${directory}/说明.md"`],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					const suffix = marker ? " " : "";
					assert.strictEqual(applied.lines[0], `${before}${marker}"${directory}/说明.md"${suffix}后文`);
					assert.strictEqual(applied.cursorCol, `${before}${marker}"${directory}/说明.md"${suffix}`.length);
				}
			}
		});

		test("completes Chinese paths after separators with an exact prefix and caret", async () => {
			setupFolder(baseDir, { files: { "说明.md": "text", "文档/说明.md": "nested" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of " \t\u3000\u00a0，：；。！？（「《") {
				for (const [prefix, value] of [
					["说", "说明.md"],
					["文", "文档/"],
					["文档/说", "文档/说明.md"],
					["./文档/说", "./文档/说明.md"],
				] as const) {
					const before = `查看𠮷${separator}`;
					const line = `${before}${prefix} 后文`;
					const cursorCol = before.length + prefix.length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
					assert.strictEqual(applied.cursorCol, before.length + value.length);
				}
			}
		});

		test("unquoted separators end paths even when literal names exist", async () => {
			setupFolder(baseDir, { files: { "归档/说明.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\u3000", "，", "。"]) {
				const directory = `资料${separator}归档`;
				setupFolder(baseDir, { files: { [`${directory}/说明.md`]: "archive" } });
				for (const marker of ["", "@"]) {
					const line = `${marker}${directory}/说`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result);
					assert.strictEqual(result.prefix, "归档/说");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["归档/说明.md"],
					);
				}
				const missing = `查看，"不存在${separator}归档/说`;
				assert.strictEqual(await getSuggestions(provider, [missing], 0, missing.length, true), null);
			}
		});

		test("handles empty prefixes after separators but not empty natural input", async () => {
			setupFolder(baseDir, { files: { "说明.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\t", "\u3000", "，", "。"]) {
				for (const force of [false, true]) {
					const line = `查看${separator}`;
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["说明.md"],
					);
				}
			}
			assert.strictEqual(await getSuggestions(provider, [""], 0, 0), null);
		});

		test("recognizes @ after opening wrappers with an exact replacement prefix", async () => {
			setupFolder(baseDir, { files: { "README.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["(", "see (", "[", "`", "<", "{", "((", "(`", "查看，("]) {
				const line = `${before}@REA)后文`;
				const cursorCol = before.length + "@REA".length;
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, "@REA");
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					["@README.md"],
				);
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `${before}@README.md )后文`);
				assert.strictEqual(applied.cursorCol, `${before}@README.md `.length);
			}
			for (const line of ["foo(@REA", "查看(@REA", 'foo(@"REA']) {
				assert.strictEqual(await getSuggestions(provider, [line], 0, line.length), null, line);
			}
		});

		test("completes paths after opening wrappers without replacing the wrappers", async () => {
			setupFolder(baseDir, { files: { "src/main.ts": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const wrapper of ["(", "[", "{", "<", "`", "((", "(`"]) {
				for (const prefix of [
					"src/ma",
					"./src/ma",
					...(process.platform === "win32" ? [] : [`${baseDir}/src/ma`]),
				]) {
					const before = `see ${wrapper}`;
					const line = `${before}${prefix} 后文`;
					const cursorCol = before.length + prefix.length;
					for (const force of [false, true]) {
						const result = await getSuggestions(provider, [line], 0, cursorCol, force);
						assert.ok(result, line);
						assert.strictEqual(result.prefix, prefix);
						const value = prefix.replace("src/ma", "src/main.ts");
						assert.deepStrictEqual(
							result.items.map((item) => item.value),
							[value],
						);
						const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
						assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
						assert.strictEqual(applied.cursorCol, before.length + value.length);
					}
				}
			}
		});

		test("completes wrapped quoted paths and directories while preserving quote carets", async () => {
			setupFolder(baseDir, { files: { "my dir/main.ts": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const wrapper of ["(", "[", "{", "<", "`", "(`"]) {
				for (const marker of ["", "@"]) {
					const before = `see ${wrapper}`;
					const line = `${before}${marker}"my dir/ma")后文`;
					const cursorCol = line.indexOf('")后文');
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, `${marker}"my dir/ma`);
					const value = `${marker}"my dir/main.ts"`;
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					const suffix = marker ? " " : "";
					assert.strictEqual(applied.lines[0], `${before}${value}${suffix})后文`);
					assert.strictEqual(applied.cursorCol, before.length + value.length + suffix.length);

					const directoryLine = `${before}${marker}"my`;
					const directories = await getSuggestions(provider, [directoryLine], 0, directoryLine.length, true);
					assert.ok(directories);
					assert.strictEqual(directories.prefix, `${marker}"my`);
					const directory = directories.items.find((item) => item.label === "my dir/");
					assert.ok(directory);
					const completedDir = provider.applyCompletion(
						[directoryLine],
						0,
						directoryLine.length,
						directory,
						directories.prefix,
					);
					assert.strictEqual(completedDir.lines[0], `${before}${marker}"my dir/"`);
					assert.strictEqual(completedDir.cursorCol, completedDir.lines[0]!.length - 1);
					const continued = await getSuggestions(provider, completedDir.lines, 0, completedDir.cursorCol, true);
					assert.ok(continued);
					assert.strictEqual(continued.prefix, `${marker}"my dir/`);
					assert.deepStrictEqual(
						continued.items.map((item) => item.value),
						[value],
					);
				}
			}
		});

		test("keeps actual closed wrappers inside directory names", async () => {
			setupFolder(baseDir, {
				files: { "[slug]/page.tsx": "text", "(group)/layout.tsx": "text", "app/[slug]/page.tsx": "text" },
			});
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const [prefix, value] of [
				["[slug]/pa", "[slug]/page.tsx"],
				["(group)/la", "(group)/layout.tsx"],
				["./[slug]/pa", "./[slug]/page.tsx"],
				["app/[slug]/pa", "app/[slug]/page.tsx"],
			] as const) {
				for (const marker of ["", "@"]) {
					const line = `see ${marker}${prefix}`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, marker + prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[marker + value],
					);
					const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `see ${marker}${value}${marker ? " " : ""}`);
				}
			}
		});

		test("prefers literal partial wrapper names over unwrapped filesystem candidates", async () => {
			setupFolder(baseDir, {
				files: {
					"[slug]/page.tsx": "literal",
					"slug/page.tsx": "unwrapped",
					"(group)/layout.tsx": "literal",
					"group/layout.tsx": "unwrapped",
					"[my dir]/index.ts": "quoted literal",
					"my dir/index.ts": "unwrapped",
					"[notes.md": "literal file",
					"notes.md": "unwrapped file",
				},
			});
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const [prefix, value] of [
				["[sl", "[slug]/"],
				["(gr", "(group)/"],
				["[my", '"[my dir]/"'],
				["[no", "[notes.md"],
			] as const) {
				for (const before of ["", "see ", "查看，", "see (", "see `"]) {
					const line = `${before}${prefix} 后文`;
					const cursorCol = before.length + prefix.length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix, line);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
						line,
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value} 后文`, line);
					const quoteOffset = value.endsWith('"') ? 1 : 0;
					assert.strictEqual(applied.cursorCol, before.length + value.length - quoteOffset, line);
				}
			}
		});

		test("prefers a literal opener but falls back to prose wrappers without literal matches", async () => {
			setupFolder(baseDir, { dirs: ["[slug]", "slug", "(group)", "group"] });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const [prefix, value] of [
				["[", "[slug]/"],
				["(", "(group)/"],
			] as const) {
				const line = `see ${prefix}`;
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				assert.ok(result);
				assert.strictEqual(result.prefix, prefix);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[value],
				);
				const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `see ${value}`);
				assert.strictEqual(applied.cursorCol, applied.lines[0]!.length);
			}
			for (const prefix of ["[gr", "`gr", "((sl"]) {
				const line = `see ${prefix} 后文`;
				const cursorCol = `see ${prefix}`.length;
				const result = await getSuggestions(provider, [line], 0, cursorCol, true);
				assert.ok(result);
				const unwrapped = prefix.endsWith("gr") ? "gr" : "sl";
				const value = unwrapped === "gr" ? "group/" : "slug/";
				assert.strictEqual(result.prefix, unwrapped);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[value],
				);
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				const before = line.slice(0, cursorCol - unwrapped.length);
				assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
				assert.strictEqual(applied.cursorCol, before.length + value.length);
			}
		});

		test("keeps wrapped attachment triggers distinct from partial literal directories", async () => {
			setupFolder(baseDir, { dirs: ["[slug]", "(group)"], files: { "README.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const wrapper of ["[", "(", "([", "`("]) {
				for (const force of [false, true]) {
					const line = `see ${wrapper}@REA 后文`;
					const cursorCol = `see ${wrapper}@REA`.length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, force);
					assert.ok(result);
					assert.strictEqual(result.prefix, "@REA");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["@README.md"],
					);
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					assert.strictEqual(applied.lines[0], `see ${wrapper}@README.md  后文`);
					assert.strictEqual(applied.cursorCol, `see ${wrapper}@README.md `.length);
				}
			}
		});

		test("descends into literal paired directories after completing nested wrappers", async () => {
			setupFolder(baseDir, {
				files: {
					"(group)/layout.tsx": "text",
					"[slug]/page.tsx": "text",
					"{area}/main.ts": "text",
					"`route`/index.ts": "text",
				},
			});
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const [wrapper, partial, directory, file] of [
				["(", "(gr", "(group)/", "(group)/layout.tsx"],
				["[", "[sl", "[slug]/", "[slug]/page.tsx"],
				["{", "{ar", "{area}/", "{area}/main.ts"],
				["(", "[sl", "[slug]/", "[slug]/page.tsx"],
				["[", "(gr", "(group)/", "(group)/layout.tsx"],
				["`", "[sl", "[slug]/", "[slug]/page.tsx"],
				["(", "`ro", "`route`/", "`route`/index.ts"],
			] as const) {
				const before = `see ${wrapper}`;
				const line = before + partial;
				const first = await getSuggestions(provider, [line], 0, line.length, true);
				assert.ok(first, line);
				assert.strictEqual(first.prefix, partial);
				assert.deepStrictEqual(
					first.items.map((item) => item.value),
					[directory],
				);
				const entered = provider.applyCompletion([line], 0, line.length, first.items[0]!, first.prefix);
				assert.strictEqual(entered.lines[0], before + directory);
				assert.strictEqual(entered.cursorCol, before.length + directory.length);
				for (const force of [true, false]) {
					const second = await getSuggestions(provider, entered.lines, 0, entered.cursorCol, force);
					assert.ok(second, `second completion: ${entered.lines[0]}`);
					assert.strictEqual(second.prefix, directory);
					assert.deepStrictEqual(
						second.items.map((item) => item.value),
						[file],
					);
					const completed = provider.applyCompletion(
						entered.lines,
						0,
						entered.cursorCol,
						second.items[0]!,
						second.prefix,
					);
					assert.strictEqual(completed.lines[0], before + file);
					assert.strictEqual(completed.cursorCol, before.length + file.length);
				}
			}
		});

		test("recognizes wrapped attachments whose literal directories contain paired wrappers", async () => {
			setupFolder(baseDir, { files: { "(group)/layout.tsx": "text", "[slug]/page.tsx": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const [wrapper, prefix, value] of [
				["(", "@(group)/la", "@(group)/layout.tsx"],
				["[", "@[slug]/pa", "@[slug]/page.tsx"],
				["([", "@[slug]/pa", "@[slug]/page.tsx"],
			] as const) {
				const before = `see ${wrapper}`;
				const line = `${before}${prefix} 后文`;
				const cursorCol = before.length + prefix.length;
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, prefix);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[value],
				);
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `${before}${value}  后文`);
				assert.strictEqual(applied.cursorCol, before.length + value.length + 1);
			}
		});

		test("keeps available raw literal directories with nested pairs or self-paired backticks", async () => {
			setupFolder(baseDir, {
				files: {
					"((group)/literal.ts": "raw",
					"(group)/other.ts": "fallback",
					"[[slug]/literal.ts": "raw",
					"[slug]/other.ts": "fallback",
					"((nested))/literal.ts": "balanced",
					"[[nested]]/literal.ts": "balanced",
					"`route`/literal.ts": "self-paired",
					"route/other.ts": "unwrapped",
				},
			});
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const prefix of ["((group)/", "[[slug]/", "((nested))/", "[[nested]]/", "`route`/"]) {
				const line = `see ${prefix} 后文`;
				const cursorCol = `see ${prefix}`.length;
				const result = await getSuggestions(provider, [line], 0, cursorCol, true);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, prefix);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[`${prefix}literal.ts`],
				);
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				assert.strictEqual(applied.lines[0], `see ${prefix}literal.ts 后文`);
				assert.strictEqual(applied.cursorCol, `see ${prefix}literal.ts`.length);
			}
		});

		test("sorts quoted directories before files using labels", async () => {
			setupFolder(baseDir, { dirs: ["z folder", "z，folder"], files: { "a.txt": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await getSuggestions(provider, [""], 0, 0, true);
			assert.ok(result);
			assert.deepStrictEqual(
				result.items.map((item) => item.label.endsWith("/")),
				[true, true, false],
			);
		});
	});

	describe("fd @ file suggestions", { skip: !isFdInstalled }, () => {
		let rootDir = "";
		let baseDir = "";
		let outsideDir = "";

		beforeEach(() => {
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			baseDir = join(rootDir, "cwd");
			outsideDir = join(rootDir, "outside");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(rootDir, { recursive: true, force: true });
		});

		test("returns all files and folders for empty @ query", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			assert.deepStrictEqual(values, ["@README.md", "@src/"].sort());
		});

		test("matches file with extension in query", async () => {
			setupFolder(baseDir, {
				files: {
					"file.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@file.txt";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@file.txt"));
		});

		test("filters are case insensitive", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@re";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			assert.deepStrictEqual(values, ["@README.md"]);
		});

		test("ranks directories before files", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@src";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const firstValue = result?.items[0]?.value;
			const hasSrcFile = result?.items?.some((item) => item.value === "@src.txt");
			assert.strictEqual(firstValue, "@src/");
			assert.ok(hasSrcFile);
		});

		test("returns nested file paths", async () => {
			setupFolder(baseDir, {
				files: {
					"src/index.ts": "export {};\n",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@index";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@src/index.ts"));
		});

		test("matches deeply nested paths", async () => {
			setupFolder(baseDir, {
				files: {
					"packages/tui/src/autocomplete.ts": "export {};",
					"packages/ai/src/autocomplete.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@tui/src/auto";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@packages/tui/src/autocomplete.ts"));
			assert.ok(!values?.includes("@packages/ai/src/autocomplete.ts"));
		});

		test("matches directory in middle of path with --full-path", async () => {
			setupFolder(baseDir, {
				files: {
					"src/components/Button.tsx": "export {};",
					"src/utils/helpers.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@components/";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@src/components/Button.tsx"));
			assert.ok(!values?.includes("@src/utils/helpers.ts"));
		});

		test("scopes fuzzy search to relative directories and searches recursively", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/alpha.ts": "export {};",
					"nested/deeper/also-alpha.ts": "export {};",
					"nested/deeper/zzz.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@../outside/a";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@../outside/nested/alpha.ts"));
			assert.ok(values?.includes("@../outside/nested/deeper/also-alpha.ts"));
			assert.ok(!values?.includes("@../outside/nested/deeper/zzz.ts"));
		});

		test("quotes paths with spaces for @ suggestions", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@my";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('@"my folder/"'));
		});

		test("includes hidden paths but excludes .git", async () => {
			setupFolder(baseDir, {
				dirs: [".pi", ".github", ".git"],
				files: {
					".pi/config.json": "{}",
					".github/workflows/ci.yml": "name: ci",
					".git/config": "[core]",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@.pi/"));
			assert.ok(values.includes("@.github/"));
			assert.ok(!values.some((value) => value === "@.git" || value.startsWith("@.git/")));
		});

		test("follows symlinked directories for fuzzy @ search", async () => {
			setupFolder(baseDir, {
				files: {
					"dir/some_file.txt": "real",
				},
			});
			setupFolder(outsideDir, {
				files: {
					"some_file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@some";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@dir/some_file.txt"));
			assert.ok(values.includes("@symlinked_dir/some_file.txt"));
		});

		test("returns symlinked directories when matching their name", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@symlinked";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@symlinked_dir/"));
		});

		test("returns symlinked files without requiring type l", async () => {
			setupFolder(baseDir, {
				files: {
					"original.txt": "content",
				},
			});
			const linkPath = join(baseDir, "link.txt");
			symlinkSync("original.txt", linkPath);

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@link";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@link.txt"));
		});

		test("returns the same @ suggestions when the cwd path contains the query", async () => {
			const normalBaseDir = join(rootDir, "cwd-normal");
			const queryInPathBaseDir = join(rootDir, "cwd-plan-repro");
			mkdirSync(normalBaseDir, { recursive: true });
			mkdirSync(queryInPathBaseDir, { recursive: true });

			const structure = {
				dirs: ["packages/coding-agent/examples/extensions/plan-mode"],
				files: {
					"packages/coding-agent/examples/extensions/plan-mode/README.md": "readme",
					"packages/tui/docs/plan.md": "plan",
				},
			};
			setupFolder(normalBaseDir, structure);
			setupFolder(queryInPathBaseDir, structure);

			const query = "@plan";
			const normalProvider = new CombinedAutocompleteProvider([], normalBaseDir, requireFdPath());
			const queryInPathProvider = new CombinedAutocompleteProvider([], queryInPathBaseDir, requireFdPath());

			const normalResult = await getSuggestions(normalProvider, [query], 0, query.length);
			const queryInPathResult = await getSuggestions(queryInPathProvider, [query], 0, query.length);

			const normalize = (result: Awaited<ReturnType<typeof getSuggestions>>) =>
				(result?.items ?? []).map((item) => `${item.label} :: ${item.description ?? ""}`).sort();

			assert.deepStrictEqual(normalize(queryInPathResult), normalize(normalResult));
			assert.ok(
				normalize(normalResult).includes("plan-mode/ :: packages/coding-agent/examples/extensions/plan-mode"),
			);
			assert.ok(normalize(normalResult).includes("plan.md :: packages/tui/docs/plan.md"));
		});

		test("continues autocomplete inside quoted @ paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('@"my folder/test.txt"'));
			assert.ok(values?.includes('@"my folder/other.txt"'));
		});

		test("applies quoted @ completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol);

			assert.notEqual(result, null, "Should return suggestions for quoted @ path");
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			assert.ok(item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			assert.strictEqual(applied.lines[0], '@"my folder/test.txt" ');
		});
	});

	describe("dot-slash path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("preserves ./ prefix when completing paths", async () => {
			setupFolder(baseDir, {
				files: {
					"update.sh": "#!/bin/bash",
					"utils.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./update.sh"), `Expected ./update.sh in ${JSON.stringify(values)}`);
		});

		test("preserves ./ prefix for directory completions", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src/index.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ directory path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./src/"), `Expected ./src/ in ${JSON.stringify(values)}`);
		});
	});

	describe("quoted path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("quotes paths with spaces for direct completion", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "my";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for path completion");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('"my folder/"'));
		});

		test("continues completion inside quoted paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1, true);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('"my folder/test.txt"'));
			assert.ok(values?.includes('"my folder/other.txt"'));
		});

		test("applies quoted completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for quoted path");
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			assert.ok(item, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			assert.strictEqual(applied.lines[0], '"my folder/test.txt"');
		});
	});
});
