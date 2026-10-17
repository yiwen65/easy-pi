import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../../src/sqlite/migrations.ts";
import type { SqliteDatabase, SqliteStatement } from "../../src/sqlite/types.ts";

// Load migration source directly: this subprocess must not depend on built workspace exports.
const raw = new DatabaseSync(process.argv[2]!);
const db: SqliteDatabase = {
	exec: (sql) => raw.exec(sql),
	// Migrations only bind strings and ignore run results; native statements implement those operations.
	prepare: (sql) => raw.prepare(sql) as unknown as SqliteStatement,
	transaction(fn) {
		raw.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			raw.exec("COMMIT");
			return result;
		} catch (error) {
			raw.exec("ROLLBACK");
			throw error;
		}
	},
	close: () => raw.close(),
};
try {
	await applyMigrations(db);
} finally {
	db.close();
}
