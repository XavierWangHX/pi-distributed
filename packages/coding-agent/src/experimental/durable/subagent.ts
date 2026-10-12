import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
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
	/** Target names for the tool's schema, evaluated when the extension is created. */
	names(): string[];
	/** Connect a machine now so an unreachable one fails the call, not the child's first tool use. */
	probe(machine: string): Promise<unknown>;
}

/**
 * A foreground subagent: each call creates a child conversation owned by the call's task, runs the task there with
 * its tools pinned to `machine`, and returns the child's answer. Aborting the call aborts the child. The child
 * outlives the call, so the user can switch to it and keep talking.
 */
export function createSubagent(machines: SubagentMachines): Extension {
	let self: Extension;
	// eslint-disable-next-line prefer-const
	self = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description:
					`Delegate a self-contained task to a subagent with the same tools (read/write/edit/bash) and get its ` +
					`answer back. The subagent's tools run on the machine you pass, for its whole conversation. ` +
					`Give it everything it needs to know; it does not see this conversation.`,
				parameters: Type.Object({
					task: Type.String({ description: "What the subagent should do" }),
					machine: Type.Union(
						machines.names().map((name) => Type.Literal(name)),
						{ description: "Which machine the subagent's tools execute on" },
					),
				}),
				// A rerun after a crash finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
					await machines.probe(args.machine);
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						// Starts as a copy of this conversation's agent; without this extension it cannot delegate further.
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { extensions: { remove: [self] } });
						(await tx.doc(Machine, created.id)).target = args.machine;
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input") {
						throw new Error(`Subagent ${child} failed: ${settled.status}`);
					}
				const text = await answerText(api, settled.answer, context);
				// The model-facing channel is `output` (ToolExecutionResult has no `content` field).
				return { output: [{ type: "text", text }], details: { conversationId: child } };
				},
			}),
		],
	});
	return self;
}
