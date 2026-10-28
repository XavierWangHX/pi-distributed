// Jobs (§15), in memory: the handle `self.job` returns, one per attempt, over the job's records on its object. It
// holds the implementation and the invocations: `run` runs outside transactions, `finish` in one with the cleanup,
// both on the attempt that is live; the attempt's seal cuts its invocations off (slice 6a §1.3).

import { type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import type { Draft } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watchable } from "../../watch.ts";
import { ChordError, isChordError, PluginError, type Principal } from "../data/index.ts";
import type { JsonObject, Tx } from "../documents/index.ts";
import type { Documents, SealToken, Transaction } from "../documents/internal.ts";
import { type Ctx, sleep } from "../host/index.ts";
import { type AnyHost, CallContext, type Caller, nextDelay } from "../host/internal.ts";
import type { Outcome } from "./definition.ts";
import type { JobRecords, Settled } from "./records.ts";
import type { AnyOutcome, JobRun, Run } from "./run.ts";
import type { RunningEntry } from "./running.ts";

/** A job's handle, `self.job(Job, { run, finish? })`; `A`, `R` and `S` are its args, result and state. */
export interface JobHandle<A, R, S> {
	/**
	 * Starts a run in one transaction on the object's line and resolves with its `Run` after the commit: the args
	 * checked (`invalid/args`); a `key` of an unsettled run returns that run; at the `concurrency` limit (running plus
	 * finishing runs) it rejects `unavailable/busy`. `run` starts after the commit.
	 */
	start(args: A, context: Context, options?: StartOptions): Promise<Run<Outcome<A, R, S>>>;
	/** Waits for the outcome of the unsettled run `id`; a settled or unknown id rejects `gone`. */
	outcome(id: string, context: Context): Promise<Outcome<A, R, S>>;
	/**
	 * Fires a running run's abort signal; drops a blocked run (no `finish`; its waiters reject `aborted`); ignored for
	 * finishing runs and unknown ids.
	 */
	abort(id: string): void;
	/** The unsettled runs, one entry each in start order, tagged by phase (a JSON watchable, a state member). */
	readonly running: Watchable<readonly RunningEntry<A, S>[]>;
}

/** What `start` and `tx.start` take besides the args. */
export type StartOptions = {
	/** Names one run: a start with the key of an unsettled run returns that run (args not compared). */
	readonly key?: string;
};

/** What `self.job` takes: the run and the optional finish. */
export type JobImplementation<A, R, S, P extends Principal = Principal> = {
	/** The work, outside transactions; its ctx's abort signal fires on `abort(id)` and on its object's end. */
	readonly run: (args: A, ctx: JobCtx<P, S>) => Promise<R>;
	/** Records the outcome in one transaction (only `await tx.*`); the run's record and state document go with it. */
	readonly finish?: (outcome: Outcome<A, R, S>, tx: Tx) => void | Promise<void>;
};

/** A run's ctx: a handler's ctx (the object's principal or the host's), its run's id and, with a state, the state. */
export type JobCtx<P extends Principal, S> = Ctx<P> & { readonly jobId: string } & ([S] extends [undefined]
		? unknown
		: { readonly state: RunState<S> });

/** A run's state document. */
export interface RunState<S> {
	/** The document's value. */
	readonly value: S;
	/**
	 * One transaction on the object's line drafting only this document, under `context` without its abort signal:
	 * admitted while `run` runs (also after an abort, with the run's own ctx), refused `released` once it settled.
	 */
	change<T>(fn: (draft: Draft<S>) => T, context: Context): Promise<T>;
}

/** Where a job's handle runs its work: its attempt, as the job sees it. */
export type JobOwner = {
	readonly host: AnyHost;
	/** Whom runs act for: the object's principal (remote) or the host's (local), from this host. */
	readonly caller: Caller;
	/** The object's context, without an abort signal: runs, state changes and finishes run under it. */
	readonly context: Context;
	/** Aborted when the attempt is sealed: a finish's backoff waits under it. */
	readonly signal: AbortSignal;
	/** The attempt's seal token: its starts and finishes are transactions under it. */
	readonly token: SealToken;
	readonly documents: Documents;
	/**
	 * Adds running work (an invocation and its finish, a deferred finish) to the attempt's drain; `cleanup` (its
	 * bookkeeping) runs once, when it settles or when the attempt ends with it still running.
	 */
	admit(running: Promise<unknown>, cleanup?: () => void): void;
};

/** A job's implementation as Chord calls it, whatever the job's types. */
export type AnyJobImplementation = {
	readonly run: (args: JsonValue, ctx: JobContext) => Promise<unknown>;
	readonly finish?: (outcome: AnyOutcome, tx: Tx) => void | Promise<void>;
};

/** Failed finishes in a row after which a run is blocked. */
const FINISH_ATTEMPTS = 5;

/**
 * A job as one attempt declares it: its implementation and the invocations and finishes running on the attempt. Starts
 * are taken while the attempt is live; the object's records keep the runs.
 */
export class Job implements JobHandle<JsonValue, unknown, JsonValue | undefined> {
	readonly #records: JobRecords;
	readonly #implementation: AnyJobImplementation;
	readonly #owner: JobOwner;
	/** `declared` until the attempt is live (starts are refused), `sealed` once it is sealed. */
	#state: "declared" | "live" | "sealed" = "declared";
	/** Runs whose `run` runs on this attempt. */
	readonly #invocations = new Set<JobRun>();
	/** Runs whose finish runs on this attempt. */
	readonly #finishing = new Set<JobRun>();

	constructor(records: JobRecords, implementation: AnyJobImplementation, owner: JobOwner) {
		this.#records = records;
		this.#implementation = implementation;
		this.#owner = owner;
	}

	get running(): Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]> {
		// Its value is the list of entries `JobRun.entryFor` builds.
		return this.#records.running as unknown as Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]>;
	}

	async start(args: JsonValue, context: Context, options: StartOptions = {}): Promise<Run<AnyOutcome>> {
		const { documents, token } = this.#owner;
		return documents.tx((tx) => this.stage(tx, args, context, options), token, context);
	}

	outcome(id: string, context: Context): Promise<AnyOutcome> {
		return this.#records.outcome(id, context);
	}

	abort(id: string): void {
		this.#records.abort(id);
	}

	/** The attempt went live: starts are taken, and the records' waiting runs are invoked or finished here. */
	live(): void {
		if (this.#state !== "declared") return;
		this.#state = "live";
		this.#records.attach(this);
	}

	/**
	 * Stages a run in `tx` (`start`, `tx.start`), in order: the args checked, dedupe by key (runs started earlier in
	 * `tx` included), the concurrency check, then the record and the state document, created in the commit. The run
	 * whose finish `tx` is counts for neither: `finish` may start the same job again, with the same key too. Returns
	 * the run's handle at once; a start that only dedupes stages nothing.
	 */
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		// Declaration policy: a handle belongs to its object (types cannot say whose transaction this is).
		if (tx.documents !== this.#owner.documents) {
			throw new Error(`${this.#owner.documents.label}: a transaction starts only its own object's jobs`);
		}
		if (this.#state === "sealed") {
			throw new ChordError({
				code: "released",
				reason: "ended",
				message: `${this.#records.name}: its attempt ended`,
			});
		}
		if (this.#state === "declared") {
			throw new ChordError({ code: "not_ready", message: `${this.#records.name}: its object is not live yet` });
		}
		return this.#records.stage(tx, args, context, options);
	}

	/**
	 * The attempt is sealed with `error`: starts are refused, running invocations are cut off (their signals fire, they
	 * end `aborted` with reason `restart` and finish on the next live attempt), and the runs finishing here wait for it.
	 */
	seal(error: ChordError): void {
		if (this.#state === "sealed") return;
		this.#state = "sealed";
		this.#records.detach(this, this.#finishing);
		this.#finishing.clear();
		for (const run of this.#invocations) this.#records.cut(run, error);
		this.#invocations.clear();
	}

	/**
	 * Runs `run` for a committed run (with its signal aborted already after an early abort). The invocation and the
	 * run's finish are one piece of work in the drain, admitted before plugin code runs: `run` may end its own object
	 * before its first await.
	 */
	invoke(run: JobRun): void {
		const { context, caller, host } = this.#owner;
		const ctx = new JobContext(withAbortSignal(run.abort.signal, context), caller, host, run.id, this.#stateOf(run));
		const work = Promise.withResolvers<void>();
		this.#owner.admit(work.promise, () => ctx.settle());
		this.#invocations.add(run);
		run.invocation = "running";
		const invocation = (async () => {
			try {
				return await this.#implementation.run(run.args, ctx);
			} finally {
				// The fence closes as `run` settles: a change made later is refused.
				run.invocation = "settled";
			}
		})();
		invocation
			.then(
				(result) => this.#settled(run, ctx, { kind: "done", result }),
				(error: unknown) => this.#settled(run, ctx, this.#failed(run, error)),
			)
			.then(work.resolve);
	}

	/**
	 * Runs the finish of `run`, whose outcome is recorded: `finish` with the cleanup in one transaction under the
	 * attempt's token, retried with backoff after a throw (reported), blocked after five in a row. The attempt's seal
	 * stops it without a report or a count; the next live attempt finishes the run.
	 */
	finish(run: JobRun): void {
		const work = this.#finish(run);
		this.#owner.admit(work);
	}

	/** How a throwing `run` ended: `aborted` after its signal fired, otherwise `threw` (reported). */
	#failed(run: JobRun, error: unknown): Settled {
		if (run.abort.signal.aborted) return { kind: "failed", error: { kind: "aborted", reason: "abort" } };
		this.#records.report({ kind: "job_failed", id: run.id, error });
		const thrown = isChordError(error) || error instanceof PluginError ? error : internal(error);
		return { kind: "failed", error: { kind: "threw", error: thrown } };
	}

	/**
	 * `run` settled: its `ctx.get` references go; its outcome is recorded unless the attempt's seal cut it off (which
	 * recorded its own), then the run finishes here while this attempt is live.
	 */
	async #settled(run: JobRun, ctx: JobContext, ended: Settled): Promise<void> {
		ctx.settle();
		if (run.token.sealed) return;
		this.#invocations.delete(run);
		this.#records.settled(run, ended);
	}

	async #finish(run: JobRun): Promise<void> {
		const { documents, token, context, signal } = this.#owner;
		this.#finishing.add(run);
		let delay: number | undefined;
		try {
			for (let failures = 1; ; failures++) {
				try {
					return await documents.tx(
						async (tx) => {
							const staging = this.#records.staging(tx);
							staging.finishing = run;
							await this.#implementation.finish?.(run.outcome!, tx);
							staging.changes.push({ kind: "delete", run });
						},
						token,
						context,
					);
				} catch (error) {
					if (this.#state === "sealed") return;
					this.#records.report({ kind: "job_finish_failed", id: run.id, error });
					if (failures === FINISH_ATTEMPTS) return await this.#records.record(run, "block");
					delay = nextDelay(delay);
					try {
						await sleep(delay, withAbortSignal(signal, context));
					} catch {
						return;
					}
				}
			}
		} finally {
			this.#finishing.delete(run);
		}
	}

	/** `ctx.state` of `run`, when the job has a state: changes under the run's own token while `run` runs. */
	#stateOf(run: JobRun): RunState<JsonObject> | undefined {
		const records = this.#records;
		const states = records.states;
		if (states === undefined) return undefined;
		const { documents } = this.#owner;
		const refused = (): ChordError =>
			new ChordError({
				code: "released",
				reason: "settled",
				message: `${records.name}: run ${run.id} settled; its state is closed`,
			});
		return {
			get value(): JsonObject {
				const value = records.stateOf(run.id);
				if (value === undefined) throw refused();
				return value;
			},
			change: <T>(fn: (draft: Draft<JsonObject>) => T, context: Context): Promise<T> => {
				if (run.invocation !== "running") return Promise.reject(refused());
				// Never the abort signal: a run records its progress also after an abort.
				const unaborted = withoutAbortSignal(context);
				return documents.tx(async (tx) => fn(await tx.draftSlot(states, run.id)), run.token, unaborted);
			},
		};
	}
}

/** A plugin's throw that is neither a ChordError nor a PluginError, as a run's outcome keeps it. */
function internal(error: unknown): PluginError {
	return new PluginError("internal", error instanceof Error ? error.message : String(error));
}

/** A run's ctx: the handler's ctx of its object, its id and, with a state, its state document. */
export class JobContext extends CallContext {
	readonly jobId: string;
	declare readonly state: RunState<JsonObject> | undefined;

	constructor(
		context: Context,
		caller: Caller,
		host: AnyHost,
		jobId: string,
		state: RunState<JsonObject> | undefined,
	) {
		super(context, caller, host);
		this.jobId = jobId;
		if (state !== undefined) this.state = state;
	}
}
