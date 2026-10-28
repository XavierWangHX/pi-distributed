# Slice 6b: Durable and jobs on the store (spec)

Status: **decided, ready for the spec reviews** (2026-10-27; D1-D9 decided by the owner), written by the redesign session after reading
Durable's `Storage` interface (`packages/durable/src/types.ts`), its SQLite storage, schema and migrations, the storage
conformance suite and benchmark, `session/session.ts`, `session/transaction.ts`, `session/forks.ts`, and Chord v2's
store engine, applier, schema, commit step and jobs, in full. Durable's memory, JSONL and IndexedDB storages were not
read (they stay as they are, S15).

The single source for building 6b, together with: `design.md` read in full; the decision log
(`packages/chord/docs/next/decisions.md`, later entries win), in particular "The store", S1, S2, S4, S10, S11, S13, S15,
W1, W12, W13, "Slice 6 first decisions", "Durable observers", "Durable's synchronous observers", "Text is plain UTF-8",
"Failures are watch calls", the "One vocabulary" entries, "The performance and memory bar"; `slice-6a.md` (what 6a
built); the feature map and the carry-over of `slices.md` (slice 6b); the root `AGENTS.md` "Chord v2 Code Style".

6b puts Durable on the store (`StoreStorage`), follows Durable's views as Chord sources (`self.follow`), persists jobs,
and extends the applier to every write kind. After 6b a worker has one store: Chord's objects and Durable's Session
commit through one queue, and a commit of either is one seq in one outbox.

## What an app can do after this slice

```ts
// the start code of a session's worker (p3 base code)
const store = await openStore(sqliteBackend(db), ctx);
const worker = createHost<P>({ address: Session({ id }), principal, store, onError });

// the core facet: the harness object opens Durable on the same store
host.serve(Harness, (_, self) => {
  const harness = self.open(async (context) =>
    Harness.open(new StoreStorage(store), { models, registry, … }, context),   // one StoreStorage per store
    (h, _reason, context) => h.close(context));
  const view = self.follow((observer, ctx) => harness.value.observeConversation(id, observer, ctx));   // section 2
  return { … };
});

// a persisted job: survives a crash
const ImportJob = defineJob("notes.import", {
  version: 1, args: obj({ path: str() }), result: obj({ count: int() }),
  state: ImportState, persist: { resume: "rerun" },
});
const imports = self.job(ImportJob, { run, finish });
await imports.abort(id, ctx);               // stored; Decision needed (D7): the result
```

## 1. `StoreStorage`: Durable's `Storage` on the store

Durable's `Storage` (types.ts, "Atomic persistence boundary for Session records") implemented over a `ChordStore`, so
Durable's Session runs unchanged on it and passes Durable's storage conformance suite
(`createStorageConformance`), across reopen too.

**Where it lives (D1, owner, 2026-10-27: "they are only used if durable is used"):** `StoreStorage` belongs to
Durable (D9 makes `durableView` a generic Chord primitive, `self.follow`), in its own `src` (Chord v2 is in pi upstream since `93029a0f1`), importing
`@earendil-works/chord/next` (Chord's `./next` package export comes with them). Durable already depends on Chord and
Chord imports nothing of Durable (S13); Durable's conformance suite runs in Durable's tests and CI.

### 1.1 Records

Durable's four record tables (conversations, entries, tasks, submissions) and its ID namespace.

**Layout (D2, owner, 2026-10-27: "the whole purpose of this slice"):** declared tables of the store, written as
ordinary `put` writes: `defineTable`s that `StoreStorage` declares for itself under the type name `pi.durable` (SQL names
`"<host kind>:pi.durable:<table>"`, e.g. `"session:pi.durable:entries"`; type names are unique per app, so no plugin
table can meet them), each row the record's indexed columns (`id`, `conversation_id`, `kind`, `status`, …) plus
the whole record in a `json(...)` column. The outbox, export, import and the applier handle them as every table;
Durable's layout changes later through `evolveTable`. The partial head index becomes an index on `(conversation_id,
has_head, id)` (index columns are non-`opt`); indexed strings that must stay lossless (`kind`, `requestId`, document
kinds and keys) keep Durable's JSON encoding in their columns.

- **Writes:** every `StorageWrite` of a table record becomes a `put` of its row (Durable replaces complete records;
  conversations and entries are immutable and written once). `record_ids` is a declared table too (`id`,
  `record_type`), one `put` per new id (decision "Slice 6 first decisions" (3)).
- **Reads:** `conversation`, `entry` (with its `commitSeq`: a column), `findLatestHeadMarker`, `scanEntries` (both
  orders, the fork chain walked as `SqliteStorage` does), `task`, `scanTasks`, `submission`, `scanSubmissions`,
  `submissionByRequest`, `scanConversations`: queries over the declared tables, Durable's cursors (`{ after, order }`,
  `scan.ts`) kept as they are (built from the last id, not from Chord's table cursors).
- **Validation in the step** (D4): what `SqliteStorage` checks inside its transaction (`checkGlobalIds`,
  `prepareDocumentActions`, `checkDocumentActions`) runs inside the store's step, which rolls back a refused commit.

### 1.2 IDs

**One counter per store (D3, owner, 2026-10-27):** the store's counter (`next_document_id` renamed `next_id`, the
manifest's `nextDocumentId` renamed `nextId`) numbers every id: `StoreStorage.mintId()` takes from it in memory,
explicit ids in Durable's writes raise it, Chord's commit step takes its documents' ids from it, and every commit
persists it as a high-water mark. `record_ids` stays for Durable's "ID n already belongs to entry" check. Durable's ids
rise in its creation order (its scans and windows rely on it); Chord's ids are gaps between them. Spec reviewers check
that nothing relies on Chord's document ids rising with seq.

### 1.3 Documents

Durable's documents on the documents engine (S13): address `(namespace "durable", owner, kind, key?)`, owner the
scope as a string (`session`, `conversation:7`, `task:31`), kind and key JSON-encoded as Durable's indexed strings.
6a built `latest`; 6b adds what Durable needs:

- **`rewindable` records** keep every revision and are not deleted at retirement: `retired_at` is set, revisions
  stay (decision "Writes carry their versions" already defined the archive fields).
- **Reads at a point:** `findDocument(address, at)`, `document(id, at)` (the base at or below `at` plus the deltas up
  to it, in one read transaction, S4), `scanDocuments(scope, at, kind?)`, with Durable's half-open lifetime
  (`createdAt <= at < retiredAt`); a historical read of a `latest` (or session or task) record is a
  `StorageRequestError` ("does not retain historical content").
- **`document.copy`** (S11): `StoreStorage` reads the source at its point before the step and enters the step with a
  plain create carrying the base; the conformance rules (source not changed in the copy batch, a matching record) are
  checked there.
- **Stored version and `deltasSinceBase`** as `StoredDocument` reports them; Durable's records carry no fingerprint:
  the engine's fingerprint column takes `""` for Durable records.
- **Export** carries every revision of a `rewindable` record, retired ones included, with its seq (format 1's
  fields); import and the applier take them.

### 1.4 Commits

- `StoreStorage.commit(writes, adopt, ctx)`: validates (1.1), resolves copies (1.3), stages the writes (table `put`s,
  document creates, changes and retirements) and calls `store.commit(staged, { admit: () => true, adopt: (seq) =>
  adopt(seq) }, ctx)`. The store's step runs `adopt` inside `host.batch.commit(...)` when the store has a host, so
  Durable's observers mark Chord sources in the step (W1, "Slice 6 first decisions" (1)); `adopt` never throws
  (Durable's rule).
- **Durable's seq is the store's seq** (gaps allowed: Chord's commits take seqs too).
- **Errors:**

**Errors (D4, owner, 2026-10-27):** the store takes Durable's `Storage` semantics (design §10 "Store errors"): a
step that fails before `COMMIT` rolls back and rejects that commit only; the store stops only on an unknown outcome
(`COMMIT` or `ROLLBACK` failed), a throwing `adopt`, or a read's backend error. Owners react as Durable's Session:
Durable's Session fails (`GuardedStorage`, unchanged); a Chord object whose commit the step refused fails live
(`object_failed`, `broken`); an `int` `CHECK` failure fails only its transaction (`invalid/args`). `StoreStorage` runs
Durable's commit checks in the step, as `SqliteStorage` does, so the conformance suite's refused commits leave the
store usable. 6b changes 6a's step and object failure accordingly.

- `mintId`, `close(context)` (closes nothing of the store: the app owns it; later calls reject "closed"), reads after
  a store failure reject as Durable's `GuardedStorage` expects.

### 1.5 Statements per commit

A target to measure, as 6a's: an entry append is the `record_ids` put, the entry put, `lastSeq` (plus the outbox); a
document delta is 6a's three statements. `SqliteStorage` does the same work today (`record_ids`, the row, metadata).

## 2. `self.follow`: Durable's views as Chord sources (D9, owner, 2026-10-27)

Durable's synchronous observers (`observeConversation`, `observeTaskGraph`, `observeDoc`; decision "Durable's
synchronous observers") have Chord's watch shapes (`advance(call, ctx)` with a `WatchCall`, `end(end)` with a
`WatchEnd`, pi `5f312dac4`), so Chord follows them with one generic primitive and Durable needs no adapter:

```ts
host.serve(ChatView, ({ conversation }, self) => {
  const harness = self.get(Harness, {});
  const view = self.follow((observer, ctx) =>
    harness.value.observeConversation(conversation, observer, ctx, { min: 50 }));
  return { view, title: self.derive([view], ([v]) => v.title) };
});
```

- `self.follow(attach)` returns a `Watchable`: a state member, a derive source, an `on` source. `attach(observer,
  ctx)` returns `Promise<{ value, detach }>` (Durable's `Observation`).
- **Attaching** is that one call during activation: Chord makes the observer, calls `attach`, takes `value` as the
  source's value (calls arriving before the promise resolves are held and applied after it), and the object goes live.
  The attempt's end calls `detach()`. An attach that rejects, or resolves `undefined` (`observeDoc` of an absent
  address), fails the activation like a failed dependency.
- **Calls:** `advance` records the call. Inside a batch (on the store, Durable's `adopt` runs in the host's batch) the
  source is marked in the step and its frame goes out in that flush; outside a batch (a Durable storage that is not
  the store) the source collects the calls and opens one batch on the next microtask. A derive over two views of one
  Durable commit sees both changes in one computation.
- **End:** Durable's failures are final: `end({ kind: "failed" })` ends the watches `failed`, `ended` ends them
  `ended`.

## 3. Persisted jobs

Design §15 "Persistence": `persist: { resume: "rerun" | "abandon" }`, only in `local` objects with empty params (P3,
at declaration); a run's record and state document in the owner's store; a recorded outcome resumes only `finish`; an
abort request is persisted; a restart limit; the job fingerprint stored with every record; the start trace carrier.

- **Where records live:**

**Where records live (D5, owner, 2026-10-27):** each unsettled run's record is a keyed persisted document of its
object in the engine's namespace `chord.jobs` (owner the object's owner string, kind the job name, key the run id:
`{ version, fingerprint, args, key?, phase, outcome?, abort?, restarts, trace? }`); Chord sets that namespace, a plugin
never does (its documents are always `chord`), so nothing can collide. Its state document stays an ordinary document
of the run. Both change in the transactions that change them today (start, state change, outcome, finish, block,
drop); `finish` deletes the record and retires the state in its commit (Q9), so only unsettled runs are stored. At the
object's first activation the records are loaded through the engine's key listing and a load per run (no new read).

- **Resume at activation:** a run recorded `finishing` resumes `finish` only; a run recorded `running` was cut off by
  a crash: `rerun` invokes `run` again with the stored args and state, `abandon` records `failed { aborted, reason:
  "restart" }` and finishes.
- **Restart limit** (aligned with Durable's `restarts`):

**The same rule as Durable (D6, owner, 2026-10-27: "yes, same rule for chord"):** at activation a run recorded
`running` was cut off by a crash: its `restarts` rises by one (stored), then it resumes (`rerun` invokes `run` again,
`abandon` finishes with `failed { aborted, reason: "restart" }`); a clean close (`host.close`, a native restart on
reload) writes its stopped runs back so the next activation counts nothing (Durable's `writeAtClose`); a
`ctx.state.change` resets the count (progress); at five in a row the run ends with a new `JobError` `{ kind:
"restart_limit", restarts }`, its `finish` runs, and `job_interrupted` is reported (Durable's `restart_limit`,
`task_interrupted`). No `blocked { restart_limit }`: supersedes design §15's parking, as Durable dropped parking in
#11139.

- **Abort** (owner, 2026-10-27: async and stored in 6b):

**`job.abort(id, ctx): Promise<"marked" | "terminal">` (D7, owner, 2026-10-27), Durable's words and behaviour:**
a running run gets its abort stored (a rerun after a crash then finishes `aborted` instead of running again) and its
signal fired, and `abort` resolves `"marked"` once `run` settled (as `abortTask` joins the run); a finishing run is only
marked (`"marked"`, as Durable's `completing`); a blocked run is dropped at once (`"marked"`, as Durable's orphan); an id
with no unsettled run resolves `"terminal"` (Chord keeps no settled runs, Q9, so a settled and an unknown id are the
same; Durable throws for an unknown one).

- **Deferred state persistence:**

**Per change, Durable's shape (D8, owner, 2026-10-27):** `ctx.state.change(fn, ctx, { persistence: { kind:
"deferred", withinMs? } })` (default 1,000 ms, as Durable's `CommitPersistence`): adopted and published at once,
stored with the next immediate change of the document, before the outcome is recorded (so `outcome.state` has it), at
close, or after `withinMs`; a crash loses what is not stored. Only run state documents; other persisted documents get
it when a real case needs it.

- **Fingerprint:** the job's fingerprint (args, result and state schemas) stored with every record; a record of the
  same version with another fingerprint is `blocked { version }` (slice 7's family; the carry-over's "a job
  fingerprint over args, result and state").
- **Trace carrier:** the start's carrier (design §29) stored with the record; used in slice 9.

## 4. The applier for batch apply

6a's applier applies an archive's writes; 6b extends it to every `StoreWrite` kind (`alter`, `dropIndex`, `update`,
`updateWhere`, `delete`, `deleteWhere` with their recorded counts and versions, `document.change`, `document.retire`),
checked against the store's records (a trust boundary), one code path with import. A test replays a store's outbox
into an empty store and compares the two stores' exports. Applying a batch with a different count than recorded stops
applying (S17).

## 5. Benchmarks and tests

- **The gate** (decisions "The commit-step benchmark", "The performance and memory bar"): Durable's own storage
  benchmark (`test/storage.bench.ts`: the write and read cases of `testing/storage-benchmark.ts`) on `StoreStorage`
  against `SqliteStorage`, and Durable's `test/conversation-view-bench.ts` on both: each hot path within about 5%,
  memory (allocation per op, retained after GC) no worse beyond noise; persisted job starts and state changes against
  in-memory ones.
- **Tests:** Durable's storage conformance suite on `StoreStorage` (memory `:memory:` and across reopen); Durable's
  Session and harness test files that take a storage, run on `StoreStorage`; `self.follow` (one frame per commit, a
  derive over two views, outside the store, early calls held, failure and end, an absent `observeDoc`); persisted jobs (rerun, abandon, a recorded outcome
  resumes `finish`, restart counting and reset, the limit, abort stored, deferred state, fingerprints); the applier
  (every kind, the outbox replay, refused counts); export and import with Durable records and `rewindable` history;
  GC (observers detached with their attempt).
- **Examples:** `26-durable-on-the-store.ts`, `27-durable-views.ts`, `28-persisted-jobs.ts`.

## Carry-over taken

From `slices.md` "Slice 6b": persisted jobs (all of it), `StoreStorage` (ids, fork copies, `adopt` in the batch),
the Chord source over Durable's views (`self.follow`, the batch on and off the store), the applier for batch apply; `job.abort` async and
stored (decision of 2026-10-27).

## Carry-over left

Slice 7: a job fingerprint mismatch's `blocked { version }` resolution on reload; runs of jobs the code no longer
declares (with D5's records). Slice 9: the trace carrier's use.
