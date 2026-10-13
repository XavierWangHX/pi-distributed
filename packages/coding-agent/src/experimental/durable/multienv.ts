// Multi-machine hands for the durable agent, conversation-routed: a `machine` document selects
// which machine the conversation's native tools (read/write/edit/bash) execute on. `use_machine`
// switches it; the Harness env callback reads the document and resolves the ExecutionEnv.
// Targets live in PostgreSQL (pi_machines.targets) — the sole source of truth, shared by every
// session and immune to local file loss; "local" (this machine) is always available.
// Snapshots (pi_machines.snapshots) capture docker machines' filesystem state for clone and
// rollback — the machine timeline, which only the orchestrating conversation may operate.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	acceptHostKey,
	Connection,
	connectSsh,
	HostKeyUnknownError,
	LocalExecutionEnv,
	localDaemon,
	packagedDaemon,
	RemoteExecutionEnv,
	scanHostKey,
} from "@earendil-works/pi-env";
import pg from "pg";
import { Type } from "typebox";
import type { RegisterService } from "./register.ts";

interface RemoteTarget {
	name: string;
	type: "ssh" | "docker";
	host?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	cwd?: string;
	container?: string;
	daemonPath?: string;
	trustOnFirstUse?: boolean;
}

/** A point-in-time capture of a machine's environment, registered in the cluster database. */
export interface MachineSnapshot {
	readonly id: string;
	/** The machine it was taken from; snapshots outlive their machine. */
	readonly machine: string;
	/** Which runtime captured it; only docker (`docker commit`) for now. */
	readonly backend: "docker";
	/** Backend-specific locator; for docker, the committed local image. */
	readonly image: string;
	readonly label?: string;
	readonly createdAt: number;
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
	const present = await run([
		"docker",
		"exec",
		container,
		"sh",
		"-c",
		`sha256sum '${daemonPath}' 2>/dev/null || true`,
	]).catch(() => "");
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
	readonly #snapshots = new Map<string, MachineSnapshot>();
	readonly #localEnvs = new Map<string, LocalExecutionEnv>();
	#localConnection: Connection | undefined;
	readonly #remoteEnvs = new Map<string, RemoteExecutionEnv>();
	#pg: pg.Client | undefined;

	private constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	/** Connect the cluster database, ensure its tables, and load every target and snapshot. */
	static async create(pgUrl: string, defaultCwd: string): Promise<MultiEnvs> {
		const multienvs = new MultiEnvs(defaultCwd);
		const client = new pg.Client({ connectionString: pgUrl });
		await client.connect();
		multienvs.#pg = client;
		await client.query("CREATE SCHEMA IF NOT EXISTS pi_machines");
		await client.query(`CREATE TABLE IF NOT EXISTS pi_machines.targets (
			name TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'ssh' CHECK (type IN ('ssh', 'docker')),
			host TEXT, username TEXT, port INTEGER, cwd TEXT, container TEXT, daemon_path TEXT,
			trust_on_first_use BOOLEAN NOT NULL DEFAULT TRUE,
			created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
			last_registered BIGINT
		)`);
		// Databases created before the registration service gained this column.
		await client.query("ALTER TABLE pi_machines.targets ADD COLUMN IF NOT EXISTS port INTEGER");
		// Databases created before pi_machines.targets renamed its kind column to type.
		const legacy = await client.query(
			"SELECT 1 FROM information_schema.columns WHERE table_schema = 'pi_machines' AND table_name = 'targets' AND column_name = 'kind'",
		);
		if ((legacy.rowCount ?? 0) > 0) await client.query("ALTER TABLE pi_machines.targets RENAME COLUMN kind TO type");
		await client.query(`CREATE TABLE IF NOT EXISTS pi_machines.snapshots (
			id TEXT PRIMARY KEY,
			machine TEXT NOT NULL,
			backend TEXT NOT NULL,
			image TEXT NOT NULL,
			label TEXT,
			created_at BIGINT NOT NULL
		)`);
		const rows = await client.query(
			"SELECT name, type, host, username, port, cwd, container, daemon_path, trust_on_first_use FROM pi_machines.targets",
		);
		for (const row of rows.rows) {
			multienvs.#targets.set(row.name as string, {
				name: row.name as string,
				type: row.type as "ssh" | "docker",
				host: row.host ?? undefined,
				user: row.username ?? undefined,
				port: row.port ?? undefined,
				cwd: row.cwd ?? undefined,
				container: row.container ?? undefined,
				daemonPath: row.daemon_path ?? undefined,
				trustOnFirstUse: row.trust_on_first_use ?? true,
			});
		}
		const snapshots = await client.query(
			"SELECT id, machine, backend, image, label, created_at FROM pi_machines.snapshots",
		);
		for (const row of snapshots.rows) {
			multienvs.#snapshots.set(row.id as string, {
				id: row.id as string,
				machine: row.machine as string,
				backend: row.backend as "docker",
				image: row.image as string,
				...(row.label === null ? {} : { label: row.label as string }),
				createdAt: Number(row.created_at),
			});
		}
		return multienvs;
	}

	/** Register a target durably (upsert) and make it usable right away. */
	async addTarget(target: RemoteTarget): Promise<void> {
		if (this.#pg === undefined) throw new Error("MultiEnvs is closed");
		await this.#pg.query(
			`INSERT INTO pi_machines.targets (name, type, host, username, port, cwd, container, daemon_path, trust_on_first_use)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (name) DO UPDATE SET type = excluded.type, host = excluded.host,
				username = excluded.username, port = excluded.port, cwd = excluded.cwd, container = excluded.container,
				daemon_path = excluded.daemon_path, trust_on_first_use = excluded.trust_on_first_use,
				last_registered = (extract(epoch from now()) * 1000)::bigint`,
			[
				target.name,
				target.type,
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
		await this.discardEnv(name);
	}

	/** Drop the cached environment of a machine whose runtime was replaced (rollback); the next envFor reconnects. */
	async discardEnv(name: string): Promise<void> {
		const cached = this.#remoteEnvs.get(name);
		if (cached === undefined) return;
		this.#remoteEnvs.delete(name);
		await cached.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
	}

	/** The registered target's record, for tools that manage the cluster. */
	target(name: string): RemoteTarget | undefined {
		return this.#targets.get(name);
	}

	names(): string[] {
		return ["local", ...[...this.#targets.keys()]];
	}

	describeTargets(): string {
		const rows = ["local (this machine)"];
		for (const target of this.#targets.values()) {
			rows.push(
				target.type === "docker"
					? `${target.name} (docker container)`
					: `${target.name} (${target.host ?? "?"}${target.port !== undefined ? `:${target.port}` : ""}${
							target.user ? `, user ${target.user}` : ""
						})`,
			);
		}
		return rows.join("; ");
	}

	/** The registered snapshot, by id. */
	snapshot(id: string): MachineSnapshot | undefined {
		return this.#snapshots.get(id);
	}

	/** Every snapshot, oldest first. */
	snapshots(): MachineSnapshot[] {
		return [...this.#snapshots.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	describeSnapshots(): string {
		const snapshots = this.snapshots();
		if (snapshots.length === 0) return "(none)";
		return snapshots
			.map(
				(snapshot) =>
					`${snapshot.id} (of ${snapshot.machine}, ${snapshot.backend}${
						snapshot.label === undefined ? "" : `, "${snapshot.label}"`
					})`,
			)
			.join("; ");
	}

	/**
	 * Capture a docker machine's filesystem state: `docker commit` the container into a local snapshot image and
	 * register it durably. Processes and memory are NOT captured — the fallback until a micro-VM backend brings
	 * O(1) snapshots; services must be restarted after a restore.
	 */
	async snapshotMachine(name: string, label?: string): Promise<MachineSnapshot> {
		const target = this.#dockerTarget(name);
		if (this.#pg === undefined) throw new Error("MultiEnvs is closed");
		const id = `snap-${randomBytes(4).toString("hex")}`;
		const image = `pi-snapshot:${id}`;
		await run(["docker", "commit", target.container ?? name, image]);
		const snapshot: MachineSnapshot = {
			id,
			machine: name,
			backend: "docker",
			image,
			createdAt: Date.now(),
			...(label === undefined ? {} : { label }),
		};
		await this.#pg.query(
			"INSERT INTO pi_machines.snapshots (id, machine, backend, image, label, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			[snapshot.id, snapshot.machine, snapshot.backend, snapshot.image, snapshot.label ?? null, snapshot.createdAt],
		);
		this.#snapshots.set(id, snapshot);
		return snapshot;
	}

	/**
	 * Roll a docker machine back to a snapshot: recreate its container from the snapshot image, discard the stale
	 * cached environment, and redeploy the daemon (fail fast). The machine's environment timeline moves back to the
	 * snapshot; on failure the recreated container stays up for debugging.
	 */
	async rollbackMachine(name: string, snapshotId: string): Promise<MachineSnapshot> {
		const target = this.#dockerTarget(name);
		const snapshot = this.#snapshots.get(snapshotId);
		if (snapshot === undefined) throw new Error(`Unknown snapshot "${snapshotId}"`);
		const container = target.container ?? name;
		await run(["docker", "rm", "-f", container]).catch(() => undefined);
		await run(["docker", "run", "-d", "--name", container, snapshot.image, "sleep", "infinity"]);
		await this.discardEnv(name);
		await this.envFor(name); // Redeploy and verify the daemon now.
		return snapshot;
	}

	/** Delete a snapshot registration durably; its docker image goes with it. */
	async removeSnapshot(id: string): Promise<void> {
		if (this.#pg === undefined) throw new Error("MultiEnvs is closed");
		const snapshot = this.#snapshots.get(id);
		if (snapshot === undefined) return;
		await this.#pg.query("DELETE FROM pi_machines.snapshots WHERE id = $1", [id]);
		this.#snapshots.delete(id);
		await run(["docker", "rmi", "-f", snapshot.image]).catch(() => undefined);
	}

	#dockerTarget(name: string): RemoteTarget {
		const target = this.#targets.get(name);
		if (target === undefined) throw new Error(`Unknown machine "${name}"`);
		if (target.type !== "docker") {
			throw new Error(
				`Machine "${name}" is ${target.type}; snapshots and rollback need a docker machine ` +
					`(O(1) snapshots arrive with the micro-VM backend)`,
			);
		}
		return target;
	}

	#sshTargetOf(target: RemoteTarget) {
		if (target.host === undefined) throw new Error(`SSH machine "${target.name}" has no host`);
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
		if (target.type === "docker") {
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

/**
 * The multi-env extension: machine switching for conversations, cluster membership (docker sandboxes,
 * physical-machine install commands), and the machine timeline (snapshot/rollback/clone).
 */
export function createMultiEnv(multienvs: MultiEnvs, registrar: RegisterService) {
	const machineName = (name: string): string => {
		if (name === "local") throw new Error('"local" is reserved for this machine');
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name))
			throw new Error(`Invalid machine name: ${JSON.stringify(name)}`);
		return name;
	};
	const knownMachine = (name: string): string => {
		if (!multienvs.names().includes(name)) {
			throw new Error(
				`Unknown machine "${name}". Known: ${multienvs.names().join(", ")}. ` +
					`Add one with create_machine — a docker sandbox, or type "physical" for an install link.`,
			);
		}
		return name;
	};
	const requireSnapshot = (id: string): MachineSnapshot => {
		const snapshot = multienvs.snapshot(id);
		if (snapshot === undefined) {
			const known = multienvs.snapshots().map((entry) => entry.id);
			throw new Error(
				`Unknown snapshot "${id}". Known: ${
					known.length > 0 ? known.join(", ") : "(none yet; take one with snapshot_machine)"
				}.`,
			);
		}
		return snapshot;
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
					const type = multienvs.target(name)?.type;
					return {
						output: [
							{
								type: "text",
								text:
									`Switched to ${name}. ` +
									(name === "local"
										? "read/write/edit/bash now run on this machine."
										: type === "docker"
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
					`Add a machine to the cluster. type "docker" (default): create a container sandbox on THIS ` +
					`machine — use it to isolate untrusted work, or to run parallel subagents each in its own ` +
					`container; pass from_snapshot to clone from a snapshot (e.g. one rollout per clone); the pi-env ` +
					`daemon is deployed automatically and the container is ready for use_machine and ` +
					`subagent(machine=...) when this returns. ` +
					`type "physical": mint the install link for a physical/VM machine — a one-line command embedding ` +
					`this machine's SSH public key, a single-use token and the callback URL. Give the command to the ` +
					`user verbatim; do NOT run it yourself. The user runs it once on the target (sudo bash / elevated ` +
					`PowerShell); it installs sshd, authorizes the key, and the machine registers itself here.`,
				parameters: Type.Object({
					name: Type.String({ description: 'Machine name, e.g. "sbx-1" (docker) or "gpu-1" (physical)' }),
					type: Type.Optional(
						Type.Union([Type.Literal("docker"), Type.Literal("physical")], {
							description:
								"docker (default): container sandbox on this machine. physical: install link for a physical/VM machine",
						}),
					),
					image: Type.Optional(
						Type.String({ description: `docker only: container image (default ${DEFAULT_CONTAINER_IMAGE})` }),
					),
					from_snapshot: Type.Optional(
						Type.String({
							description:
								"docker only: snapshot id to clone the machine from (the machines section lists them); pass either this or image",
						}),
					),
					os: Type.Optional(
						Type.Union([Type.Literal("linux"), Type.Literal("windows")], {
							description: "physical only: the target machine's operating system (default linux)",
						}),
					),
				}),
				async execute(args) {
					const name = machineName(args.name);
					if ((args.type ?? "docker") === "physical") {
						if (args.image !== undefined || args.from_snapshot !== undefined) {
							throw new Error("image and from_snapshot are for docker machines only.");
						}
						const os = args.os ?? "linux";
						const install = await registrar.mint(name, os);
						const minutes = Math.round((install.expiresAt - Date.now()) / 60_000);
						return {
							output: [
								{
									type: "text",
									text:
										`Install command for "${install.name}" (single-use token, expires in ~${minutes} minutes):\n\n` +
										`${install.command}\n\n` +
										`Give it to the user to run once on the target machine${
											os === "windows" ? " in an elevated PowerShell" : " with sudo"
										}. ` +
										`It ensures sshd, authorizes this machine's key, and registers "${install.name}" here. ` +
										`After it finishes, switch with use_machine("${install.name}").`,
								},
							],
						};
					}
					if (args.os !== undefined) throw new Error('os is for physical machines only (type: "physical").');
					knownMachineOrFree(name);
					let image = args.image ?? DEFAULT_CONTAINER_IMAGE;
					if (args.from_snapshot !== undefined) {
						if (args.image !== undefined) throw new Error("Pass either image or from_snapshot, not both.");
						image = requireSnapshot(args.from_snapshot).image;
					}
					try {
						await run(["docker", "run", "-d", "--name", name, image, "sleep", "infinity"]);
					} catch (error) {
						throw new Error(withDockerHint(error));
					}
					await multienvs.addTarget({
						name,
						type: "docker",
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
									`Created machine "${name}" (docker container from ${image}` +
									`${args.from_snapshot === undefined ? "" : `, snapshot ${args.from_snapshot}`}). ` +
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
					`Remove a machine from the cluster. A docker sandbox's container is deleted; an SSH machine ` +
					`is only unregistered (the machine itself is untouched). Snapshots of it survive and can still ` +
					`be cloned. Conversations currently on it fall back to local.`,
				parameters: Type.Object({
					name: Type.String({ description: "Name of the machine to remove" }),
				}),
				async execute(args) {
					const name = args.name;
					if (name === "local") throw new Error("The local machine cannot be destroyed");
					const target = multienvs.target(name);
					if (target === undefined) throw new Error(`Unknown machine "${name}"`);
					if (target.type === "docker") {
						await run(["docker", "rm", "-f", target.container ?? name]).catch(() => undefined);
					}
					await multienvs.removeTarget(name);
					return {
						output: [
							{
								type: "text",
								text:
									target.type === "docker"
										? `Destroyed machine "${name}" (container removed).`
										: `Unregistered machine "${name}" (the machine itself is untouched).`,
							},
						],
					};
				},
			}),
			defineTool({
				name: "snapshot_machine",
				description:
					`Capture a docker machine's filesystem state as a snapshot registered in the cluster database. ` +
					`Snapshots outlive the machine: clone one into a new machine with create_machine(from_snapshot=...), ` +
					`or restore it in place with rollback_machine. Running processes and memory are NOT captured ` +
					`(docker commit fallback); restart services after a restore.`,
				parameters: Type.Object({
					machine: Type.String({ description: 'Name of the docker machine to snapshot, e.g. "sbx-1"' }),
					label: Type.Optional(
						Type.String({ description: 'Optional human label, e.g. "golden env" or "before refactor"' }),
					),
				}),
				async execute(args) {
					if (args.machine === "local")
						throw new Error("The local machine cannot be snapshotted (no virtualization layer)");
					knownMachine(args.machine);
					let snapshot: MachineSnapshot;
					try {
						snapshot = await multienvs.snapshotMachine(args.machine, args.label);
					} catch (error) {
						throw new Error(withDockerHint(error));
					}
					return {
						output: [
							{
								type: "text",
								text:
									`Snapshot ${snapshot.id} of machine "${args.machine}" registered` +
									`${snapshot.label === undefined ? "" : ` with label "${snapshot.label}"`}. ` +
									`Clone it with create_machine(from_snapshot: "${snapshot.id}"), or restore it in place ` +
									`with rollback_machine(machine: "${args.machine}", snapshot: "${snapshot.id}").`,
							},
						],
					};
				},
			}),
			defineTool({
				name: "rollback_machine",
				description:
					`Roll a docker machine's filesystem back to a snapshot: its container is recreated from the ` +
					`snapshot image. Everything created or changed after the snapshot is gone, and running processes ` +
					`are not restored. The machine's timeline moves back while conversation transcripts do not: ` +
					`when continuing a conversation that used this machine, tell it the environment was rewound ` +
					`(or start a fresh subagent on it).`,
				parameters: Type.Object({
					machine: Type.String({ description: "Name of the docker machine to roll back" }),
					snapshot: Type.String({ description: 'Snapshot id to restore, e.g. "snap-1a2b3c4d"' }),
				}),
				async execute(args) {
					knownMachine(args.machine);
					const restored = requireSnapshot(args.snapshot);
					try {
						await multienvs.rollbackMachine(args.machine, restored.id);
					} catch (error) {
						throw new Error(withDockerHint(error));
					}
					return {
						output: [
							{
								type: "text",
								text:
									`Machine "${args.machine}" rolled back to ${restored.id} ` +
									`(taken ${new Date(restored.createdAt).toISOString()}` +
									`${restored.label === undefined ? "" : `, "${restored.label}"`}). ` +
									`Its environment timeline is now at that point; observations made after it no longer ` +
									`match the environment — say so explicitly when continuing a conversation that used this machine.`,
							},
						],
					};
				},
			}),
			defineTool({
				name: "list_machines",
				description: "List the cluster: every machine this conversation can run tools on, with type and address.",
				parameters: Type.Object({}),
				async execute() {
					const lines: string[] = ["local (this machine)"];
					for (const name of multienvs.names()) {
						if (name === "local") continue;
						const target = multienvs.target(name)!;
						if (target.type === "docker") {
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
					`machine (${current}). Switch with use_machine. Available: ${multienvs.describeTargets()}. ` +
					`Snapshots: ${multienvs.describeSnapshots()}.`
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
