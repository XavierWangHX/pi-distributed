// One-shot headless round: ask the agent to enumerate its visible tools. Same wiring as main.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantEntry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { createMultiEnv, MultiEnvs } from "./multienv.ts";
import { createSubagent } from "./subagent.ts";

const cwd = process.cwd();
const modelRuntime = await ModelRuntime.create();
const settingsManager = SettingsManager.create(cwd);
configureHarnessHttp(settingsManager);
const registry = createCodingRegistry(settingsManager, cwd);
const multienvs = new MultiEnvs(cwd);
registry.install(createSubagent(multienvs));
registry.install(createMultiEnv(multienvs));

const db = join(mkdtempSync(join(tmpdir(), "pi-ask-tools-")), "session.sqlite");
const harness = await Harness.open(await openNodeSqliteStorage(db), {
	models: modelRuntime,
	registry,
	settings: createHarnessSettings(settingsManager),
	env: multienvs.env,
}, BACKGROUND_CONTEXT);

const initial = await findInitialAgentModel(settingsManager, modelRuntime);
const root = await harness.root(BACKGROUND_CONTEXT, {
	agent: {
		cwd,
		...(initial?.model === undefined ? {} : { model: initial.model }),
		...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
	},
});
console.log(`model: ${initial?.model?.provider ?? "?"}/${initial?.model?.modelId ?? "?"}\n`);
const question =
	process.argv[2] ??
	("请列出你当前可用的全部工具（tool 名称）清单，每个工具一句话说明用途。" +
		"这是元问题：不要调用任何工具，直接回答清单本身。");
console.log(`prompt: ${question}\n`);
const submission = await root.submit({ type: "input", content: question }, BACKGROUND_CONTEXT);
const settled = await submission.wait(BACKGROUND_CONTEXT);
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
	const text = (entry?.model?.[0]?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	console.log(text || "(no text)");
} else {
	console.error("did not complete:", JSON.stringify(settled).slice(0, 500));
}
await harness.close(BACKGROUND_CONTEXT);
await multienvs.cleanup();
process.exit(0);
