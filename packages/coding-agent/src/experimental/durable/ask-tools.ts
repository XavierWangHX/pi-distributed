// One-shot headless round: ask the agent to enumerate its visible tools. Same wiring as main.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { AssistantEntry, Harness } from "@earendil-works/pi-durable";
import { openPgStorage } from "@earendil-works/pi-durable/storage/pg";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { createMultiEnv, MultiEnvs } from "./multienv.ts";
import { createRegistrar, RegisterService } from "./register.ts";
import { createSubagent } from "./subagent.ts";

const cwd = process.cwd();
const PG_URL = process.env.PI_PG_URL ?? "postgres://pi:pi@localhost:5433/durable";
const modelRuntime = await ModelRuntime.create();
const settingsManager = SettingsManager.create(cwd);
configureHarnessHttp(settingsManager);
const registry = createCodingRegistry(settingsManager, cwd);
const multienvs = await MultiEnvs.create(PG_URL, cwd);
const registrar = await RegisterService.create(multienvs);
registry.install(createSubagent(multienvs));
registry.install(createMultiEnv(multienvs));
registry.install(createRegistrar(registrar));

const db = `pi_ask_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const harness = await Harness.open(await openPgStorage(PG_URL, { schema: db }), {
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
await registrar.stop();
await multienvs.cleanup();
process.exit(0);
