// Multi-machine hands for the durable agent, conversation-routed: a `machine` document selects
// which machine the conversation's native tools (read/write/edit/bash) execute on. `use_machine`
// switches it; the Harness env callback reads the document and resolves the ExecutionEnv.
// Targets come from ~/.pi/agent/targets.json; "local" (this machine) is always available.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import {
	acceptHostKey,
	connectSsh,
	Connection,
	HostKeyUnknownError,
	LocalExecutionEnv,
	RemoteExecutionEnv,
	scanHostKey,
} from "@earendil-works/pi-env";
import { localDaemon } from "@earendil-works/pi-env";

interface RemoteTarget {
	name: string;
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	cwd?: string;
	trustOnFirstUse?: boolean;
}

const TARGETS_FILE = join(homedir(), ".pi", "agent", "targets.json");
const KNOWN_HOSTS = join(homedir(), ".pi", "agent", "multienv-known-hosts");

/** The machine this conversation's tools execute on. A fork starts on its parent's machine. */
export const Machine = defineDoc<{ target: string }>({
	kind: "app.machine",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ target: "local" }),
});

/** Owns the targets and every remote environment of the session, and routes the env callback. */
export class MultiEnvs {
	readonly #defaultCwd: string;
	readonly #targets = new Map<string, RemoteTarget>();
	readonly #localEnvs = new Map<string, LocalExecutionEnv>();
	#localConnection: Connection | undefined;
	readonly #remoteEnvs = new Map<string, RemoteExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
		if (!existsSync(TARGETS_FILE)) return;
		try {
			const parsed = JSON.parse(readFileSync(TARGETS_FILE, "utf8")) as { targets?: RemoteTarget[] };
			for (const target of parsed.targets ?? []) {
				if (target?.name && target.host) this.#targets.set(target.name, target);
			}
		} catch {
			// A broken targets.json leaves the agent local-only; the native tools still work.
		}
	}

	names(): string[] {
		return ["local", ...[...this.#targets.keys()]];
	}

	describeTargets(): string {
		const rows = ["local (this machine)"];
		for (const target of this.#targets.values()) {
			rows.push(`${target.name} (${target.host}${target.user ? `, user ${target.user}` : ""})`);
		}
		return rows.join("; ");
	}

	#sshTargetOf(target: RemoteTarget) {
		return {
			host: target.host,
			user: target.user,
			port: target.port,
			identityFile: target.identityFile,
			knownHostsFile: KNOWN_HOSTS,
			hostKeyAlias: `pi-env-${target.name}`,
		};
	}

	/** The named machine's environment; a remote's first call connects and deploys the daemon. */
	async envFor(name: string, cwd?: string): Promise<ExecutionEnv> {
		if (name === "local" || !this.#targets.has(name)) {
			const directory = cwd ?? this.#defaultCwd;
			let env = this.#localEnvs.get(directory);
			if (env === undefined) {
				if (this.#localConnection === undefined) {
					this.#localConnection = new Connection({ command: [localDaemon()] });
				}
				env = new LocalExecutionEnv({ connection: this.#localConnection, cwd: directory });
				this.#localEnvs.set(directory, env);
			}
			return env;
		}
		const cached = this.#remoteEnvs.get(name);
		if (cached) return cached;
		const target = this.#targets.get(name);
		let connection: Awaited<ReturnType<typeof connectSsh>>["connection"];
		try {
			({ connection } = await connectSsh(this.#sshTargetOf(target)));
		} catch (error) {
			if (error instanceof HostKeyUnknownError && target.trustOnFirstUse) {
				const { lines } = await scanHostKey(this.#sshTargetOf(target));
				await acceptHostKey(this.#sshTargetOf(target), lines);
				({ connection } = await connectSsh(this.#sshTargetOf(target)));
			} else {
				throw error;
			}
		}
		const env = new RemoteExecutionEnv({ connection, id: `pi-env:${name}`, cwd: target.cwd ?? "." });
		this.#remoteEnvs.set(name, env);
		return env;
	}

	/** Connect a machine now; used for fail-fast before handing it to a subagent. */
	probe(name: string): Promise<ExecutionEnv> {
		return this.envFor(name);
	}

	/**
	 * The Harness env callback: reads the conversation's machine document and resolves that machine.
	 * A read failure or an unknown target falls back to local, so a broken document never blocks tools.
	 */
	readonly env = async (target: {
		conversationId: import("@earendil-works/pi-durable").ConversationId;
		cwd?: string;
		read: import("@earendil-works/pi-durable").DocumentReader;
	}): Promise<ExecutionEnv> => {
		let name = "local";
		try {
			const doc = await target.read.snapshot(Machine, target.conversationId, BACKGROUND_CONTEXT);
			if (doc && typeof doc.target === "string" && (doc.target === "local" || this.#targets.has(doc.target))) {
				name = doc.target;
			}
		} catch {
			// Fall back to local.
		}
		return this.envFor(name, target.cwd);
	};

	async cleanup(): Promise<void> {
		for (const env of this.#remoteEnvs.values()) await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
		this.#remoteEnvs.clear();
		for (const env of this.#localEnvs.values()) await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
		this.#localEnvs.clear();
		if (this.#localConnection !== undefined) {
			try {
				this.#localConnection.close();
			} catch {
				// A connection that already ended needs no closing.
			}
			this.#localConnection = undefined;
		}
	}
}

/** The multi-env extension: one tool, `use_machine`, which switches the conversation's machine. */
export function createMultiEnv(multienvs: MultiEnvs) {
	const names = multienvs.names();
	return defineExtension({
		name: "multi-env",
		tools: [
			defineTool({
				name: "use_machine",
				description:
					`Switch the machine this conversation's tools (read/write/edit/bash) execute on. ` +
					`The switch takes effect from the next tool call and persists for the conversation, ` +
					`including after restart. Available machines: ${multienvs.describeTargets()}.`,
				parameters: Type.Object({
					target: Type.Union(names.map((name) => Type.Literal(name)), {
						description: "Which machine to run this conversation's tools on",
					}),
				}),
				async execute(args, api, context) {
					await multienvs.envFor(args.target); // Fail fast: connect and deploy the daemon now.
					await api.commit(async (tx) => {
						(await tx.doc(Machine, api.conversationId)).target = args.target;
					}, context);
					return {
						output: [
							{
								type: "text",
								text:
									`Switched to ${args.target}. ` +
									(args.target === "local"
										? "read/write/edit/bash now run on this machine."
										: `read/write/edit/bash now run on ${args.target}; use Windows-style paths (G:\\dir\\file) for file tools and expect Git Bash for bash.`),
							},
						],
					};
				},
			}),
		],
		sections: [
			section("machines", async (input, renderContext) => {
				const doc = await input.read.snapshot(Machine, input.conversationId, renderContext).catch(() => undefined);
				const current = doc?.target ?? "local";
				return (
					`You can operate several machines; read/write/edit/bash run on the conversation's current ` +
					`machine (${current}). Switch with use_machine. Available: ${multienvs.describeTargets()}.`
				);
			}),
		],
	});
}
