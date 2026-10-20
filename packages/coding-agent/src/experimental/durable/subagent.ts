import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type SubmissionId,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Machine } from "./multienv.ts";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? content.text : "")).join("") ?? "";
}

/** What a subagent needs to know about machines: the valid names, and a connection probe for fail-fast. */
export interface SubagentMachines {
	/** Target names, checked when the tool runs (the cluster changes at runtime). */
	names(): string[];
	/** Connect a machine now so an unreachable one fails the call, not the child's first tool use. */
	probe(machine: string): Promise<unknown>;
}

/** A background run just started; the host attaches its completion watcher. */
export interface BackgroundStart {
	readonly name: string;
	readonly child: ConversationId;
	readonly parent: ConversationId;
	readonly submission: SubmissionId;
}

/** One named subagent of this session. A type alias, not an interface: doc values must stay JSON-shaped. */
export type SubagentEntry = {
	conversation: number;
	machine: string;
	task: string;
	/** A background run: an ownerless child that outlives the creating turn, its aborts, and restarts. */
	background?: boolean;
	/** The conversation the completion report is submitted to. */
	parent?: number;
	/** The background run's submission, so a watcher re-attaches after a restart. */
	submission?: number;
	/** The settled run's answer, written by the host watcher; `wait` collects it. */
	result?: string;
	settledAt?: number;
	/** Set by `stop`; the watcher still records how the run settled. */
	stopped?: boolean;
};

/** This session's named subagents: the name maps to the child conversation a later call can continue. */
export const Subagents = defineDoc<{ entries: Record<string, SubagentEntry> }>({
	kind: "app.subagents",
	version: 1,
	scope: "session",
	initial: () => ({ entries: {} }),
	checkpointWhen: () => true,
});

/** Cumulative background spawns per session: a runaway loop must not flood the cluster. */
const MAX_BACKGROUND_PER_SESSION = 64;

/**
 * A subagent: each create makes a child conversation owned by the call's task (foreground) or by nobody
 * (background), runs the task there with its tools pinned to `machine`, and returns the child's answer.
 *
 * Foreground (default): the call blocks until the child answers; aborting the call aborts the child. The child
 * outlives the call, so the user can switch to it and keep talking.
 *
 * Background (`background: true`, name required): the call returns at once with the child working on. The child
 * is ownerless — the parent turn ending, aborting, or the whole process restarting does not touch it; on
 * restart the host re-attaches from this doc. Its answer is recorded in the doc by the host watcher, collected
 * with `wait`, and reported into the parent conversation as an `app.subagent-report` input. `stop` aborts it
 * explicitly.
 *
 * A named child can be continued by a later call: it keeps its machine and its whole context. The
 * model-facing channel is `output`.
 *
 * `orchestratorOnly` lists the extensions a child must NOT inherit (machine routing and cluster management): a
 * subagent is an executor pinned to its assigned machine; only the orchestrating conversation manages the cluster.
 * `onBackground` hands each started background run to the host so it can watch completion.
 */
export function createSubagent(
	machines: SubagentMachines,
	orchestratorOnly: readonly Extension[] = [],
	onBackground?: (start: BackgroundStart) => void,
): Extension {
	let self: Extension;
	// eslint-disable-next-line prefer-const
	self = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description:
					`Delegate a self-contained task to a subagent with the same tools (read/write/edit/bash) and get ` +
					`its answer back. The child never sees this conversation — put everything it needs into the ` +
					`task. Creating one requires machine; its tools run there for the whole conversation. ` +
					`By default the call blocks until the child answers. With background (name required) it ` +
					`returns at once while the child keeps working — through aborts of this turn and restarts of ` +
					`pi; collect the answer later with wait, stop it with stop; a completion report also arrives ` +
					`in this conversation. Give a foreground child a name to continue it later with continue: it ` +
					`keeps its machine and remembers everything.`,
				parameters: Type.Object({
					task: Type.Optional(
						Type.String({
							description: "What the subagent should do (creation), or the follow-up to send (continuation)",
						}),
					),
					name: Type.Optional(
						Type.String({
							description:
								'A short semantic name for this subagent, e.g. "api-research"; registers it for continuation. Required with background',
						}),
					),
					continue: Type.Optional(
						Type.String({
							description:
								"Name of an existing subagent to continue (pass exactly the registered name); do not pass machine when continuing",
						}),
					),
					machine: Type.Optional(
						Type.String({
							description:
								"Machine the new subagent's tools execute on (required when creating unless continuing); the machines section lists available names",
						}),
					),
					background: Type.Optional(
						Type.Boolean({
							description:
								"Create as a background run: this call returns at once; collect the answer with wait, stop it with stop. Requires name",
						}),
					),
					wait: Type.Optional(
						Type.String({
							description: "Name of a background subagent to wait for; returns its answer once it finishes",
						}),
					),
					stop: Type.Optional(
						Type.String({
							description:
								"Name of a background subagent to stop; an answer it already produced stays collectable",
						}),
					),
				}),
				// A rerun after a crash finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
					if (args.wait !== undefined || args.stop !== undefined) {
						if (args.wait !== undefined && args.stop !== undefined) {
							return { output: [{ type: "text", text: "Pass either wait or stop, not both." }], isError: true };
						}
						if (args.task !== undefined || args.continue !== undefined) {
							return {
								output: [{ type: "text", text: "wait and stop take no task or continue." }],
								isError: true,
							};
						}
						return args.wait !== undefined ? collect(args.wait, api, context) : stop(args.stop!, api, context);
					}
					const task = args.task;
					if (task === undefined) {
						return {
							output: [
								{
									type: "text",
									text: "task is required when creating or continuing a subagent (or pass wait/stop for a background one).",
								},
							],
							isError: true,
						};
					}
					let child: ConversationId;
					if (args.continue !== undefined) {
						if (args.machine !== undefined) {
							return {
								output: [
									{
										type: "text",
										text: "Do not pass machine when continuing: the subagent keeps its own machine.",
									},
								],
								isError: true,
							};
						}
						if (args.background !== undefined) {
							return {
								output: [
									{ type: "text", text: "background is for creation only; a named child keeps its mode." },
								],
								isError: true,
							};
						}
						const doc = await api.snapshot(Subagents, context);
						const entry = doc?.entries[args.continue];
						if (entry === undefined) {
							const names = Object.keys(doc?.entries ?? {});
							return {
								output: [
									{
										type: "text",
										text: `No subagent named "${args.continue}". Named subagents: ${
											names.length > 0 ? names.join(", ") : "(none yet; pass name when creating one)"
										}.`,
									},
								],
								isError: true,
							};
						}
						child = entry.conversation as ConversationId;
					} else {
						if (args.machine === undefined) {
							return {
								output: [
									{
										type: "text",
										text: "machine is required when creating a subagent (or pass continue for an existing one).",
									},
								],
								isError: true,
							};
						}
						if (!machines.names().includes(args.machine)) {
							return {
								output: [
									{
										type: "text",
										text:
											`Unknown machine "${args.machine}". Known: ${machines.names().join(", ")}. ` +
											`Add one with create_machine — a docker sandbox, or type "physical" for an install link.`,
									},
								],
								isError: true,
							};
						}
						await machines.probe(args.machine);
						if (args.background === true) {
							return startBackground(args.name, args.machine, task, api, context);
						}
						if (args.name !== undefined) {
							const doc = await api.snapshot(Subagents, context);
							if (doc?.entries[args.name] !== undefined) {
								return {
									output: [
										{
											type: "text",
											text: `Name "${args.name}" is already registered; pass continue: "${args.name}" to continue it.`,
										},
									],
									isError: true,
								};
							}
						}
						child = await api.commit(async (tx) => {
							const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
							if (existing !== undefined) return existing.id;
							// Starts as a copy of this conversation's agent, minus what only an orchestrator may do: without
							// this extension it cannot delegate further, and without the orchestrator-only extensions it
							// cannot switch machines or manage the cluster — its tools stay pinned to `machine`.
							const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
							await configure(tx, created.id, { extensions: { remove: [self, ...orchestratorOnly] } });
							(await tx.doc(Machine, created.id)).target = args.machine!;
							if (args.name !== undefined) {
								(await tx.doc(Subagents)).entries[args.name] = {
									conversation: created.id,
									machine: args.machine!,
									task,
								};
							}
							return created.id;
						}, context);
					}
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input") {
						throw new Error(`Subagent ${child} failed: ${settled.status}`);
					}
					const text = await answerText(api, settled.answer, context);
					const label = args.continue ?? args.name;
					const suffix = label === undefined ? "" : `\n（子代理 "${label}"；续聊传 continue: "${label}"）`;
					// The model-facing channel is `output` (ToolExecutionResult has no `content` field).
					return { output: [{ type: "text", text: text + suffix }], details: { conversationId: child } };
				},
			}),
			defineTool({
				name: "list_subagents",
				description:
					"List this session's named subagents (name, machine, state, first task) to pick one to continue, wait for, or stop.",
				parameters: Type.Object({}),
				async execute(_args, api, context) {
					const doc = await api.snapshot(Subagents, context);
					const entries = Object.entries(doc?.entries ?? {});
					if (entries.length === 0) {
						return { output: [{ type: "text", text: "(no named subagents yet; pass name when creating one)" }] };
					}
					// The model addresses subagents by name only; ids live in details for the UI.
					const lines = entries.map(([name, entry]) => {
						const state =
							entry.background !== true
								? ""
								: entry.result !== undefined
									? ", background finished"
									: entry.stopped === true
										? ", background stopped"
										: ", background running";
						return `- ${name} (machine ${entry.machine}${state}): ${entry.task.slice(0, 80)}`;
					});
					return { output: [{ type: "text", text: lines.join("\n") }], details: { entries } };
				},
			}),
		],
	});
	return self;

	/** Create the ownerless child, submit without waiting, record the run, and hand it to the host watcher. */
	async function startBackground(
		name: string | undefined,
		machine: string,
		task: string,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		if (name === undefined) {
			return {
				output: [
					{ type: "text", text: "background requires name: the run must be addressable for wait and stop." },
				],
				isError: true,
			};
		}
		const doc = await api.snapshot(Subagents, context);
		const spawned = Object.values(doc?.entries ?? {}).filter((entry) => entry.background === true).length;
		if (doc?.entries[name] === undefined && spawned >= MAX_BACKGROUND_PER_SESSION) {
			return {
				output: [
					{
						type: "text",
						text: `Background spawn budget exhausted (${MAX_BACKGROUND_PER_SESSION} per session); collect or stop finished runs first.`,
					},
				],
				isError: true,
			};
		}
		const child = await api.commit(async (tx) => {
			const entries = (await tx.doc(Subagents)).entries;
			const existing = entries[name];
			if (existing !== undefined) {
				if (existing.background !== true)
					throw new Error(`"${name}" is a foreground subagent; continue it or pick another name`);
				// A rerun after a crash: same child, and the requestId below dedupes the submission.
				return existing.conversation as ConversationId;
			}
			// Ownerless: outside every ownership scope, so the parent turn ending or aborting never reaches it.
			// The creation hook copies an agent from the OWNER conversation, and an ownerless child has none —
			// carry the orchestrator's model configuration over explicitly.
			const parentAgent = await tx.doc(AgentDoc, api.conversationId);
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, created.id, {
				extensions: { remove: [self, ...orchestratorOnly] },
				...(parentAgent.model === undefined ? {} : { model: parentAgent.model }),
				...(parentAgent.thinkingLevel === undefined ? {} : { thinkingLevel: parentAgent.thinkingLevel }),
				...(parentAgent.cwd === undefined ? {} : { cwd: parentAgent.cwd }),
			});
			(await tx.doc(Machine, created.id)).target = machine;
			entries[name] = { conversation: created.id, machine, task, background: true, parent: api.conversationId };
			return created.id;
		}, context);
		const handle = (await api.conversation(child, context))!;
		const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
		const submission = await handle.submit(request, context);
		await api.commit(async (tx) => {
			const entry = (await tx.doc(Subagents)).entries[name];
			if (entry !== undefined && entry.submission === undefined) entry.submission = submission.id;
		}, context);
		onBackground?.({ name, child, parent: api.conversationId, submission: submission.id });
		return {
			output: [
				{
					type: "text",
					text:
						`Background subagent "${name}" started on ${machine}; it keeps working while you continue — through ` +
						`aborts of this turn and restarts of pi. Collect its answer with subagent(wait: "${name}"), stop it ` +
						`with subagent(stop: "${name}"); a report also arrives here when it finishes.`,
				},
			],
			details: { conversationId: child },
		};
	}

	/** Block until the named background run's answer is recorded, then return it. */
	async function collect(name: string, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
		const doc = await api.snapshot(Subagents, context);
		const entry = doc?.entries[name];
		if (entry === undefined) {
			const names = Object.keys(doc?.entries ?? {});
			return {
				output: [
					{
						type: "text",
						text: `No subagent named "${name}". Named subagents: ${names.length > 0 ? names.join(", ") : "(none yet)"}.`,
					},
				],
				isError: true,
			};
		}
		if (entry.background !== true) {
			return {
				output: [
					{
						type: "text",
						text: `"${name}" is a foreground subagent: its answers return to the creating call directly. Use continue to ask it more.`,
					},
				],
				isError: true,
			};
		}
		if (entry.result === undefined) {
			const watch = await api.watchDoc(Subagents, context);
			if (watch !== undefined) {
				if (watch.value?.entries[name]?.result === undefined) {
					await new Promise<void>((resolve, reject) => {
						watch.start(async (value) => {
							if (value?.entries[name]?.result !== undefined) resolve();
						});
						void watch.closed.then(
							(end) => reject(new Error(`wait for "${name}" ended before an answer: ${end.reason}`)),
							() => undefined,
						);
					});
				}
				await watch.stop();
			} else {
				// The doc is not watchable yet; poll the committed state instead.
				for (;;) {
					const polled = await api.snapshot(Subagents, context);
					if (polled?.entries[name]?.result !== undefined) break;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		}
		const settled = (await api.snapshot(Subagents, context))?.entries[name];
		return {
			output: [
				{
					type: "text",
					text:
						`Background subagent "${name}" finished${settled?.stopped === true ? " (was stopped)" : ""}. ` +
						`Its answer:\n${settled?.result ?? "(no answer recorded)"}`,
				},
			],
			details: { conversationId: entry.conversation },
		};
	}

	/** Abort the named background child explicitly; the watcher still records how it settled. */
	async function stop(name: string, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
		const doc = await api.snapshot(Subagents, context);
		const entry = doc?.entries[name];
		if (entry === undefined) {
			return { output: [{ type: "text", text: `No subagent named "${name}".` }], isError: true };
		}
		if (entry.background !== true) {
			return {
				output: [
					{ type: "text", text: `"${name}" is not a background subagent; aborting its creating call aborts it.` },
				],
				isError: true,
			};
		}
		const handle = await api.conversation(entry.conversation as ConversationId, context);
		if (handle !== undefined) await handle.abort(context);
		await api.commit(async (tx) => {
			const recorded = (await tx.doc(Subagents)).entries[name];
			if (recorded !== undefined) recorded.stopped = true;
		}, context);
		return {
			output: [
				{
					type: "text",
					text:
						entry.result !== undefined
							? `Stopped "${name}"; its recorded answer stays collectable with wait.`
							: `Stopped "${name}"; how the run settled gets recorded, and wait returns it.`,
				},
			],
			details: { conversationId: entry.conversation },
		};
	}
}
