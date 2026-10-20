import type { SqliteDatabase } from "../sqlite/database.ts";
import type { SqliteMigration } from "../sqlite/migrations.ts";

// The PostgreSQL dialect of the storage schema: same tables, columns, and indexes as the SQLite schema,
// without STRICT tables and json_valid checks. IDs and sequences are BIGINT (parsed to numbers in database.ts).
const INITIAL_SCHEMA: readonly string[] = [
	`CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq BIGINT NOT NULL
	)`,
	`INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
	`CREATE TABLE record_ids (
		id BIGINT PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	)`,
	`CREATE TABLE conversations (
		id BIGINT PRIMARY KEY,
		owner_conversation_id BIGINT,
		owner_task_id BIGINT,
		record TEXT NOT NULL
	)`,
	"CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
	"CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
	`CREATE TABLE entries (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		head BIGINT,
		commit_seq BIGINT NOT NULL,
		record TEXT NOT NULL
	)`,
	"CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
	"CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
	`CREATE TABLE tasks (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL
	)`,
	"CREATE INDEX tasks_by_status ON tasks (status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (background, id)",
	`CREATE TABLE submissions (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL
	)`,
	"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (status, id)",
	`CREATE TABLE documents (
		id BIGINT PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id BIGINT NOT NULL,
		created_at BIGINT NOT NULL,
		retired_at BIGINT,
		record TEXT NOT NULL
	)`,
	`CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
	"CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
	"CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
	`CREATE TABLE document_revisions (
		document_id BIGINT NOT NULL,
		seq BIGINT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version BIGINT NOT NULL,
		content TEXT NOT NULL,
		PRIMARY KEY (document_id, seq)
	)`,
	"CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
];

/** PostgreSQL dialect of the SQLite schema's version 2: sleeping tasks. PostgreSQL alters the check in place. */
const SLEEPING_TASK_STATUS: readonly string[] = [
	"ALTER TABLE tasks DROP CONSTRAINT tasks_status_check",
	`ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
		CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'))`,
];

/** Immutable, ordered PostgreSQL schema history; version numbers track the SQLite schema's. */
export const PG_MIGRATIONS: readonly SqliteMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA },
	{ version: 2, statements: SLEEPING_TASK_STATUS },
];

type SchemaRow = { readonly version: number };

/** Apply pending PostgreSQL schema migrations atomically, mirroring the SQLite runner's rules. */
export async function applyPgMigrations(database: SqliteDatabase): Promise<void> {
	for (let index = 0; index < PG_MIGRATIONS.length; index++) {
		if (PG_MIGRATIONS[index]?.version !== index + 1) {
			throw new Error("Durable PostgreSQL migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version BIGINT NOT NULL CHECK (version >= 0)
		)`);
		await transaction.run(
			"INSERT INTO durable_schema (singleton, version) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING",
		);
		const row = await transaction.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1");
		if (row === undefined) throw new Error("Durable PostgreSQL schema metadata is missing");
		const currentVersion = PG_MIGRATIONS.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(
				`Durable PostgreSQL schema version ${row.version} is newer than supported version ${currentVersion}`,
			);
		}
		for (const migration of PG_MIGRATIONS) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run("UPDATE durable_schema SET version = ? WHERE singleton = 1", migration.version);
		}
	});
}
