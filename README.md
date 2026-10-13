# pi-distributed

**一个大脑，多双手。**

pi（[earendil-works/pi](https://github.com/earendil-works/pi)）是个开源 agent harness。这个 fork 在它上面只干一件事：把 LLM 大脑、干活的手、聊天记录三样东西拆开，各跑各的。

翻译成人话：模型在你 Mac 上想事情，命令可以甩到任何一台机器上执行，聊天记录存在数据库里。三样东西不在一个地方，但用起来就是个普通 agent——`read` / `write` / `edit` / `bash` 还是原来那四个工具，代码一行没改，只是底下接的线不一样。

*One brain, many hands — a fork of [pi](https://github.com/earendil-works/pi) where the model, the machines it works on, and the session log all live in different places.*

## 长这样

```
            ┌──────────────────────────────┐
            │           PostgreSQL          │
            │     会话记录 + 机器舰队        │
            │    (Storage · 事务提交)       │
            └──────────────┬───────────────┘
                           │ 一次提交一个事务，崩溃后重放
            ┌──────────────┴───────────────┐
            │       大脑（LLM 机器）        │
            │   agent loop · Harness SDK    │
            │   状态全在 PG · 可水平复制     │
            └─┬────────────────────────┬───┘
              │                        │   env 回调（会话级 machine 路由）
              │                        │
   物理机 / GPU 集群 · SSH     容器集群 · docker
     ┌───┐  ┌───┐  ┌───┐      ┌───┐  ┌───┐  ┌───┐
     │gpu│  │gpu│  │… │      │sbx│  │sbx│  │… │
     └───┘  └───┘  └───┘      └───┘  └───┘  └───┘
    pi-env 手脚 · 一键注册    subagent 沙箱对
```

> 大脑自己那台机器也算一手（`local`）。切机器就两个口子：对话里喊 `use_machine`，或者开子 agent 时指定 `machine`。机器清单和聊天记录全在 PG 里，不在任何配置文件里。

## 拆开之后能干嘛

普通 agent（包括 pi 本体）是三合一的：大脑、文件系统、聊天记录焊死在一台机器上。拆开之后有两个直接的好处：

**1. 一个 agent 管一堆机器。** 对话里说“去 gpu-box 跑个训练”，bash 就在 gpu-box 上执行；说“切回本地”，下一条命令又回到本地。切换是会话级的——持久化在数据库里，重启进程还停在原来那台机器上。加一台机器 = 往表里插一行，不用碰任何配置文件。

**2. 给 Eval / RL 铺路。** 主 agent 可以开一堆子 agent，每个绑一台机器（或者用 `create_machine` 起一个容器沙箱），并行跑 rollout 或 eval。每个子会话都是完整的 durable 记录：中途挂了能续上，事后能翻出来复盘。

另外，因为状态全在数据库里，大脑进程本身没有状态——想开几个开几个，塞容器、接队列调度都行。这就是“支持大规模分布式”的全部秘密：没什么魔法，就是别把状态焊在进程里。

## 现在什么状态

能跑的：

- 本机 + SSH 远端机器，会话级切换（切一次，之后所有工具调用都在那台机器上）
- 一键收编新机器：`create_install_command` 生成一条命令（内嵌公钥 + 单次令牌），目标机跑一次——装好 sshd、写好 authorized_keys、自动回调注册进舰队（linux / windows 安装器都有）
- docker 沙箱：`create_machine` 起个容器就是新手脚（daemon 自动 `docker cp` 进去，SHA-256 校验后才运行），`destroy_machine` 销毁，`list_machines` 点名；alpine 实测通过
- 子 agent：指定机器、并行跑、命名续聊（实测过两台机器同时跑）
- PostgreSQL 会话存储：一个会话一个 schema，进程崩了重启能续
- 机器清单存 PG（`pi_machines.targets` 表），动态增删；写了个不存在的机器名也不炸，自动回落到本地

还没做的：

- Gondolin micro-VM 手脚（跑不可信代码的更强隔离，调研完毕待接入）
- 远端机器的 daemon 升级（linux / windows 远端还没有 listFiles / PTY；windows 欠 ConPTY）
- 注册加固（公钥 `from=<IP>` 限定、回调限速）

## 和官方 pi 什么关系

这是 pi 的分布式实验分支，不是替代品：

- 官方代码原样带着，定期 merge 上游（现在跟到 v1.2.0，零冲突）。
- 我们加的东西基本全在新文件里（多机器路由、子 agent、PG 存储后端），上游源码没怎么动。
- 官方后来删掉了 durable demo，这个分支把它捡回来养着——所有扩展都长在它上面。
- pi 本身的问题去 [earendil-works/pi](https://github.com/earendil-works/pi) 提；这里只聊分布式这块。

## 跑起来

Node ≥ 22.19，外加一个 PostgreSQL（默认连 `postgres://pi:pi@localhost:5433/durable`，环境变量 `PI_PG_URL` 可以改）：

```bash
git clone https://github.com/XavierWangHX/pi-distributed.git
cd pi-distributed
npm install
node packages/coding-agent/src/experimental/durable/main.ts
```

起来就能用——`local`（本机）开箱即有。加远端机器：对话里让 agent 调 `create_install_command`，把它生成的一条命令拿到目标机上跑（linux 是 `curl … | sudo bash`，windows 是管理员 PowerShell 里 `irm … | iex`），目标机会自己装好 sshd、写好公钥并注册回来。加沙箱：让 agent `create_machine` 就行。

---

*以下为官方 pi 的 README，原样保留供参考（描述上游 monorepo 本身）。*

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Pi packages](packages/coding-agent/docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Pi TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](https://pi.dev/docs/latest) for full setup and usage instructions, or [visit pi.dev](https://pi.dev) for demos.

## Run with Nix

```bash
nix run github:earendil-works/pi/stable
```

`stable` points at the latest release. Install it with `nix profile add github:earendil-works/pi/stable` and update with `nix profile upgrade pi`. Use a release tag such as `github:earendil-works/pi/v1.0.0` to pin a version, or `github:earendil-works/pi` for unreleased changes on `main`. Nix builds Pi from source.

Supports ARM64 and x86-64 on Linux and macOS. Use `nix build .` or `nix run .` to build or run your checkout.

Nix builds are offline, so the bundled model data comes from a pi.dev model catalog revision pinned in `nix/model-catalog.json`. At runtime, Pi still overlays newer catalog data from pi.dev as usual. The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type. To refresh it by hand:

```bash
npm run update:model-catalog-pin
```

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
