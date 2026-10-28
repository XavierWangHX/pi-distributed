// A job's records on its object (§15, slice 6a §1.2): its runs by id and by key, the active count, the run state
// documents, `running` and the runs waiting for a live attempt, across the object's attempts. Records and state
// documents change only in transactions on the object's line (staged changes adopted in the commit step).

import type { Context } from "../../context/index.ts";
import { type Op, type Prepared, type Tracker, track } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { ChordError } from "../data/index.ts";
import { check, validatorFor } from "../data/internal.ts";
import type { JsonObject, StateDefinition } from "../documents/index.ts";
import type { DocumentSlot, Documents, Staged, Transaction } from "../documents/internal.ts";
import type { AnyHost } from "../host/internal.ts";
import { uuidv7 } from "../host/internal.ts";
import type { JobDefinition, JobError } from "./definition.ts";
import type { Job, StartOptions } from "./job.ts";
import { type AnyOutcome, JobRun, type Run } from "./run.ts";
import { Running } from "./running.ts";

/** What a job's records need of their object. */
export type RecordsOwner = {
	readonly label: string;
	readonly host: AnyHost;
	/** The object's context, without an abort signal: outcomes are recorded under it. */
	readonly context: Context;
	readonly documents: Documents;
	/** Counts running and finishing runs: they keep the object alive (`host.activity.jobs`). */
	countRuns(delta: number): void;
};

/** How a run's invocation ended, before its outcome is recorded. */
export type Settled =
	| { readonly kind: "done"; readonly result: unknown }
	| { readonly kind: "failed"; readonly error: JobError };

/** A change of the records, staged in a transaction and adopted in its commit step. */
type RecordChange =
	| { readonly kind: "create"; readonly run: JobRun; readonly state: JsonObject | undefined }
	| { readonly kind: "outcome"; readonly run: JobRun; readonly outcome: AnyOutcome }
	| { readonly kind: "delete" | "block" | "drop"; readonly run: JobRun };

/** One transaction's changes of one job: the runs it started (dedupe, concurrency) and whose finish it is. */
export type Staging = Staged & {
	readonly started: JobRun[];
	readonly changes: RecordChange[];
	finishing: JobRun | undefined;
};

const RESTART: Settled = { kind: "failed", error: { kind: "aborted", reason: "restart" } };

/**
 * The records of one job name on one object. The live attempt's `Job` invokes and finishes its runs; between live
 * attempts, committed runs not yet invoked and runs whose outcome is recorded wait for the next one.
 */
export class JobRecords {
	readonly definition: JobDefinition<unknown, unknown, unknown>;
	readonly running: Running;
	readonly #owner: RecordsOwner;
	readonly #states: RunStates | undefined;
	readonly #runs = new Map<string, JobRun>();
	readonly #keys = new Map<string, JobRun>();
	/** Running and finishing runs: concurrency and keep-alive count them. */
	#active = 0;
	/** The live attempt's job; `undefined` between live attempts. */
	#job: Job | undefined;
	/** Runs waiting for a live attempt: to be invoked (`invocation` pending) or finished (phase `finishing`). */
	readonly #waiting = new Set<JobRun>();
	/** The object's end error, once it ended. */
	#ended: ChordError | undefined;

	constructor(definition: JobDefinition<unknown, unknown, unknown>, owner: RecordsOwner) {
		this.definition = definition;
		this.#owner = owner;
		const { state } = definition;
		this.#states =
			state === undefined
				? undefined
				: new RunStates(state, owner.documents, (id, ops) => this.#stateChanged(id, ops));
		this.running = new Running(owner.documents.batch, this.name);
	}

	/** The job in errors: its object and its name. */
	get name(): string {
		return `${this.#owner.label} job ${this.definition.name}`;
	}

	/** Waits for the outcome of the unsettled run `id`; a settled or unknown id rejects `gone`. */
	outcome(id: string, context: Context): Promise<AnyOutcome> {
		const run = this.#runs.get(id);
		if (run === undefined) {
			return Promise.reject(new ChordError({ code: "gone", message: `${this.name}: no unsettled run ${id}` }));
		}
		return run.handle.outcome(context);
	}

	/** Fires a running run's signal; drops a blocked run; ignored for finishing runs, unknown ids and after the end. */
	abort(id: string): void {
		const run = this.#runs.get(id);
		if (run === undefined || this.#ended !== undefined) return;
		if (run.phase === "running") {
			run.abort.abort(new ChordError({ code: "aborted", message: `${this.name}: run ${id} aborted` }));
		} else if (run.phase === "blocked") {
			void this.record(run, "drop");
		}
	}

	/** See `Job.stage`: the checks and the staged creation, against the object's runs. */
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		const definition = this.definition;
		// Plugin code, not type-checked: the args are checked as a method's are (R7).
		check(validatorFor(definition.args, context), args, "args", context);
		const staged = tx.staged<Staging>(this);
		const { key } = options;
		if (key !== undefined) {
			const known = staged?.started.find((run) => run.key === key) ?? this.#keys.get(key);
			if (known !== undefined && known !== staged?.finishing) return known.handle;
		}
		const { concurrency } = definition;
		const active = this.#active + (staged?.started.length ?? 0) - (staged?.finishing === undefined ? 0 : 1);
		if (concurrency !== undefined && active >= concurrency) {
			const message = `${this.name}: at its concurrency limit (${concurrency})`;
			throw new ChordError({ code: "unavailable", reason: "busy", message });
		}
		const state = definition.state?.initial(context);
		// Checked above: the args are JSON (the definition refuses bytes).
		const run = new JobRun(uuidv7(), definition.version, key, args as JsonValue);
		const staging = this.staging(tx);
		staging.started.push(run);
		staging.changes.push({ kind: "create", run, state });
		return run.handle;
	}

	/** This job's changes in `tx`, made on the first. */
	staging(tx: Transaction): Staging {
		return tx.stage(this, () => {
			const changes: RecordChange[] = [];
			return {
				started: [],
				changes,
				finishing: undefined,
				adopt: () => {
					// A step admitted before the object ended adopts after it: the records are not changed any more.
					if (this.#ended !== undefined) return;
					for (const change of changes) this.#adopt(change);
				},
				committed: () => {
					const ended = this.#ended;
					if (ended === undefined) {
						for (const change of changes) this.#committed(change);
						return;
					}
					// Its runs end as the object's other runs did.
					for (const change of changes) if (change.kind === "create") change.run.reject(ended);
				},
				discarded: () => {
					for (const change of changes) if (change.kind === "create") change.run.reject(this.#discarded());
				},
			};
		});
	}

	/** `job`, of the attempt that went live, invokes and finishes the runs from now on; the waiting ones first. */
	attach(job: Job): void {
		if (this.#ended !== undefined) return;
		this.#job = job;
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const run of waiting) this.#dispatch(run, job);
	}

	/**
	 * `job`'s attempt was sealed: its running invocations are cut off (`cut`), the runs it was finishing wait for the
	 * next live attempt.
	 */
	detach(job: Job, finishing: Iterable<JobRun>): void {
		if (this.#job === job) this.#job = undefined;
		for (const run of finishing) this.#need(run);
	}

	/**
	 * A run's invocation settled: its outcome is recorded (phase `finishing`) in a transaction of the object behind the
	 * state changes admitted before, so `outcome.state` has them; then it is finished on the live attempt.
	 */
	settled(run: JobRun, ended: Settled): void {
		void this.#recordOutcome(run, ended);
	}

	/**
	 * A running run whose attempt was sealed while the object continues: its signal fires with `error`, its invocation
	 * is fenced (later state changes refused, the open one discarded, its settling ignored), and it ends `failed {
	 * aborted, reason: "restart" }`, finished on the next live attempt.
	 */
	cut(run: JobRun, error: ChordError): void {
		run.invocation = "settled";
		this.#owner.documents.fence(run.token);
		run.abort.abort(error);
		if (this.#ended === undefined) void this.#recordOutcome(run, RESTART);
	}

	/**
	 * Records `kind` for `run` in a transaction of the object: `block` a finishing run, `drop` a blocked one (its
	 * record, key and state document go), if it still is one there. The object's end ends it.
	 */
	async record(run: JobRun, kind: "block" | "drop"): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const current = this.#runs.get(run.id) === run;
					if (current && run.phase === (kind === "block" ? "finishing" : "blocked")) {
						this.staging(tx).changes.push({ kind, run });
					}
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: its runs went with it.
		}
	}

	/** The value of run `id`'s state document, `undefined` without one or once retired. */
	stateOf(id: string): JsonObject | undefined {
		return this.#states?.value(id);
	}

	/** The run state documents, for `ctx.state.change`; `undefined` without a state definition. */
	get states(): DocumentSlot | undefined {
		return this.#states;
	}

	/**
	 * The object ends: running runs' signals fire, every waiter rejects with `error`, blocked runs are dropped
	 * (reported); nothing finishes. The records stay readable until `drop`.
	 */
	end(error: ChordError): void {
		if (this.#ended !== undefined) return;
		this.#ended = error;
		this.#job = undefined;
		this.#waiting.clear();
		for (const run of this.#runs.values()) {
			if (run.phase === "blocked") this.report({ kind: "job_dropped", id: run.id });
			run.abort.abort(error);
			run.reject(error);
		}
		if (this.#active > 0) this.#owner.countRuns(-this.#active);
	}

	/** Its object's documents are dropped: the runs, their state documents and `running`'s watches go. */
	drop(): void {
		this.#runs.clear();
		this.#keys.clear();
		this.#states?.drop();
		this.running.end();
	}

	/** Reports a run's failure or drop to the host. */
	report(
		error:
			| { readonly kind: "job_failed" | "job_finish_failed"; readonly id: string; readonly error: unknown }
			| { readonly kind: "job_dropped"; readonly id: string },
	): void {
		this.#owner.host.report({ ...error, object: this.#owner.label, job: this.definition.name });
	}

	/** Records the outcome of `run`, then has it finished on the live attempt. */
	async #recordOutcome(run: JobRun, ended: Settled): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const outcome = { id: run.id, args: run.args, state: this.stateOf(run.id), ...ended };
					this.staging(tx).changes.push({ kind: "outcome", run, outcome });
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: nothing finishes.
			return;
		}
		this.#need(run);
	}

	/** `run` needs a live attempt (to be invoked or finished): now, or once one attaches. */
	#need(run: JobRun): void {
		if (this.#ended !== undefined || this.#runs.get(run.id) !== run) return;
		const job = this.#job;
		if (job === undefined) this.#waiting.add(run);
		else this.#dispatch(run, job);
	}

	/** Invokes or finishes `run` on `job`, as its record stands. */
	#dispatch(run: JobRun, job: Job): void {
		if (this.#runs.get(run.id) !== run) return;
		if (run.phase === "finishing") job.finish(run);
		else if (run.phase === "running" && run.invocation === "pending") job.invoke(run);
	}

	/**
	 * Adopts one record change, inside the commit step: the maps, the active count, the state document, `running`. A
	 * new run is counted for its object here, before the commit's publication (a link closing while it sends may
	 * release the object's last reference) and before any run of the same commit settles in `#committed`.
	 */
	#adopt(change: RecordChange): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
				this.#runs.set(run.id, run);
				if (run.key !== undefined) this.#keys.set(run.key, run);
				this.#active++;
				this.#owner.countRuns(1);
				if (change.state !== undefined) this.#states?.create(run.id, change.state);
				run.entry = run.entryFor(change.state);
				this.running.add(run.entry);
				return;
			case "outcome":
				run.outcome = change.outcome;
				run.phase = "finishing";
				this.#replaceEntry(run);
				return;
			case "block":
				run.phase = "blocked";
				this.#active--;
				this.#replaceEntry(run);
				return;
			case "delete":
			case "drop":
				this.#runs.delete(run.id);
				// The finishing run's key may name its successor already, started in the same commit.
				if (run.key !== undefined && this.#keys.get(run.key) === run) this.#keys.delete(run.key);
				if (change.kind === "delete") this.#active--;
				this.#states?.retire(run.id);
				this.running.remove(run.entry!);
				run.entry = undefined;
				return;
		}
	}

	/** The actions after a record change committed. */
	#committed(change: RecordChange): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
				// After the commit, outside the batch, once the transaction settled; on the live attempt, or the next.
				queueMicrotask(() => this.#need(run));
				return;
			case "outcome":
				return;
			case "delete":
				this.#owner.countRuns(-1);
				run.resolve(run.outcome!);
				return;
			case "block":
				this.#owner.countRuns(-1);
				return;
			case "drop":
				this.report({ kind: "job_dropped", id: run.id });
				run.reject(new ChordError({ code: "aborted", message: `${this.name}: run ${run.id} dropped` }));
				return;
		}
	}

	/** A run's state document changed by `ops`, inside the commit step: its entry is replaced. */
	#stateChanged(id: string, ops: readonly Op[]): void {
		const run = this.#runs.get(id)!;
		const before = run.entry!;
		run.entry = run.entryFor(this.stateOf(id));
		this.running.stateChanged(before, run.entry, ops);
	}

	/** A run's record changed, inside the commit step: its entry is replaced. */
	#replaceEntry(run: JobRun): void {
		const before = run.entry!;
		run.entry = run.entryFor(this.stateOf(run.id));
		this.running.replace(before, run.entry);
	}

	#discarded(): ChordError {
		return new ChordError({
			code: "released",
			reason: "discarded",
			message: `${this.name}: the start's transaction was discarded`,
		});
	}
}

/**
 * A job's state documents, one per run by its id: Chord's own keyed slot, apart from the object's `self.state` slots.
 * Created with the run and retired with its record; never drafted while absent, so a retired one is never recreated.
 * Each commit tells the job, whose `running` carries the state.
 */
class RunStates implements DocumentSlot {
	readonly owner: Documents;
	/** In memory only (persisted jobs are slice 6b's). */
	readonly persisted = undefined;
	readonly #definition: StateDefinition<JsonObject, false>;
	readonly #trackers = new Map<string, Tracker<JsonObject>>();
	readonly #changed: (id: string, ops: readonly Op[]) => void;

	constructor(
		definition: StateDefinition<JsonObject, false>,
		owner: Documents,
		changed: (id: string, ops: readonly Op[]) => void,
	) {
		this.#definition = definition;
		this.owner = owner;
		this.#changed = changed;
	}

	/** The value of run `id`'s document; `undefined` once retired. */
	value(id: string): JsonObject | undefined {
		return this.#trackers.get(id)?.value;
	}

	current(key: string): Tracker<JsonObject> | undefined {
		return this.#trackers.get(key);
	}

	initial(_context: Context): JsonObject {
		throw new ChordError({
			code: "released",
			reason: "settled",
			message: `${this.#definition.name}: the run's document is retired`,
		});
	}

	adopt(key: string, tracker: Tracker<JsonObject>, prepared: Prepared<JsonObject>): void {
		tracker.adopt(prepared);
		this.#changed(key, prepared.ops);
	}

	/** Retires run `key`'s document (its record's deletion). */
	retire(key: string): void {
		this.#trackers.delete(key);
	}

	/** Creates run `id`'s document with `value` (its start's commit). */
	create(id: string, value: JsonObject): void {
		this.#trackers.set(id, track(value));
	}

	/** Drops every document (the object ended). */
	drop(): void {
		this.#trackers.clear();
	}
}
