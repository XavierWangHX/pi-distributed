// In-process machine registration: an HTTP listener that mints one-shot install commands and
// accepts the callback a freshly installed machine sends. The install command embeds this
// machine's SSH public key, the callback URL and a single-use token; the target runs it once
// (sudo / elevated), which ensures sshd, authorizes the key, and POSTs /register. Registration
// only reports an address — access still comes from the key. Targets land in PostgreSQL through
// MultiEnvs.addTarget, so every pi instance sharing the database sees the new machine.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { MultiEnvs } from "./multienv.ts";

const DEFAULT_PORT = Number(process.env.PI_REGISTER_PORT ?? 8737);
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_BODY_BYTES = 8192;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

interface PendingInstall {
	readonly name: string;
	readonly os: "linux" | "windows";
	readonly expiresAt: number;
	used: boolean;
}

export interface RegisterServiceOptions {
	readonly port?: number;
	/** Bind address; defaults to every interface so any machine that can route here can register. */
	readonly bind?: string;
	/** Host used in generated URLs; defaults to PI_REGISTER_HOST or the first non-internal IPv4. */
	readonly advertiseHost?: string;
	readonly publicKeyPath?: string;
	readonly tokenTtlMs?: number;
}

export interface InstallCommand {
	readonly name: string;
	readonly token: string;
	readonly command: string;
	readonly expiresAt: number;
}

/** First non-internal IPv4 of this machine — the address a peer on the same network can reach. */
function detectLanIPv4(): string | undefined {
	for (const interfaces of Object.values(networkInterfaces())) {
		for (const candidate of interfaces ?? []) {
			if (candidate.family === "IPv4" && !candidate.internal) return candidate.address;
		}
	}
	return undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

function sendText(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	response.end(text);
}

function bodyOf(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

/** Strip the IPv4-mapped prefix Node reports for IPv4 peers on a dual-stack socket. */
function peerIp(request: IncomingMessage): string | undefined {
	const address = request.socket.remoteAddress;
	return address?.startsWith("::ffff:") ? address.slice(7) : address;
}

interface ResolvedOptions {
	readonly port: number;
	readonly bind: string;
	readonly advertiseHost: string;
	readonly publicKeyPath?: string;
	readonly tokenTtlMs: number;
}

export class RegisterService {
	readonly #multienvs: MultiEnvs;
	readonly #server: Server;
	readonly #pending = new Map<string, PendingInstall>();
	readonly #port: number;
	readonly #advertiseHost: string;
	readonly #publicKeyPath: string | undefined;
	readonly #ttlMs: number;
	#publicKey: string | undefined;
	#unavailable: string | undefined;
	#sweeper: NodeJS.Timeout | undefined;

	private constructor(multienvs: MultiEnvs, server: Server, options: ResolvedOptions) {
		this.#multienvs = multienvs;
		this.#server = server;
		this.#port = options.port;
		this.#advertiseHost = options.advertiseHost;
		this.#publicKeyPath = options.publicKeyPath;
		this.#ttlMs = options.tokenTtlMs;
	}

	/**
	 * Start listening. A busy port does not throw: the service marks itself unavailable and the
	 * mint caller (create_machine type "physical") reports why, so a second pi instance never
	 * crashes on startup.
	 */
	static async create(multienvs: MultiEnvs, options: RegisterServiceOptions = {}): Promise<RegisterService> {
		const resolved: ResolvedOptions = {
			port: options.port ?? DEFAULT_PORT,
			bind: options.bind ?? "0.0.0.0",
			advertiseHost: options.advertiseHost ?? process.env.PI_REGISTER_HOST ?? detectLanIPv4() ?? "127.0.0.1",
			publicKeyPath: options.publicKeyPath,
			tokenTtlMs: options.tokenTtlMs ?? TOKEN_TTL_MS,
		};
		let instance: RegisterService | undefined;
		const server = createServer((request, response) => {
			if (instance === undefined) {
				sendText(response, 503, "starting\n");
				return;
			}
			void instance.#route(request, response).catch((error: unknown) => {
				if (!response.headersSent) sendJson(response, 500, { error: String(error) });
				else response.end();
			});
		});
		const failure = await new Promise<string | undefined>((resolve) => {
			server.once("error", (error: NodeJS.ErrnoException) => {
				resolve(
					error.code === "EADDRINUSE"
						? `port ${resolved.port} is already in use (another pi instance? set PI_REGISTER_PORT)`
						: error.message,
				);
			});
			server.listen(resolved.port, resolved.bind, () => resolve(undefined));
		});
		const service = new RegisterService(multienvs, server, resolved);
		instance = service;
		if (failure !== undefined) {
			service.#unavailable = failure;
		} else {
			service.#sweeper = setInterval(() => service.#sweep(), 60_000);
			service.#sweeper.unref();
		}
		return service;
	}

	get available(): boolean {
		return this.#unavailable === undefined;
	}

	get unavailableReason(): string | undefined {
		return this.#unavailable;
	}

	get port(): number {
		return this.#port;
	}

	get baseUrl(): string {
		return `http://${this.#advertiseHost}:${this.#port}`;
	}

	async #publicKeyLine(): Promise<string> {
		if (this.#publicKey !== undefined) return this.#publicKey;
		const candidates = this.#publicKeyPath
			? [this.#publicKeyPath]
			: ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"].map((name) => join(homedir(), ".ssh", name));
		for (const candidate of candidates) {
			try {
				const text = (await readFile(candidate, "utf8")).trim();
				if (text !== "") {
					// Keep only "type base64": the comment can contain anything, and the scripts quote it.
					this.#publicKey = text.split("\n")[0]!.split(/\s+/).slice(0, 2).join(" ");
					return this.#publicKey;
				}
			} catch {
				// Try the next candidate.
			}
		}
		throw new Error(
			`No SSH public key found (looked for ${candidates.join(", ")}). Generate one first: ssh-keygen -t ed25519`,
		);
	}

	/** Mint a single-use install command for a new machine. */
	async mint(name: string, os: "linux" | "windows"): Promise<InstallCommand> {
		if (this.#unavailable !== undefined) throw new Error(`Registration service unavailable: ${this.#unavailable}`);
		if (name === "local") throw new Error('"local" is reserved for this machine');
		if (!NAME_PATTERN.test(name)) throw new Error(`Invalid machine name: ${JSON.stringify(name)}`);
		const token = randomBytes(16).toString("hex");
		this.#pending.set(token, { name, os, expiresAt: Date.now() + this.#ttlMs, used: false });
		const script = os === "linux" ? "/install/linux.sh" : "/install/windows.ps1";
		const command =
			os === "linux"
				? `curl -fsSL '${this.baseUrl}${script}?token=${token}' | sudo bash`
				: `irm '${this.baseUrl}${script}?token=${token}' | iex`;
		return { name, token, command, expiresAt: Date.now() + this.#ttlMs };
	}

	#sweep(): void {
		const now = Date.now();
		for (const [token, install] of this.#pending) {
			if (install.used || install.expiresAt < now) this.#pending.delete(token);
		}
	}

	async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "GET" && url.pathname === "/install/linux.sh") {
			return this.#serveScript(request, response, url, "linux");
		}
		if (request.method === "GET" && url.pathname === "/install/windows.ps1") {
			return this.#serveScript(request, response, url, "windows");
		}
		if (request.method === "POST" && url.pathname === "/register") {
			return this.#register(request, response);
		}
		sendText(response, 404, "not found\n");
	}

	async #serveScript(
		_request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		os: "linux" | "windows",
	): Promise<void> {
		const token = url.searchParams.get("token") ?? "";
		const install = this.#pending.get(token);
		if (install === undefined || install.used || install.expiresAt < Date.now() || install.os !== os) {
			sendText(response, 404, "unknown, used or expired token\n");
			return;
		}
		const publicKey = await this.#publicKeyLine();
		const script =
			os === "linux"
				? linuxScript({ token, name: install.name, callback: `${this.baseUrl}/register`, publicKey })
				: windowsScript({ token, name: install.name, callback: `${this.baseUrl}/register`, publicKey });
		sendText(response, 200, script);
	}

	async #register(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(await bodyOf(request)) as Record<string, unknown>;
		} catch {
			sendJson(response, 400, { error: "expected a JSON body" });
			return;
		}
		const token = typeof payload.token === "string" ? payload.token : "";
		const install = this.#pending.get(token);
		if (install === undefined || install.expiresAt < Date.now()) {
			sendJson(response, 403, { error: "unknown or expired token" });
			return;
		}
		if (install.used) {
			sendJson(response, 403, { error: "token already used" });
			return;
		}
		const user = typeof payload.user === "string" && USER_PATTERN.test(payload.user) ? payload.user : undefined;
		// The peer's source address is the machine's address; NAT'd machines may report their own.
		const host =
			typeof payload.host === "string" && payload.host !== "" && payload.host.length <= 253
				? payload.host
				: peerIp(request);
		const port =
			typeof payload.port === "number" &&
			Number.isInteger(payload.port) &&
			payload.port >= 1 &&
			payload.port <= 65535
				? payload.port
				: undefined;
		if (host === undefined || host === "") {
			sendJson(response, 400, { error: "could not determine the machine's address" });
			return;
		}
		try {
			await this.#multienvs.addTarget({
				name: install.name,
				type: "ssh",
				host,
				...(user === undefined ? {} : { user }),
				...(port === undefined ? {} : { port }),
				trustOnFirstUse: true,
			});
		} catch (error) {
			sendJson(response, 500, { error: `registration failed: ${String(error)}` });
			return;
		}
		install.used = true;
		sendJson(response, 200, { ok: true, name: install.name, host, ...(port === undefined ? {} : { port }) });
	}

	async stop(): Promise<void> {
		if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		if (this.#unavailable !== undefined) return;
		await new Promise<void>((resolve) => {
			this.#server.closeAllConnections();
			this.#server.close(() => resolve());
		});
	}
}

interface ScriptInputs {
	readonly token: string;
	readonly name: string;
	readonly callback: string;
	readonly publicKey: string;
}

/** The Linux installer: ensure sshd, authorize the key for the invoking user, call back. */
export function linuxScript({ token, name, callback, publicKey }: ScriptInputs): string {
	return `#!/usr/bin/env bash
# pi-distributed one-shot installer: sshd + authorized key + registration callback.
set -euo pipefail

TOKEN='${token}'
NAME='${name}'
CALLBACK='${callback}'
PUBKEY='${publicKey}'

log() { printf '==> %s\\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
TARGET_USER="\${SUDO_USER:-root}"

# 1. sshd, by distro
if ! command -v sshd >/dev/null 2>&1; then
  log "installing openssh-server"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q openssh-server
  elif command -v yum >/dev/null 2>&1; then yum install -y -q openssh-server
  elif command -v zypper >/dev/null 2>&1; then zypper -n install openssh-server
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm openssh
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache openssh-server openssh-keygen
  else echo "no supported package manager; install openssh-server manually" >&2; exit 1
  fi
fi

# 2. start it
log "starting sshd"
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now sshd 2>/dev/null || systemctl enable --now ssh 2>/dev/null || true
else
  service ssh start 2>/dev/null || service sshd start 2>/dev/null || /usr/sbin/sshd 2>/dev/null || true
fi

# 3. key-only root login when the target user is root
if [ "$TARGET_USER" = "root" ]; then
  CONF=/etc/ssh/sshd_config
  if grep -qE '^[[:space:]]*PermitRootLogin' "$CONF" 2>/dev/null; then
    sed -i -E 's/^[[:space:]]*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$CONF"
  else
    echo 'PermitRootLogin prohibit-password' >> "$CONF"
  fi
  systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service ssh reload 2>/dev/null || true
fi

# 4. authorized_keys; sshd StrictModes requires 700/600 and the right owner
USER_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
if [ -z "$USER_HOME" ]; then echo "unknown user: $TARGET_USER" >&2; exit 1; fi
log "authorizing key for $TARGET_USER ($USER_HOME)"
install -d -m 700 -o "$TARGET_USER" "$USER_HOME/.ssh"
touch "$USER_HOME/.ssh/authorized_keys"
grep -qxF "$PUBKEY" "$USER_HOME/.ssh/authorized_keys" || echo "$PUBKEY" >> "$USER_HOME/.ssh/authorized_keys"
chown "$TARGET_USER" "$USER_HOME/.ssh/authorized_keys" 2>/dev/null || true
chmod 600 "$USER_HOME/.ssh/authorized_keys"

# 5. firewall, best effort — a missing one is not an error
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true
fi

# 6. registration callback; the orchestrator records the address this request came from
log "registering as $NAME"
BODY=$(printf '{"token":"%s","user":"%s","os":"linux","arch":"%s","hostname":"%s"}' \\
  "$TOKEN" "$TARGET_USER" "$(uname -m)" "$(hostname)")
RESP=$(curl -fsS -X POST "$CALLBACK" -H 'content-type: application/json' -d "$BODY") \\
  || { echo "registration callback failed" >&2; exit 1; }
log "done: $RESP"
`;
}

/** The Windows installer: OpenSSH server, admin-wide authorized key, callback. Elevated PowerShell. */
export function windowsScript({ token, name, callback, publicKey }: ScriptInputs): string {
	return (
		`# pi-distributed one-shot installer (Windows): OpenSSH server + admin key + registration callback.
$ErrorActionPreference = 'Stop'
$Token = '${token}'
$Name = '${name}'
$Callback = '${callback}'
$PubKey = '${publicKey}'

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell'
}

# 1. OpenSSH server
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($capability.State -ne 'Installed') {
  Write-Host '==> installing OpenSSH.Server'
  Add-WindowsCapability -Online -Name $capability.Name | Out-Null
}

# 2. service + firewall
Write-Host '==> starting sshd'
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' ` +
		`-Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# 3. administrators authenticate through the machine-wide keys file, not ~/.ssh
$adminKeys = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
if (-not (Test-Path $adminKeys)) { New-Item -ItemType File -Path $adminKeys -Force | Out-Null }
if (-not (Select-String -Path $adminKeys -SimpleMatch -Pattern $PubKey -Quiet)) {
  Add-Content -Path $adminKeys -Value $PubKey
}
icacls $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

# 4. registration callback
Write-Host "==> registering as $Name"
$Body = @{ token = $Token; user = $env:USERNAME; os = 'windows'; arch = $env:PROCESSOR_ARCHITECTURE; hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
$Response = Invoke-RestMethod -Method Post -Uri $Callback -ContentType 'application/json' -Body $Body
Write-Host "==> done: $($Response | ConvertTo-Json -Compress)"
`
	);
}
