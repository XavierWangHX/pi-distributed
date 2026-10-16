<p align="center">
  <img src="assets/logo.svg" alt="Pi-Distributed" width="680">
</p>

<p align="center">
  <sub>English | <a href="./README.md">中文</a></sub>
</p>

<p align="center">
  <strong>One brain, many hands.</strong><br>
  <sub>Decouple the LLM brain, the tool-execution environment, and the session context — built for large-scale distribution.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/upstream-pi_v1.3.0-9c27b0?style=flat-square" alt="upstream">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_22.19-3c873a?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/PostgreSQL-required-336791?style=flat-square" alt="postgres">
  <img src="https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square" alt="license">
</p>

A distributed experiment fork of [pi](https://github.com/earendil-works/pi) that does exactly one thing: decouple the LLM brain, the tool-execution environment, and the session context, so the whole thing scales out.

The model thinks in the cloud; commands go to any machine — physical boxes (Mac/Linux/Windows) or ephemeral docker sandboxes. Conversations and cluster state land in cloud PostgreSQL. It still works like an ordinary agent: the `read` / `write` / `edit` / `bash` quartet is untouched — only the execution end differs.

## Architecture

Three planes, each doing its own job:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Storage Plane · PostgreSQL                          │
│      sessions (one schema each) · cluster inventory · snapshot registry      │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │ one transaction per commit
                                        │ replay after a crash
┌───────────────────────────────────────┴──────────────────────────────────────┐
│                       Control Plane · the Brain (LLM)                        │
│      agent loop · Harness SDK · stateless process, scales horizontally       │
│     env callback routes by Machine doc · the local machine is a hand too     │
└──────────────────┬───────────────────────────────────────┬───────────────────┘
                   │ use_machine                           │ subagent(machine=...)
                   │ session-level, survives restarts      │ one rollout per machine
                   ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│           Execution Plane · Hands (one pi-env daemon per machine)            │
│ ┌──────────────────────────────────┐    ┌──────────────────────────────────┐ │
│ │       Physical / GPU · SSH       │    │   docker sandboxes · ephemeral   │ │
│ │   gpu-1   gpu-2   gpu-3   ...    │    │   sbx-1   sbx-2   sbx-3   ...    │ │
│ │   install once, auto-registers   │    │ snapshot / clone / rollback + PG │ │
│ └──────────────────────────────────┘    └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

The hands are a `pi-env` daemon on every machine; the brain dispatches read/write/edit/bash through it. There are exactly two doors for switching machines: `use_machine` in the conversation, or `machine` when spawning a subagent. The machine inventory, the snapshots, and the chat log exist only in PG — no local config files. If the brain crashes, pick the session up on another machine and keep going.

## Why split it apart

Tired of configuring the same agent over and over on all your computers?

Today's harnesses (Claude Code, DeepSeek Harness, pi) weld the LLM (brain), the file system & tool-execution environment (hands), and the session data (context) onto one local machine. We took the harness apart from a product angle — once split, four things immediately hold:

**1. One entry point for all your devices.** The brain runs on your daily laptop; every other machine only installs a lightweight execution environment (a single binary, ~1 MB), and one Agent's `read` / `write` / `edit` / `bash` on any Mac / Linux / Windows box feels native. Say "run the training on gpu-box" and bash executes there; say "back to local" and the next command runs on this machine. Switching is session-level — persisted in the database, still on the same machine after a process restart; adding a machine = inserting a row. Session context lives in cloud PostgreSQL, so any device can pick up the conversation at any time.

**2. Eval harnessing.** Extend physical machines into a sandbox cluster (batch create / snapshot / rollback / clone): the main Agent batch-creates sandboxes from a chosen image and pins each subagent to the sandbox it runs in. When an eval finishes, pull the subagent's conversation record from the cloud database and the sandbox snapshot — file-system changes included — then score it, summarize failure causes, and update the flawed Skills and docs: an RSI self-improvement loop.

**3. Large-scale RL training.** The main Agent batch-creates sandboxes and Subagents for batch rollouts — one rollout per machine. Every child conversation is a complete durable record: resume after a crash, replay afterwards; with snapshots and rollback, the environment returns to any checkpoint too.

**4. Algorithm strategy search.** Brute force: batch-create Agents and sandboxes attached to different GPU clusters, experiment with different strategies in parallel, compare which one wins — RSI self-evolution of algorithms.

All state lives in the database, so the brain process has none — spawn as many as you like, containerize them, put a queue scheduler in front. The whole secret of "scales to large distributed deployments" is one sentence: don't weld state into the process.

## Tool design: the main agent runs the cluster, subagents just work

Tools come in two role-based tiers. The main agent orchestrates: it runs the cluster, controls the machine timeline, and dispatches work. Subagents execute: pinned to their assigned machine, they can touch nothing else. The reason for the split: subagents run model-generated task code — untrusted. Handing them timeline controls like snapshot/rollback is handing them the ability to destroy the crime scene and tamper with evidence (reward hacking has real production cases). The main agent sees both timelines — conversation and environment — and owns their consistency after a rollback.

**Main agent (root conversation)**

| Category | Tool | What it does | Status |
| --- | --- | --- | --- |
| Execution | `read` `write` `edit` `bash` | pi's native quartet, running on this conversation's current machine | ✅ |
| Routing | `use_machine` | Switch this conversation's execution machine — session-level, stored in PG, survives restarts | ✅ |
| Cluster | `list_machines` | Cluster roll call: names, types, status | ✅ |
| Cluster | `create_machine` | Add a machine: a docker sandbox by default, `from_snapshot` clones from a snapshot; `type: "physical"` mints a one-shot install command (embedded pubkey + token) — run it once on the target and it joins the cluster by itself | ✅ |
| Cluster | `destroy_machine` | Destroy a sandbox / deregister a remote machine (its snapshots stay and remain clonable) | ✅ |
| Timeline | `snapshot_machine` | Snapshot the machine's current state; registered in PG, shared by all sessions | ✅ (docker-commit fallback) |
| Timeline | `rollback_machine` | Rewind a machine to a snapshot; the tool output states that the timeline moved back | ✅ (docker-commit fallback) |
| Dispatch | `subagent` | Dispatch a task (foreground: blocking, returns the child's final answer) or run it in the background (`background` + `name`: returns immediately; `wait` to collect, `stop` to halt, auto-report on completion; survives aborts and restarts; budget of 64 per session); continue by name; pin a machine at creation — with clones, one rollout per machine | ✅ |
| Dispatch | `list_subagents` | List this session's named subagents | ✅ |

Timeline tools ride on backend capability: the docker type falls back to slow `commit` snapshots (file-system state only — processes and memory are not kept; restart services after a restore). O(1) clones and memory-state snapshots need the micro-VM backend (AgentENV, selected). SSH physical machines have no virtualization layer — no snapshots, and the tool says so.

**Subagent (child conversation)**

| Category | Tool | What it does | Status |
| --- | --- | --- | --- |
| Execution | `read` `write` `edit` `bash` | Pinned to the machine assigned at creation; can never switch | ✅ |

That's all four, nothing else: no machine switching, no cluster changes, no snapshots, no further dispatch — the `subagent` (anti-recursion) and `multi-env` extensions are removed when the child conversation is created, so cluster control is structurally out of reach. The power to switch machines or start over belongs to the main agent: spawn a new subagent, or roll the machine back and re-dispatch.

**System layer (not tools — no role can call these)**

- The env callback resolves each conversation's ExecutionEnv from its Machine doc — the wiring underneath machine routing
- Snapshots register in PG (`pi_machines.snapshots`) and surface through the machines section of the system prompt; no separate list tool
- Background-subagent completion watcher: the host watches its submission, writes the answer back to the Subagents doc, and reports to the parent conversation (queued if the parent is busy, wakes it if idle); after a restart, watchers re-attach from the doc — notifications never get lost
- Turn-boundary auto checkpoints (snapshot aligned with the conversation record; service crash recovery) 🚧

## Status

What works:

- Local + SSH remote machines, session-level switching (switch once; every later tool call runs on that machine)
- One-command machine enrollment: `create_machine(type: "physical")` mints an install command (embedded pubkey + single-use token); run it once on the target — it installs sshd, writes authorized_keys, and calls back to register itself into the cluster (linux / windows installers both ship)
- docker sandboxes: `create_machine` starts a container as a new pair of hands (the daemon is `docker cp`'d in automatically and SHA-256-verified before it runs), `destroy_machine` destroys it, `list_machines` rolls call; tested on alpine
- Machine timeline (docker-commit fallback): `snapshot_machine` takes snapshots, `rollback_machine` rewinds in place, `create_machine(from_snapshot=...)` clones; snapshots live in PG (`pi_machines.snapshots`) and outlive machines; smoke-tested (snapshot → dirty → rollback → clone → reload)
- Subagents: pinned machines, parallel runs, continue-by-name (tested with two machines at once); child conversations keep only the native quartet — cluster tools are removed at creation, so they can't escape their machine
- Background subagents: `subagent(background: true, name: …)` returns immediately; the child conversation is ownerless — a parent abort or a process restart doesn't stop it; `wait` collects the answer, `stop` halts explicitly, completion auto-reports to the parent; full-chain faux-model test (start → collect → report → suspend → stop)
- PostgreSQL session storage: one schema per session; a crashed process restarts and continues
- Machine inventory in PG (`pi_machines.targets`), added and removed dynamically; a typo'd machine name doesn't blow up — it falls back to local

Not yet:

- Brain daemonization (TUI and scheduler in separate processes; background work outlives the process): waiting for the upstream unix-socket client-server experiment to mature, then align with it — no home-grown protocol
- AgentENV micro-VM backend integration (replaces the earlier Gondolin plan; selected): Firecracker + E2B-compatible API, the production base of Kimi K3 RL training (MIT). AENV installs separately on a Linux/KVM host (kernel 6.8+); we only write the API adapter — a new aenv target in multienv, lifecycle over the E2B contract, execution channel reusing pi-env baked into the template
- O(1) snapshots / memory-state snapshots (waiting on the AgentENV backend: memory-state snapshots, second-scale forks, pause/resume, on-demand image loading; today's docker-commit fallback keeps file-system state only, and snapshots and clones are second-scale full copies)
- Turn-boundary auto checkpoints (snapshot aligned with the conversation record; after a crash, "conversation replay + environment rollback" restore together)
- Remote daemon upgrades (linux / windows remotes still lack listFiles / PTY; windows owes ConPTY)
- Registration hardening (pubkey `from=<IP>` pinning, callback rate limiting)

## Relationship to upstream pi

This is a distributed experiment fork of pi, not a replacement:

- Upstream code stays as-is and gets merged regularly (currently tracking v1.3.0).
- Almost everything new lives in new files (multi-machine routing, subagents, PG storage, machine timelines); upstream sources are barely touched.
- Report issues with pi itself at [earendil-works/pi](https://github.com/earendil-works/pi); this repo only discusses the distributed part.

## Quick start

Node ≥ 22.19 plus a PostgreSQL (defaults to `postgres://pi:pi@localhost:5433/durable`; override with `PI_PG_URL`):

```bash
git clone https://github.com/XavierWangHX/pi-distributed.git
cd pi-distributed
npm install
node packages/coding-agent/src/experimental/durable/main.ts
```

One headless turn (same shape as the official `-p`, also takes piped stdin) — the session still lands in PG, queryable afterwards:

```bash
node packages/coding-agent/src/experimental/durable/main.ts -p "your question"
```

Up and running — `local` (this machine) is there out of the box. Add a sandbox: ask the agent to `create_machine` (docker by default). Add a physical machine: ask the agent for `create_machine(type: "physical")` and run the printed command once on the target (linux: `curl … | sudo bash`; windows: `irm … | iex` in an admin PowerShell) — it installs sshd, writes the pubkey, and registers itself back into the cluster.
