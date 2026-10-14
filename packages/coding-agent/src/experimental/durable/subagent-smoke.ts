// Headless smoke for background subagents, driven by the faux model: the parent starts an
// ownerless child and returns at once, waits and collects the child's answer through the
// session doc, a completion report lands in the parent's transcript, and stop aborts a
// hanging run. No LLM involved.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	Harness,
	type HarnessSettings,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createSubagent, type SubagentEntry, Subagents } from "./subagent.ts";

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failures++;
}

async function waitFor(what: string, predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function firstUserText(messages: readonly Message[]): string {
	const first = messages.find((message) => message.role === "user");
	if (first?.role !== "user") return "";
	return typeof first.content === "string"
		? first.content
		: first.content.flatMap((block) => (block.type === "text" ? block.text : "")).join("");
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();

// The parent's scripted turns: start bg1, collect it, acknowledge the report, start a hanging
// bg2, stop it, acknowledge the second report.
const parentSteps: AssistantMessage[] = [
	fauxAssistantMessage(
		[
			fauxToolCall(
				"subagent",
				{ task: "count the stars", name: "bg1", machine: "local", background: true },
				{ id: "c1" },
			),
		],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage([fauxToolCall("subagent", { wait: "bg1" }, { id: "c2" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("collected")]),
	fauxAssistantMessage([fauxText("noted")]),
	fauxAssistantMessage(
		[fauxToolCall("subagent", { task: "long job", name: "bg2", machine: "local", background: true }, { id: "c3" })],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage([fauxText("spawned")]),
	fauxAssistantMessage([fauxToolCall("subagent", { stop: "bg2" }, { id: "c4" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("stopped")]),
	fauxAssistantMessage([fauxText("noted2")]),
];
const childSteps: AssistantMessage[] = [fauxAssistantMessage([fauxText("42 stars")])];
let parentStep = 0;
let childStep = 0;
let hung = false;
// Routes by lineage: a child's transcript starts with its task text, the parent's with the smoke's inputs.
const router: FauxResponseStep = (transcript, options) => {
	const first = firstUserText(transcript.messages);
	if (first.includes("count the stars")) return childSteps[Math.min(childStep++, childSteps.length - 1)]!;
	if (first.includes("long job")) {
		hung = true;
		// Never answers; settles only when the abort signal fires (the stop path).
		return new Promise<AssistantMessage>((_resolve, reject) => {
			const signal = options?.signal;
			if (signal === undefined) return;
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}
	return parentSteps[Math.min(parentStep++, parentSteps.length - 1)]!;
};
faux.setResponses(Array.from({ length: 12 }, () => router));

const machines = { names: () => ["local"], probe: async () => ({}) };
let harnessRef: Harness | undefined;
registry.install(
	createSubagent(machines, [], (start) => {
		void hostWatch(start.name, start.parent, start.submission);
	}),
);

/** Mirrors the runtime's babysitter: record the settled answer in the doc, then report to the parent. */
async function hostWatch(name: string, parent: ConversationId, submissionId: SubmissionId): Promise<void> {
	const harness = harnessRef!;
	try {
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		const settled = await submission!.wait(BACKGROUND_CONTEXT);
		let text: string;
		if (settled.status === "done" && settled.type === "input") {
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
			const message = entry?.model?.[0] as AssistantMessage | undefined;
			text = message?.content.flatMap((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
		} else text = `(no answer: ${settled.status === "unanswered" ? settled.reason : settled.status})`;
		await harness.commit(async (tx) => {
			const entry = (await tx.doc(Subagents)).entries[name];
			if (entry !== undefined && entry.result === undefined) {
				entry.result = text;
				entry.settledAt = Date.now();
			}
		}, BACKGROUND_CONTEXT);
		const parentHandle = await harness.conversation(parent, BACKGROUND_CONTEXT);
		await parentHandle?.submit(
			{
				type: "input",
				content: `后台子代理 "${name}" 已完成。它的答案：\n${text}`,
				whenBusy: "followUp",
				entry: { kind: "app.subagent-report" },
			},
			BACKGROUND_CONTEXT,
		);
	} catch {
		// The harness is closing; nothing to report.
	}
}

const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, settings: {} as HarnessSettings, now: () => Date.now() },
	BACKGROUND_CONTEXT,
);
harnessRef = harness;

const docEntries = async (): Promise<Record<string, SubagentEntry>> =>
	(await harness.snapshot(Subagents, BACKGROUND_CONTEXT))?.entries ?? {};

try {
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const entryKinds = async (conversation: Conversation): Promise<string[]> =>
		(await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.kind);
	const turn = async (text: string): Promise<void> => {
		const settled = await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		check(`turn "${text}" done`, settled.status === "done", settled.status === "done" ? "" : String(settled));
	};

	// Turn 1: start bg1; the wait tool collects "42 stars" through the doc; the turn ends.
	await turn("go");
	const bg1 = (await docEntries()).bg1;
	check("bg1 recorded as background", bg1?.background === true && bg1.machine === "local");
	check("bg1 submission recorded", bg1?.submission !== undefined);
	check("bg1 answer recorded in doc", bg1?.result === "42 stars", String(bg1?.result));

	// The report wakes the parent for one more turn ("noted"); wait it out, then inspect the transcript.
	await waitFor("bg1 report entry", async () => (await entryKinds(root)).includes("app.subagent-report"));
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	const transcript = JSON.stringify((await root.entries({}, 256, undefined, BACKGROUND_CONTEXT)).items);
	check("wait tool returned the answer", transcript.includes("42 stars"));
	check("start ack mentioned background", transcript.includes("Background subagent"));

	// Turn 2: bg2 starts and hangs; the parent turn still completes — the child does not hold it.
	await turn("spawn bg2");
	await waitFor("bg2 child generation reached", async () => hung);
	check("bg2 running without an answer", (await docEntries()).bg2?.result === undefined);

	// Turn 3: stop aborts the hanging run; the watcher records how it settled.
	await turn("stop bg2");
	await waitFor("bg2 settled result", async () => (await docEntries()).bg2?.result !== undefined);
	const bg2 = (await docEntries()).bg2;
	check("bg2 marked stopped", bg2?.stopped === true);
	check("bg2 result records the abort", bg2?.result?.includes("no answer") === true, String(bg2?.result));
	await waitFor(
		"bg2 report turn",
		async () => (await entryKinds(root)).filter((kind) => kind === "app.subagent-report").length >= 2,
	);
	await harness.waitForIdle(BACKGROUND_CONTEXT);

	check("child script consumed once", childStep === 1, `childStep=${childStep}`);
	check("parent script consumed", parentStep >= 8, `parentStep=${parentStep}`);
} finally {
	await harness.close(BACKGROUND_CONTEXT);
}
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
