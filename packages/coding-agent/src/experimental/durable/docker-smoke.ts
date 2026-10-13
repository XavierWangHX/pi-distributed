// Headless E2E for docker hands: container → addTarget → envFor (daemon deploy over docker cp,
// SHA-256 verified) → exec through the daemon → destroy. No LLM involved.
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MultiEnvs } from "./multienv.ts";

const PG_URL = process.env.PI_PG_URL ?? "postgres://pi:pi@localhost:5433/durable";
const IMAGE = process.env.PI_SMOKE_IMAGE ?? "alpine:latest";
const name = `sbx-smoke-${Date.now().toString(36)}`;

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

const multienvs = await MultiEnvs.create(PG_URL, process.cwd());
try {
	docker("run", "-d", "--name", name, IMAGE, "sleep", "infinity");
	check("container running", docker("inspect", "--format", "{{.State.Running}}", name).trim() === "true");

	await multienvs.addTarget({ name, type: "docker", container: name, daemonPath: "/usr/local/bin/pi-env", cwd: "/" });
	check("target registered", multienvs.names().includes(name));
	check("describe shows docker", multienvs.describeTargets().includes(name));

	const env = await multienvs.envFor(name); // first use deploys the daemon
	check(
		"daemon deployed and executable",
		docker("exec", name, "sh", "-c", "test -x /usr/local/bin/pi-env && echo ok").trim() === "ok",
	);

	let output = "";
	const first = await env.exec(
		"uname -s",
		{
			onOutput: (text) => {
				output += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	check("first exec ok", first.ok === true, first.ok ? "" : String(first.error));
	check("runs inside the container", output.includes("Linux"), output.trim());

	output = "";
	const second = await env.exec(
		"cat /etc/os-release | head -1",
		{
			onOutput: (text) => {
				output += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	check("second exec ok (daemon reuse)", second.ok === true, second.ok ? "" : String(second.error));
	check("alpine guest", output.includes("Alpine"), output.trim());

	// A second MultiEnvs instance reuses the deployed daemon without re-copying.
	const reloaded = await MultiEnvs.create(PG_URL, process.cwd());
	check("cluster survives reload", reloaded.names().includes(name));
	const env2 = await reloaded.envFor(name);
	output = "";
	const third = await env2.exec(
		"echo reused",
		{
			onOutput: (text) => {
				output += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	check("reload path exec ok", third.ok === true && output.includes("reused"), output.trim());

	// A dead container fails loudly, not silently.
	docker("stop", name);
	const dead = await MultiEnvs.create(PG_URL, process.cwd());
	const deadSucceeded = await dead
		.envFor(name)
		.then(async (deadEnv) => {
			const result = await deadEnv.exec("echo never", undefined, BACKGROUND_CONTEXT);
			return result.ok === true;
		})
		.catch(() => false);
	check("dead container surfaces an error", !deadSucceeded);
	docker("start", name);

	await reloaded.removeTarget(name);
	await multienvs.removeTarget(name);
	check("unregistered", !multienvs.names().includes(name));
	await dead.cleanup();
	await reloaded.cleanup();
} finally {
	docker("rm", "-f", name);
	await multienvs.cleanup();
}
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
