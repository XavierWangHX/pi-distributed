// Headless smoke for the machine timeline: snapshot a docker machine (docker commit fallback),
// dirty it, roll back, verify the filesystem rewound and the daemon answers again; clone the
// snapshot into a second machine; verify snapshots survive a reload and refuse non-docker targets.
// No LLM involved.
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MultiEnvs } from "./multienv.ts";

const PG_URL = process.env.PI_PG_URL ?? "postgres://pi:pi@localhost:5433/durable";
const IMAGE = process.env.PI_SMOKE_IMAGE ?? "alpine:latest";
const stamp = Date.now().toString(36);
const name = `sbx-snap-${stamp}`;
const cloneName = `sbx-clone-${stamp}`;

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failures++;
}

function docker(...args: string[]): string {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`docker ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
	return result.stdout;
}

async function execText(env: Awaited<ReturnType<MultiEnvs["envFor"]>>, command: string): Promise<string> {
	let output = "";
	const result = await env.exec(
		command,
		{
			onOutput: (text) => {
				output += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	if (result.ok !== true) throw new Error(`exec failed (${command}): ${String(result.ok ? "" : result.error)}`);
	return output;
}

const multienvs = await MultiEnvs.create(PG_URL, process.cwd());
let snapshotId: string | undefined;
try {
	docker("run", "-d", "--name", name, IMAGE, "sleep", "infinity");
	await multienvs.addTarget({ name, type: "docker", container: name, daemonPath: "/usr/local/bin/pi-env", cwd: "/" });
	const env = await multienvs.envFor(name); // first use deploys the daemon
	check("baseline exec", (await execText(env, "echo baseline")).includes("baseline"));

	// The golden state: one marker file, captured by the snapshot.
	await execText(env, "echo golden > /golden.txt");
	const snapshot = await multienvs.snapshotMachine(name, "smoke golden");
	snapshotId = snapshot.id;
	check("snapshot registered", multienvs.snapshot(snapshot.id)?.id === snapshot.id);
	check("snapshot keeps label", multienvs.snapshot(snapshot.id)?.label === "smoke golden");
	check("describe shows snapshot", multienvs.describeSnapshots().includes(snapshot.id));
	let imageOk = true;
	try {
		docker("image", "inspect", snapshot.image);
	} catch {
		imageOk = false;
	}
	check("snapshot image exists", imageOk, snapshot.image);

	// Post-snapshot dirt must not survive the rollback.
	await execText(env, "echo dirty > /dirty.txt");
	const restored = await multienvs.rollbackMachine(name, snapshot.id);
	check("rollback returns the snapshot", restored.id === snapshot.id);

	// The cached env was discarded; envFor reconnects to the recreated container and redeploys the daemon.
	const env2 = await multienvs.envFor(name);
	check("post-rollback exec", (await execText(env2, "echo alive")).includes("alive"));
	check("golden file survived", (await execText(env2, "cat /golden.txt")).includes("golden"));
	const dirty = await execText(env2, "ls /dirty.txt 2>/dev/null || echo gone");
	check("dirty file rewound", dirty.includes("gone"), dirty.trim());

	// Cloning: a second machine started from the snapshot image sees the golden state.
	docker("run", "-d", "--name", cloneName, snapshot.image, "sleep", "infinity");
	await multienvs.addTarget({
		name: cloneName,
		type: "docker",
		container: cloneName,
		daemonPath: "/usr/local/bin/pi-env",
		cwd: "/",
	});
	const env3 = await multienvs.envFor(cloneName);
	check("clone sees golden state", (await execText(env3, "cat /golden.txt")).includes("golden"));

	// Snapshots live in PG: a fresh instance sees them, and outlives the machine they came from.
	const reloaded = await MultiEnvs.create(PG_URL, process.cwd());
	check("snapshot survives reload", reloaded.snapshot(snapshot.id)?.machine === name);

	// Non-docker targets and unknown snapshots fail with useful errors.
	let refused = "";
	try {
		await reloaded.snapshotMachine("local");
	} catch (error) {
		refused = String(error);
	}
	check("local refuses snapshot", refused.includes("Unknown machine"), refused);
	let unknown = "";
	try {
		await reloaded.rollbackMachine(name, "snap-deadbeef");
	} catch (error) {
		unknown = String(error);
	}
	check("unknown snapshot rejected", unknown.includes("Unknown snapshot"), unknown);

	await reloaded.removeSnapshot(snapshot.id);
	snapshotId = undefined;
	check("snapshot removed", reloaded.snapshot(snapshot.id ?? "") === undefined);
	await reloaded.removeTarget(cloneName);
	await reloaded.cleanup();
	await multienvs.removeTarget(cloneName);
	await multienvs.removeTarget(name);
} finally {
	spawnSync("docker", ["rm", "-f", name, cloneName], { encoding: "utf8" });
	if (snapshotId !== undefined) await multienvs.removeSnapshot(snapshotId).catch(() => undefined);
	await multienvs.cleanup();
}
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
