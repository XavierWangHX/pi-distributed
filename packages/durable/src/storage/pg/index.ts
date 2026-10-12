import { SqliteStorage } from "../sqlite/storage.ts";
import { connectPg, PgDatabase } from "./database.ts";
import { applyPgMigrations } from "./migrations.ts";

export { PgDatabase, connectPg } from "./database.ts";
export { applyPgMigrations, PG_MIGRATIONS } from "./migrations.ts";

export interface OpenPgStorageOptions {
	/**
	 * A PostgreSQL schema name that isolates this session's tables. Created when missing; set as the connection's
	 * search path, so every statement of the storage core addresses it. Omit to use the database's default schema.
	 */
	readonly schema?: string;
}

/**
 * Open the durable storage on a PostgreSQL database. One SQL transaction per Session commit, exactly like the
 * SQLite backend; `connectionString` is anything node-postgres accepts. The storage is single-writer like every
 * durable storage: one process owns it at a time, and PostgreSQL enforces the rest.
 */
export async function openPgStorage(connectionString: string, options: OpenPgStorageOptions = {}): Promise<SqliteStorage> {
	const client = await connectPg(connectionString);
	try {
		if (options.schema !== undefined) {
			await client.query("CREATE SCHEMA IF NOT EXISTS " + quoteIdent(options.schema));
			await client.query("SET search_path TO " + quoteIdent(options.schema));
		}
		return await SqliteStorage.open(new PgDatabase(client), { migrate: applyPgMigrations });
	} catch (error) {
		try {
			await client.end();
		} catch {
			// Preserve the initialization failure.
		}
		throw error;
	}
}

/** A schema name is an identifier, not a value: allow only what cannot leave an identifier's quotes. */
function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid PostgreSQL schema name: ${name}`);
	return `"${name}"`;
}
