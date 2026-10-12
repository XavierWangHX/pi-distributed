import pg from "pg";

// node-postgres returns BIGINT as string; the storage core's IDs and sequences are JavaScript numbers.
pg.types.setTypeParser(20, (value: string): number => Number.parseInt(value, 10));

/** Values this adapter forwards as query parameters. */
export type PgValue = null | number | string | bigint | Uint8Array;

/** One `?` placeholder per parameter: rewrite to PostgreSQL's `$n`. */
function placeholders(sql: string): string {
	let index = 0;
	return sql.replaceAll("?", () => `$${++index}`);
}

/** Attach the statement and parameter types to a query failure, for diagnostics. */
function tagQuery(error: unknown, sql: string, params: readonly PgValue[]): Error {
	if (!(error instanceof Error)) return new Error(String(error));
	return new Error(
		`${error.message} [sql: ${sql}] [params: ${params.map((p) => JSON.stringify(p)).join(", ")}]`,
	);
}

/** A queue entry's operation. */
type Operation = () => Promise<unknown>;

/**
 * `SqliteDatabase` over one node-postgres client: the PostgreSQL adapter of the portable storage core.
 *
 * All operations serialize through one queue, and a transaction holds that queue until it settles, so unrelated
 * work never interleaves with a transaction's statements — the queueing the storage core's contract requires.
 */
export class PgDatabase {
	readonly #client: pg.Client;
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(client: pg.Client) {
		this.#client = client;
	}

	/** Schedule one operation after everything before it. */
	#schedule<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("PgDatabase is closed"));
		const result = this.#queue.then(operation, operation);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	async exec(sql: string): Promise<void> {
		await this.#schedule(async () => {
			await this.#client.query(sql);
		});
	}

	async run(sql: string, ...params: PgValue[]): Promise<void> {
		await this.#schedule(async () => {
			await this.#client.query(placeholders(sql), params).catch((error: Error & { routine?: string }) => {
				throw new Error(`${error.message} [sql: ${sql}] [params: ${params.map((p) => typeof p).join(", ")}]`);
			});
		});
	}

	async get<T extends object>(sql: string, ...params: PgValue[]): Promise<T | undefined> {
		return this.#schedule(async () => {
			const result = await this.#client
				.query<T>(placeholders(sql), params)
				.catch((error: unknown) => {
					throw tagQuery(error, sql, params);
				});
			return result.rows[0];
		});
	}

	async all<T extends object>(sql: string, ...params: PgValue[]): Promise<T[]> {
		return this.#schedule(async () => {
			const result = await this.#client
				.query<T>(placeholders(sql), params)
				.catch((error: unknown) => {
					throw tagQuery(error, sql, params);
				});
			return result.rows;
		});
	}

	transaction<T>(callback: (transaction: PgExecutor) => Promise<T>): Promise<T> {
		return this.#schedule(async () => {
			// Direct client access: the queue slot this transaction owns already serializes it.
			const executor: PgExecutor = {
				exec: async (sql) => {
					await this.#client.query(sql);
				},
				run: async (sql, ...params) => {
					await this.#client.query(placeholders(sql), params).catch((error: unknown) => {
						throw tagQuery(error, sql, params);
					});
				},
				get: async <T extends object>(sql: string, ...params: PgValue[]) => {
					const result = await this.#client.query<T>(placeholders(sql), params).catch((error: unknown) => {
						throw tagQuery(error, sql, params);
					});
					return result.rows[0];
				},
				all: async <T extends object>(sql: string, ...params: PgValue[]) => {
					const result = await this.#client.query<T>(placeholders(sql), params).catch((error: unknown) => {
						throw tagQuery(error, sql, params);
					});
					return result.rows;
				},
			};
			await this.#client.query("BEGIN");
			try {
				const value = await callback(executor);
				await this.#client.query("COMMIT");
				return value;
			} catch (error) {
				try {
					await this.#client.query("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.#schedule(async () => {
			this.#closed = true;
			await this.#client.end();
		});
	}
}

/** Transaction-scoped operations; invalid after the transaction settles. */
export interface PgExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: PgValue[]): Promise<void>;
	get<T extends object>(sql: string, ...params: PgValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: PgValue[]): Promise<T[]>;
}

/** Connect a client for `openPgStorage`. */
export async function connectPg(connectionString: string): Promise<pg.Client> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	return client;
}
