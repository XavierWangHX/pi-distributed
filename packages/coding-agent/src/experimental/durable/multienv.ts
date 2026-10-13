// Multi-machine hands for the durable agent, conversation-routed: a `machine` document selects
// which machine the conversation's native tools (read/write/edit/bash) execute on. `use_machine`
// switches it; the Harness env callback reads the document and resolves the ExecutionEnv.
// Targets live in PostgreSQL (pi_machines.targets) — the sole source of truth, shared by every
// session and immune to local file loss; "local" (this machine) is always available.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import pg from "pg";
import { Type } from "typebox";
import {
	acceptHostKey,
	connectSsh,
	Connection,
	HostKeyUnknownError,
	LocalExecutionEnv,
	packagedDaemon,
	RemoteExecutionEnv,
	scanHostKey,
} from "@earendil-works/pi-env";
import { localDaemon } from "@earendil-works/pi-env";

interface RemoteTarget {
	name: string;
	kind: "ssh" | "docker";
	host?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	cwd?: string;
	container?: string;
	daemonPath?: string;
	trustOnFirstUse?: boolean;
}

const KNOWN_HOSTS = join(homedir(), ".pi", "agent", "multienv-known-hosts");

/** Where the pi-env daemon lives inside a container machine. */
const DEFAULT_DAEMON_PATH = "/usr/local/bin/pi-env";
const DEFAULT_CONTAINER_IMAGE = "ubuntu:24.04";
const DAEMON_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/** Run a local command (the docker CLI), resolving with stdout; no shell is involved. */
function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0]!, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: Error) => reject(new Error(`${args[0]} failed: ${error.message}`)));
		child.on("close", (code) => {
			if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
			reject(new Error(`${args.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
		});
	});
}

/**
 * Put the packaged linux daemon into a running container, verified by SHA-256 before it ever runs
 * (the same discipline as the SSH deployment): skip when the right bytes are already there, copy
 * with `docker cp`, then re-verify. The daemon is static-pie, so any distro base works.
 */
async function deployDaemonToContainer(container: string, daemonPath: string): Promise<void> {
	if (!DAEMON_PATH_PATTERN.test(daemonPath) || daemonPath.includes("..")) {
		throw new Error(`Invalid daemon path in container: ${JSON.stringify(daemonPath)}`);
	}
	const arch = (await run(["docker", "exec", container, "uname", "-m"])).trim();
	const normalized =
		arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : undefined;
	if (normalized === undefined) throw new Error(`Unsupported container architecture: ${arch}`);
	const binary = packagedDaemon({ platform: "linux", arch: normalized });
	const bytes = await readFile(binary);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const present = await run(["docker", "exec", container, "sh", "-c", `sha256sum '${daemonPath}' 2>/dev/null || true`]).catch(
		() => "",
	);
	if (present.includes(sha256)) return;
	await run(["docker", "cp", binary, `${container}:${daemonPath}`]);
	await run(["docker", "exec", container, "chmod", "700", daemonPath]);
	const check = await run(["docker", "exec", container, "sh", "-c", `sha256sum '${daemonPath}'`]);
	if (!check.includes(sha256)) throw new Error(`pi-env copy into ${container} is corrupt`);
}

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
	#pg: pg.Client | undefined;

	private constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	/** Connect the fleet database, ensure its table, and load every target. */
	static async create(pgUrl: string, defaultCwd: string): Promise<MultiEnvs> {
		const multienvs = new MultiEnvs(defaultCwd);
		const client = new pg.Client({ connectionString: pgUrl });
		await client.connect();
		multienvs.#pg = client;
		await client.query("CREATE SCHEMA IF NOT EXISTS pi_machines");
		await client.query(`CREATE TABLE IF NOT EXISTS pi_machines.targets (
			name TEXT PRIMARY KEY,
			kind TEXT NOT NULL DEFAULT 'ssh' CHECK (kind IN ('ssh', 'docker')),
			host TEXT, username TEXT, port INTEGER, cwd TEXT, container TEXT, daemon_path TEXT,
			trust_on_first_use BOOLEAN NOT NULL DEFAULT TRUE,
			created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
			last_registered BIGINT
		)`);
		// Databases created before the registration service gained this column.
		await client.query("ALTER TABLE pi_machines.targets ADD COLUMN IF NOT EXISTS port INTEGER");
		const rows = await client.query(
			"SELECT name, kind, host, username, port, cwd, container, daemon_path, trust_on_first_use FROM pi_machines.targets",
		);
		for (const row of rows.rows) {
			multienvs.#targets.set(row.name as string, {
				name: row.name as string,
				kind: row.kind as "ssh" | "docker",
				host: row.host ?? undefined,
				user: row.username ?? undefined,
				port: row.port ?? undefined,
				cwd: row.cwd ?? undefined,
				container: row.container ?? undefined,
				daemonPath: row.daemon_path ?? undefined,
				trustOnFirstUse: row.trust_on_first_use ?? true,
			});
		}
		return multienvs;
	}

	/** Register a target durably (upsert) and make it usable right away. */
	async addTarget(target: RemoteTarget): Promise<void> {
		if (this.#pg === undefined) throw new Error("MultiEnvs is closed");
		await this.#pg.query(
			`INSERT INTO pi_machines.targets (name, kind, host, username, port, cwd, container, daemon_path, trust_on_first_use)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, host = excluded.host,
				username = excluded.username, port = excluded.port, cwd = excluded.cwd, container = excluded.container,
				daemon_path = excluded.daemon_path, trust_on_first_use = excluded.trust_on_first_use,
				last_registered = (extract(epoch from now()) * 1000)::bigint`,
			[
				target.name,
				target.kind,
				target.host ?? null,
				target.user ?? null,
				target.port ?? null,
				target.cwd ?? null,
				target.container ?? null,
				target.daemonPath ?? null,
				target.trustOnFirstUse ?? true,
			],
		);
		this.#targets.set(target.name, target);
	}

	/** Remove a target durably; a conversation already on it falls back to local at its next use. */
	async removeTarget(name: string): Promise<void> {
		if (this.#pg === undefined) throw new Error("MultiEnvs is closed");
		await this.#pg.query("DELETE FROM pi_machines.targets WHERE name = $1", [name]);
		this.#targets.delete(name);
		const cached = this.#remoteEnvs.get(name);
		if (cached !== undefined) {
			this.#remoteEnvs.delete(name);
			await cached.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
		}
	}

	/** The registered target's record, for tools that manage the fleet. */
	target(name: string): RemoteTarget | undefined {
		return this.#targets.get(name);
	}

	names(): string[] {
		return ["local", ...[...this.#targets.keys()]];
	}

	describeTargets(): string {
		const rows = ["local (this machine)"];
		for (const target of this.#targets.values()) {
			const address = `${target.host ?? "?"}${target.port !== undefined ? `:${target.port}` : ""}`;
			rows.push(`${target.name} (${address}${target.user ? `, user ${target.user}` : ""})`);
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
		const target = this.#targets.get(name)!;
		if (target.kind === "docker") {
			const container = target.container ?? target.name;
			const daemonPath = target.daemonPath ?? DEFAULT_DAEMON_PATH;
			await deployDaemonToContainer(container, daemonPath);
			const connection = new Connection({ command: ["docker", "exec", "-i", container, daemonPath] });
			const env = new RemoteExecutionEnv({ connection, id: `pi-env:${target.name}`, cwd: target.cwd ?? "/" });
			this.#remoteEnvs.set(name, env);
			return env;
		}
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
		if (this.#pg !== undefined) {
			await this.#pg.end().catch(() => undefined);
			this.#pg = undefined;
		}
	}
}

/** The multi-env extension: machine switching for conversations, plus docker sandbox lifecycle. */
export function createMultiEnv(multienvs: MultiEnvs) {
	const machineName = (name: string): string => {
		if (name === "local") throw new Error('"local" is reserved for this machine');
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw new Error(`Invalid machine name: ${JSON.stringify(name)}`);
		return name;
	};
	const knownMachine = (name: string): string => {
		if (!multienvs.names().includes(name)) {
			throw new Error(
				`Unknown machine "${name}". Known: ${multienvs.names().join(", ")}. ` +
					`Add one with create_machine (docker sandbox) or create_install_command (physical/VM machine).`,
			);
		}
		return name;
	};
	return defineExtension({
		name: "multi-env",
		tools: [
			defineTool({
				name: "use_machine",
				description:
					`Switch the machine this conversation's tools (read/write/edit/bash) execute on. ` +
					`The switch takes effect from the next tool call and persists for the conversation, ` +
					`including after restart. The machines section lists what is available right now; ` +
					`"local" is this machine.`,
				parameters: Type.Object({
					target: Type.String({
						description: 'Name of the machine to run this conversation\'s tools on, e.g. "local" or "gpu-1"',
					}),
				}),
				async execute(args, api, context) {
					const name = knownMachine(args.target);
					await multienvs.envFor(name); // Fail fast: connect and deploy the daemon now.
					await api.commit(async (tx) => {
						(await tx.doc(Machine, api.conversationId)).target = name;
					}, context);
					const kind = multienvs.target(name)?.kind;
					return {
						output: [
							{
								type: "text",
								text:
									`Switched to ${name}. ` +
									(name === "local"
										? "read/write/edit/bash now run on this machine."
										: kind === "docker"
											? `read/write/edit/bash now run inside the ${name} container (Linux paths).`
											: `read/write/edit/bash now run on ${name}; check the machines section for its platform conventions.`),
							},
						],
					};
				},
			}),
			defineTool({
				name: "create_machine",
				description:
					`Create a docker container on THIS machine and add it to the fleet as a sandbox. ` +
					`Use it to isolate untrusted work, or to run parallel subagents each in its own container. ` +
					`The pi-env daemon is deployed into the container automatically; the container is ready ` +
					`for use_machine and subagent(machine=...) when this returns.`,
				parameters: Type.Object({
					name: Type.String({ description: 'Machine name for the sandbox, e.g. "sbx-1"' }),
					image: Type.Optional(
						Type.String({ description: `Container image (default ${DEFAULT_CONTAINER_IMAGE})` }),
					),
				}),
				async execute(args) {
					const name = machineName(args.name);
					knownMachineOrFree(name);
					const image = args.image ?? DEFAULT_CONTAINER_IMAGE;
					try {
						await run(["docker", "run", "-d", "--name", name, image, "sleep", "infinity"]);
					} catch (error) {
						throw new Error(withDockerHint(error));
					}
					await multienvs.addTarget({
						name,
						kind: "docker",
						container: name,
						daemonPath: DEFAULT_DAEMON_PATH,
						cwd: "/",
					});
					try {
						await multienvs.envFor(name); // Fail fast: deploy and verify the daemon now.
					} catch (error) {
						await run(["docker", "rm", "-f", name]).catch(() => undefined);
						await multienvs.removeTarget(name).catch(() => undefined);
						throw error;
					}
					return {
						output: [
							{
								type: "text",
								text:
									`Created machine "${name}" (docker container from ${image}). ` +
									`Switch to it with use_machine("${name}"), or hand it to a subagent with machine: "${name}". ` +
									`Destroy it with destroy_machine("${name}") when done.`,
							},
						],
					};

					function knownMachineOrFree(free: string): void {
						if (multienvs.names().includes(free)) throw new Error(`Machine "${free}" already exists`);
					}
				},
			}),
			defineTool({
				name: "destroy_machine",
				description:
					`Remove a machine from the fleet. A docker sandbox's container is deleted; an SSH machine ` +
					`is only unregistered (the machine itself is untouched). Conversations currently on it ` +
					`fall back to local.`,
				parameters: Type.Object({
					name: Type.String({ description: "Name of the machine to remove" }),
				}),
				async execute(args) {
					const name = args.name;
					if (name === "local") throw new Error("The local machine cannot be destroyed");
					const target = multienvs.target(name);
					if (target === undefined) throw new Error(`Unknown machine "${name}"`);
					if (target.kind === "docker") {
						await run(["docker", "rm", "-f", target.container ?? name]).catch(() => undefined);
					}
					await multienvs.removeTarget(name);
					return {
						output: [
							{
								type: "text",
								text:
									target.kind === "docker"
										? `Destroyed machine "${name}" (container removed).`
										: `Unregistered machine "${name}" (the machine itself is untouched).`,
							},
						],
					};
				},
			}),
			defineTool({
				name: "list_machines",
				description: "List the fleet: every machine this conversation can run tools on, with kind and address.",
				parameters: Type.Object({}),
				async execute() {
					const lines: string[] = ["local (this machine)"];
					for (const name of multienvs.names()) {
						if (name === "local") continue;
						const target = multienvs.target(name)!;
						if (target.kind === "docker") {
							const status = await run([
								"docker",
								"inspect",
								"--format",
								"{{.State.Status}}",
								target.container ?? name,
							]).catch(() => "gone");
							lines.push(`${name} (docker container, ${status.trim()})`);
						} else {
							const address = `${target.host ?? "?"}${target.port !== undefined ? `:${target.port}` : ""}`;
							lines.push(`${name} (ssh ${address}${target.user ? `, user ${target.user}` : ""})`);
						}
					}
					return { output: [{ type: "text", text: lines.join("\n") }] };
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

/** A failed docker CLI call is usually a missing CLI or daemon; say so plainly. */
function withDockerHint(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return /ENOENT|not found/i.test(message)
		? `${message} — is the docker CLI installed and the docker daemon running on this machine?`
		: message;
}
