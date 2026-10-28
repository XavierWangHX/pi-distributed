// One run of a job (§15): its record (id, version, key, args, phase, outcome), its abort signal, the fence of its
// invocation (its seal token), its `running` entry and the `Run` handle its callers wait on.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { ChordError } from "../data/index.ts";
import { SealToken } from "../documents/internal.ts";
import type { Outcome } from "./definition.ts";

/** A started run as its caller holds it: its id and a wait for its outcome. */
export interface Run<O> {
	readonly id: string;
	/**
	 * Resolves with the outcome once `finish` committed (also without a `finish`); a blocked run keeps waiting, a dropped
	 * one rejects `aborted`, the object's end rejects with its error; `context` ends only this wait, which then keeps
	 * nothing of it. A rejection's error keeps its stack's receivers (the transaction that ended the run) until its
	 * `stack` is read (V8).
	 */
	outcome(context: Context): Promise<O>;
}

/** A run's outcome, as Chord keeps it whatever the job's types. */
export type AnyOutcome = Outcome<JsonValue, unknown, JsonValue | undefined>;

/**
 * Where a run's record stands. `running` from its start's commit (its `run` starts after it), `finishing` once its
 * outcome is recorded, `blocked` after five failed finishes.
 */
type Phase = "running" | "finishing" | "blocked";

/** Where a run's invocation stands: `ctx.state.change` is admitted only while it runs (the invocation fence). */
type Invocation = "pending" | "running" | "settled";

/** How a run settled for its waiters. */
type Answer =
	| { readonly kind: "done"; readonly outcome: AnyOutcome }
	| { readonly kind: "failed"; readonly error: ChordError };

/** One wait for a run's outcome, removed when its context aborts. */
type Waiter = { readonly settle: (settled: Answer) => void };

/** One run: changed only by its job, inside its transactions' commit steps (records) and after them (actions). */
export class JobRun {
	readonly id: string;
	readonly version: number;
	readonly key: string | undefined;
	readonly args: JsonValue;
	/** `run`'s abort signal: `abort(id)`, the object's end and `host.close` fire it; an early abort pre-marks it. */
	readonly abort = new AbortController();
	readonly handle: Run<AnyOutcome>;
	/** The seal token of its invocation: sealed when the invocation is cut off by its attempt's seal (`ctx.state.change`). */
	readonly token = new SealToken();
	phase: Phase = "running";
	invocation: Invocation = "pending";
	/** What it ended with, once recorded (finishing and blocked). */
	outcome: AnyOutcome | undefined;
	/** Its entry in `running`, while its record exists; replaced when its record or state document changes. */
	entry: JsonValue | undefined;
	/** Its waiters: apart from the run, so a handle kept by a caller keeps only how the run settled. */
	readonly #waiters = new Waiters();

	constructor(id: string, version: number, key: string | undefined, args: JsonValue) {
		this.id = id;
		this.version = version;
		this.key = key;
		this.args = args;
		const waiters = this.#waiters;
		this.handle = { id, outcome: (context) => waiters.wait(context) };
	}

	/** Its `running` entry for its current record and `state` (the job's state document, `undefined` without one). */
	entryFor(state: JsonValue | undefined): JsonValue {
		const { id, version, key, args, phase } = this;
		if (phase === "blocked") return { id, version, phase, reason: "finish_failed" };
		return {
			id,
			version,
			...(key === undefined ? {} : { key }),
			args,
			...(state === undefined ? {} : { state }),
			phase,
		};
	}

	/** Its waiters get the outcome. */
	resolve(outcome: AnyOutcome): void {
		this.#waiters.settle({ kind: "done", outcome });
	}

	/** Its waiters get `error`. */
	reject(error: ChordError): void {
		this.#waiters.settle({ kind: "failed", error });
	}
}

/** A run's waits for its outcome: each removed when its context aborts; late ones answered at once. */
class Waiters {
	/** How the run settled, once it did. */
	#settled: Answer | undefined;
	readonly #waiting = new Set<Waiter>();

	/** The run settled (once): every wait gets it. */
	settle(settled: Answer): void {
		if (this.#settled !== undefined) return;
		this.#settled = settled;
		for (const waiter of this.#waiting) waiter.settle(settled);
		this.#waiting.clear();
	}

	/** A wait for the outcome: at once once settled; otherwise until it settles or `context` aborts. */
	wait(context: Context): Promise<AnyOutcome> {
		const settled = this.#settled;
		if (settled !== undefined) return answer(settled);
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<AnyOutcome>();
		const abort = (): void => {
			this.#waiting.delete(waiter);
			reject(signal?.reason);
		};
		const waiter: Waiter = {
			settle: (each) => {
				signal?.removeEventListener("abort", abort);
				if (each.kind === "done") resolve(each.outcome);
				else reject(each.error);
			},
		};
		this.#waiting.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		return promise;
	}
}

/** A settled run's answer to a wait. */
function answer(settled: Answer): Promise<AnyOutcome> {
	return settled.kind === "done" ? Promise.resolve(settled.outcome) : Promise.reject(settled.error);
}
