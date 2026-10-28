import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { openPgStorage } from "../src/storage/pg/index.ts";
import type { SqliteStorage } from "../src/storage/sqlite/index.ts";
import type { ConversationId, EntryId, Id, Seq, Storage, StorageWrite } from "../src/types.ts";

// Run with PG_STORAGE_URL set, for example:
//   PG_STORAGE_URL=postgres://pi:pi@localhost:5433/durable npx vitest --run test/storage-pg.test.ts
const CONNECTION = process.env.PG_STORAGE_URL;

const context = BACKGROUND_CONTEXT;
const openStorages = new Set<SqliteStorage>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
});

function freshSchema(): string {
	return `pi_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function createPgStorage(): Promise<SqliteStorage> {
	const storage = await openPgStorage(CONNECTION!, { schema: freshSchema() });
	openStorages.add(storage);
	return storage;
}

/** Closes and reopens the connection after every commit, so the conformance covers cross-reopen identity rules. */
class ReopeningStorage implements Storage {
	private current: SqliteStorage;
	private readonly schema: string;
	private closed = false;

	constructor(current: SqliteStorage, schema: string) {
		this.current = current;
		this.schema = schema;
	}

	async commit(
		writes: readonly StorageWrite[],
		commitContext: Parameters<Storage["commit"]>[1],
		options: Parameters<Storage["commit"]>[2],
	): Promise<Seq> {
		if (this.closed) return this.current.commit(writes, commitContext, options);
		try {
			return await this.current.commit(writes, commitContext, options);
		} finally {
			await this.current.close(context);
			this.current = await openPgStorage(CONNECTION!, { schema: this.schema });
		}
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.current.mintId<I>();
	}
	conversation: Storage["conversation"] = (id, readContext) => this.current.conversation(id, readContext);
	scanConversations: Storage["scanConversations"] = (query, limit, cursor, readContext) =>
		this.current.scanConversations(query, limit, cursor, readContext);
	entry(id: EntryId, readContext: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, readContext: Context): ReturnType<Storage["entry"]>;
	entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, readContext?: Context) {
		if (readContext === undefined) {
			return this.current.entry(idFromNumber<EntryId>(idOrConversationId), idOrContext as Context);
		}
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		return this.current.entry(
			idFromNumber<ConversationId>(idOrConversationId),
			idFromNumber<EntryId>(idOrContext),
			readContext,
		);
	}
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (conversationId, at, readContext) =>
		this.current.findLatestHeadMarker(conversationId, at, readContext);
	scanEntries: Storage["scanEntries"] = (query, limit, cursor, readContext) =>
		this.current.scanEntries(query, limit, cursor, readContext);
	task: Storage["task"] = (id, readContext) => this.current.task(id, readContext);
	scanTasks: Storage["scanTasks"] = (query, limit, cursor, readContext) =>
		this.current.scanTasks(query, limit, cursor, readContext);
	submission: Storage["submission"] = (id, readContext) => this.current.submission(id, readContext);
	scanSubmissions: Storage["scanSubmissions"] = (query, limit, cursor, readContext) =>
		this.current.scanSubmissions(query, limit, cursor, readContext);
	submissionByRequest: Storage["submissionByRequest"] = (conversationId, requestId, readContext) =>
		this.current.submissionByRequest(conversationId, requestId, readContext);
	findDocument: Storage["findDocument"] = (address, at, readContext) =>
		this.current.findDocument(address, at, readContext);
	document: Storage["document"] = (id, at, readContext) => this.current.document(id, at, readContext);
	scanDocuments: Storage["scanDocuments"] = (query, limit, cursor, readContext) =>
		this.current.scanDocuments(query, limit, cursor, readContext);

	async close(closeContext: Parameters<Storage["close"]>[0]): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.current.close(closeContext);
	}
}

describe.skipIf(CONNECTION === undefined)("PgStorage", () => {
	it("connects and migrates", async () => {
		const storage = await createPgStorage();
		expect(storage).toBeDefined();
	});

	registerStorageConformance({ describe, expect, it }, "PgStorage conformance", async (use) => {
		await use(await createPgStorage());
	});

	registerStorageConformance({ describe, expect, it }, "PgStorage across reopen", async (use) => {
		const schema = freshSchema();
		const first = await openPgStorage(CONNECTION!, { schema });
		await first.close(context);
		const reopening = new ReopeningStorage(await openPgStorage(CONNECTION!, { schema }), schema);
		try {
			await use(reopening);
		} finally {
			await reopening.close(context);
		}
	});
});
