// Headless smoke for the registration service: mint → fetch script → simulated callback →
// verify the target landed in PostgreSQL and survived a reload → token single-use. No LLM.
import { MultiEnvs } from "./multienv.ts";
import { RegisterService } from "./register.ts";

const PG_URL = process.env.PI_PG_URL ?? "postgres://pi:pi@localhost:5433/durable";
const PORT = Number(process.env.PI_SMOKE_PORT ?? 18737);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failures++;
}

const multienvs = await MultiEnvs.create(PG_URL, process.cwd());
const registrar = await RegisterService.create(multienvs, { port: PORT, advertiseHost: "127.0.0.1" });
check("service listening", registrar.available, registrar.unavailableReason ?? "");
if (!registrar.available) process.exit(1);

const name = `smoke-${Date.now().toString(36)}`;
const install = await registrar.mint(name, "linux");
check("mint returns curl one-liner", install.command.startsWith("curl -fsSL") && install.command.includes(install.token));

const scriptResponse = await fetch(`${registrar.baseUrl}/install/linux.sh?token=${install.token}`);
const script = await scriptResponse.text();
check("script served", scriptResponse.status === 200);
check("script embeds token", script.includes(install.token));
check("script embeds callback", script.includes(`${registrar.baseUrl}/register`));
check("script embeds a public key", /^PUBKEY='ssh-[A-Za-z0-9+/= ]+'/m.test(script) || /^PUBKEY='[a-z0-9-]+ [A-Za-z0-9+/=]+'/m.test(script));
check("script installs sshd", script.includes("openssh-server"));
check("script writes authorized_keys", script.includes("authorized_keys"));

const badScript = await fetch(`${registrar.baseUrl}/install/linux.sh?token=deadbeef`);
check("unknown token cannot fetch script", badScript.status === 404);

// A machine behind NAT reports its own reachable address; the callback carries it.
const registerResponse = await fetch(`${registrar.baseUrl}/register`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token: install.token, user: "smokeuser", os: "linux", arch: "x86_64", hostname: "smokebox", host: "203.0.113.7", port: 2222 }),
});
const registered = (await registerResponse.json()) as Record<string, unknown>;
check("register accepted", registerResponse.status === 200 && registered.ok === true, JSON.stringify(registered));
check("in-memory fleet updated", multienvs.names().includes(name));
check("describe shows host:port and user", multienvs.describeTargets().includes("203.0.113.7:2222"));

const reloaded = await MultiEnvs.create(PG_URL, process.cwd());
check("survives reload from PG", reloaded.names().includes(name));

const replay = await fetch(`${registrar.baseUrl}/register`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token: install.token, user: "smokeuser", os: "linux" }),
});
check("token is single-use", replay.status === 403);

const garbage = await fetch(`${registrar.baseUrl}/register`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token: "00".repeat(16) }),
});
check("unknown token rejected", garbage.status === 403);

await reloaded.removeTarget(name);
await multienvs.removeTarget(name);
check("cleanup removes target", !multienvs.names().includes(name));

await registrar.stop();
await reloaded.cleanup();
await multienvs.cleanup();
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
