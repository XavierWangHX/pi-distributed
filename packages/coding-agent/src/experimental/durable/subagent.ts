import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Machine } from "./multienv.ts";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? "";
}

/** What a subagent needs to know about machines: the valid names, and a connection probe for fail-fast. */
export interface SubagentMachines {
	/** Target names, checked when the tool runs (the cluster changes at runtime). */
	names(): string[];
	/** Connect a machine now so an unreachable one fails the call, not the child's first tool use. */
	probe(machine: string): Promise<unknown>;
}

/** This session's named subagents: the name maps to the child conversation a later call can continue. */
const Subagents = defineDoc<{ entries: Record<string, { conversation: number; machine: string; task: string }> }>({
	kind: "app.subagents",
	version: 1,
	scope: "session",
	initial: () => ({ entries: {} }),
});

/**
 * A foreground subagent: each call creates a child conversation owned by the call's task, runs the task there with
 * its tools pinned to `machine`, and returns the child's answer. Aborting the call aborts the child. The child
 * outlives the call, so the user can switch to it and keep talking. A named child can be continued by a later call:
 * it keeps its machine and its whole context. The model-facing channel is `output`.
 *
 * `orchestratorOnly` lists the extensions a child must NOT inherit (machine routing and cluster management): a
 * subagent is an executor pinned to its assigned machine; only the orchestrating conversation manages the cluster.
 */
export function createSubagent(machines: SubagentMachines, orchestratorOnly: readonly Extension[] = []): Extension {
	let self: Extension;
	// eslint-disable-next-line prefer-const
	self = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description:
					`Delegate a self-contained task to a subagent with the same tools (read/write/edit/bash) and get its ` +
					`answer back. Creating one requires machine; its tools run there for the whole conversation. ` +
					`Give it a name to continue it later with continue: it keeps its machine and remembers everything. ` +
					`Give it everything it needs to know; it does not see this conversation.`,
				parameters: Type.Object({
					task: Type.String({
						description: "What the subagent should do (creation), or the follow-up to send (continuation)",
					}),
					name: Type.Optional(
						Type.String({
							description:
								'A short semantic name for this subagent, e.g. "api-research"; registers it for continuation',
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
								"Machine the new subagent's tools execute on (required unless continuing); the machines section lists available names",
						}),
					),
				}),
				// A rerun after a crash finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
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
									task: args.task,
								};
							}
							return created.id;
						}, context);
					}
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
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
				description: "List this session's named subagents (name, machine, first task) to pick one to continue.",
				parameters: Type.Object({}),
				async execute(_args, api, context) {
					const doc = await api.snapshot(Subagents, context);
					const entries = Object.entries(doc?.entries ?? {});
					if (entries.length === 0) {
						return { output: [{ type: "text", text: "(no named subagents yet; pass name when creating one)" }] };
					}
					// The model addresses subagents by name only; ids live in details for the UI.
					const lines = entries.map(
						([name, entry]) => `- ${name} (machine ${entry.machine}): ${entry.task.slice(0, 80)}`,
					);
					return { output: [{ type: "text", text: lines.join("\n") }], details: { entries } };
				},
			}),
		],
	});
	return self;
}
