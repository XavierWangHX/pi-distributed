<p align="center">
  <img src="assets/logo.svg" alt="Pi-Distributed" width="680">
</p>

<p align="center">
  <sub><a href="./README.en.md">English</a> | 中文</sub>
</p>

<p align="center">
  <strong>一个大脑，多双手。</strong><br>
  <sub>把 LLM 大脑、工具执行环境、Session上下文记录三者解耦，支持大规模分布式扩展。</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/upstream-pi_v1.3.0-9c27b0?style=flat-square" alt="upstream">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_22.19-3c873a?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/PostgreSQL-required-336791?style=flat-square" alt="postgres">
  <img src="https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square" alt="license">
</p>

pi（[earendil-works/pi](https://github.com/earendil-works/pi)）的分布式实验分支，只做一件事：把 LLM 大脑、工具执行环境、Session上下文记录三者解耦，支持大规模分布式扩展。

模型在云端思考，命令派往任意机器——物理机（Mac/Linux/Windows）、随起随销的 docker 沙箱；对话与集群状态落进云端 PostgreSQL。用起来仍是普通 agent：`read` / `write` / `edit` / `bash` 四件套一行未改，只是执行端不同。

*One brain, many hands — a fork of [pi](https://github.com/earendil-works/pi) where the model, the machines it works on, and the session log all live in different places.*

## 架构

三个平面，各管各的：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                            存储平面 · PostgreSQL                             │
│                 会话（一会话一 schema）· 集群清单 · 快照登记                 │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │ 一次提交一个事务 · 崩溃后重放
┌───────────────────────────────────────┴──────────────────────────────────────┐
│                            控制平面 · 大脑（LLM）                            │
│              agent loop · Harness SDK · 进程无状态，可水平复制               │
│             env 回调按 Machine 文档路由 · 本机 local 也是一只手              │
└──────────────────┬───────────────────────────────────────┬───────────────────┘
                   │ use_machine                           │ subagent(machine=...)
                   │ 会话级路由，重启不丢                  │ 一条 rollout 一台
                   ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                执行平面 · 手脚（每台机器一个 pi-env daemon）                 │
│ ┌──────────────────────────────────┐    ┌──────────────────────────────────┐ │
│ │        物理机 / GPU · SSH        │    │      docker 沙箱 · 随起随销      │ │
│ │   gpu-1   gpu-2   gpu-3   ...    │    │   sbx-1   sbx-2   sbx-3   ...    │ │
│ │   一条安装命令，跑一次自动入队   │    │  快照 / 克隆 / 回滚，登记进 PG   │ │
│ └──────────────────────────────────┘    └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

手脚是每台机器上的 `pi-env` daemon，大脑通过它派发 read/write/edit/bash。切机器只有两个入口：对话里 `use_machine`，或开子 agent 时指定 `machine`。机器清单、快照、聊天记录只存在于 PG——没有本地配置文件，大脑崩了换台机器接着跑。

## 为什么拆开

你是否厌烦在自己的多台电脑上反复配置同样的 agent？

现有的 Harness（Claude Code、DeepSeek Harness、pi）都把 LLM（大脑）、文件系统与 Tool 执行环境（手脚）、Session 会话数据（上下文）绑死在同一台本地电脑上。我们从产品角度重新拆解 Harness——拆开之后，四件事立刻成立：

**1. 一个入口，管自己所有的设备。** 大脑跑在常用笔记本上，其他机器只装一个轻量执行环境（单文件 1MB 出头），一个 Agent 在任一 Mac / Linux / Windows 机器上执行 `read` / `write` / `edit` / `bash` 都像在本地原生运行。对话里说“去 gpu-box 跑个训练”，bash 就在 gpu-box 上执行；说“切回本地”，下一条命令又回到本机——切换是会话级的，持久化在数据库里，重启进程还停在原来那台机器上；加一台机器 = 往表里插一行。Session 上下文存云端 PostgreSQL，随时可从任一设备接着对话。

**2. Eval Harness 评测。** 物理机扩展成沙箱集群（批量创建 / 快照 / 回滚 / 克隆）之后，主 Agent 指定镜像批量创建沙箱，派发时指定子 Agent 跑在哪一个沙箱里。评测跑完，从云端数据库取出子 Agent 的会话记录、取出带文件系统状态变化的沙箱快照，打分、总结失败原因、更新有缺陷的 Skill 和文档——形成 RSI 自改进循环。

**3. 大规模 RL 训练。** 主 Agent 批量创建沙箱和 Subagent 跑批量 rollout，一条 rollout 一台机。每个子会话都是完整的 durable 记录：中途挂了能续，事后能复盘；配合快照与回滚，环境也能回到任意检查点。

**4. 算法策略探索。** 力大砖飞：批量创建 Agent 和沙箱、挂载不同的 GPU 集群，同时实验不同的算法策略，跑完比较哪个结果更好，形成算法的 RSI 自进化。

状态全在数据库，大脑进程便没有状态——想开几个开几个，塞容器、接队列调度都行。“支持大规模分布式”的全部秘密就这一句：别把状态焊在进程里。

## 工具设计：主 agent 管集群，子 agent 只管干活

工具按角色分两层。主 agent 是编排者：管集群、控制机器时间线、派发任务；子 agent 是执行者：钉在被分配的那台机器上干活，别的什么都碰不到。分层的理由：子 agent 跑的是模型生成的任务代码，不可信——把快照/回滚这种时间线控制权交给它，等于交给它销毁现场、篡改证据的能力（reward hacking 在生产环境有真实案例）。主 agent 同时看得到对话和环境两条时间线，回滚之后环境状态和对话记录的一致性由它负责。

**主 agent（根对话）**

| 类别 | 工具 | 说明 | 状态 |
| --- | --- | --- | --- |
| 执行 | `read` `write` `edit` `bash` | pi 原生四件套，跑在本对话当前机器上 | ✅ |
| 路由 | `use_machine` | 切换本对话的执行机器，会话级、存 PG、重启不丢 | ✅ |
| 集群 | `list_machines` | 集群点名：名字、类型、状态 | ✅ |
| 集群 | `create_machine` | 往集群加机器：默认起 docker 沙箱，`from_snapshot` 从快照克隆；`type: "physical"` 生成物理机的一次性安装命令（内嵌公钥 + 令牌），目标机跑一次自动入队 | ✅ |
| 集群 | `destroy_machine` | 销毁沙箱 / 注销远端机器（它的快照保留，仍可克隆） | ✅ |
| 时间线 | `snapshot_machine` | 给机器当前状态打快照，快照登记进 PG，所有会话共享 | ✅（docker commit 兜底） |
| 时间线 | `rollback_machine` | 机器回滚到快照；工具输出会明示时间线已回退 | ✅（docker commit 兜底） |
| 派发 | `subagent` | 派任务（前台阻塞，返回孩子最终答案）或后台跑（`background` + `name`：立即返回，`wait` 收割、`stop` 停止、完成自动报告，跨 abort 与重启存活，每会话预算 64）；按名字续聊；创建时指定机器，配合克隆做到一条 rollout 一台机 | ✅ |
| 派发 | `list_subagents` | 列出本会话的命名子 agent | ✅ |

时间线工具吃后端能力：docker 类型先用 `commit` 慢快照兜底（只有文件系统态，进程和内存不保存，恢复后要重新拉起服务），micro-VM 后端（AgentENV，已选型）才有 O(1) 克隆和含内存态的快照；ssh 物理机没有虚拟化层，不支持快照，工具会明说。

**子 agent（子对话）**

| 类别 | 工具 | 说明 | 状态 |
| --- | --- | --- | --- |
| 执行 | `read` `write` `edit` `bash` | 钉在创建时分配的机器上，全程不能换 | ✅ |

就这四个，没有别的：不能切机器、不能增删集群、不能碰快照、不能再派发——创建子对话时把 `subagent`（防递归）和 `multi-env` 两个扩展全部移除，集群控制在结构上就够不着。换机器或重来一次的权力在主 agent：新开一个子 agent，或者回滚机器再重新派发。

**系统层（不是工具，任何角色都调不到）**

- env 回调按对话的 Machine 文档解析 ExecutionEnv——机器路由的底层接线
- 快照登记进 PG（`pi_machines.snapshots` 表），随系统提示的 machines 段落透出，不设单独的 list 工具
- 后台子代理的完成看守：宿主盯住它的 submission，答案写回 Subagents 文档并向父对话报告（父忙则排队、父闲则唤醒）；重启后从文档自动重挂，通知不丢
- 回合边界自动检查点（快照和对话记录对齐，服务崩溃恢复）🚧

## 现状

能跑的：

- 本机 + SSH 远端机器，会话级切换（切一次，之后所有工具调用都在那台机器上）
- 一键收编新机器：`create_machine(type: "physical")` 生成一条安装命令（内嵌公钥 + 单次令牌），目标机跑一次——装好 sshd、写好 authorized_keys、自动回调注册进集群（linux / windows 安装器都有）
- docker 沙箱：`create_machine` 起个容器就是新手脚（daemon 自动 `docker cp` 进去，SHA-256 校验后才运行），`destroy_machine` 销毁，`list_machines` 点名；alpine 实测通过
- 机器时间线（docker commit 兜底版）：`snapshot_machine` 打快照、`rollback_machine` 原地回滚、`create_machine(from_snapshot=...)` 克隆；快照存 PG（`pi_machines.snapshots` 表），比机器活得久；冒烟实测通过（快照 → 弄脏 → 回滚 → 克隆 → 重载）
- 子 agent：指定机器、并行跑、命名续聊（实测过两台机器同时跑）；子对话只保留原生四件套，集群工具在创建时移除，逃不出分配的机器
- 后台子 agent：`subagent(background: true, name: …)` 启动即返回；子对话 ownerless——父对话 abort、进程重启都不影响它继续跑；`wait` 收割答案、`stop` 显式停止、完成自动向父对话报告；faux 模型全链路实测（启动 → 收割 → 报告 → 挂起 → 停止）
- PostgreSQL 会话存储：一个会话一个 schema，进程崩了重启能续
- 机器清单存 PG（`pi_machines.targets` 表），动态增删；写了个不存在的机器名也不炸，自动回落到本地

还没做的：

- 大脑 daemon 化（TUI 与调度器分进程，后台工作跨进程存活）：等上游的 unix-socket client-server 实验成熟后跟进对齐，不自造协议
- AgentENV micro-VM 后端接入（替代原 Gondolin 方案，已选型）：Firecracker + E2B 兼容 API，Kimi K3 RL 训练的生产底座（MIT）。AENV 单独安装在 Linux/KVM 主机（kernel 6.8+），我们只写调用接口适配层——multienv 新增 aenv target，生命周期走 E2B 契约，执行通道复用烘进模板的 pi-env
- O(1) 快照 / 含内存态的快照（等 AgentENV 后端：内存态快照、秒级 fork、pause/resume、镜像按需加载；现在的 docker commit 兜底只有文件系统态，快照和克隆都是秒级全量拷贝）
- 回合边界自动检查点（快照和对话记录对齐，崩溃后“对话回放 + 环境回滚”一起还原）
- 远端机器的 daemon 升级（linux / windows 远端还没有 listFiles / PTY；windows 欠 ConPTY）
- 注册加固（公钥 `from=<IP>` 限定、回调限速）

## 与上游 pi 的关系

这是 pi 的分布式实验分支，不是替代品：

- 上游代码原样保留，定期 merge（当前跟到 v1.3.0）。
- 新增的东西基本全在新文件里（多机路由、子 agent、PG 存储、机器时间线），上游源码几乎不动。
- pi 本身的问题去 [earendil-works/pi](https://github.com/earendil-works/pi) 提；这里只聊分布式这块。

## 快速开始

Node ≥ 22.19，外加一个 PostgreSQL（默认连 `postgres://pi:pi@localhost:5433/durable`，环境变量 `PI_PG_URL` 可改）：

```bash
git clone https://github.com/XavierWangHX/pi-distributed.git
cd pi-distributed
npm install
node packages/coding-agent/src/experimental/durable/main.ts
```

无头一轮（与官方 `-p` 同格式，也吃管道 stdin），会话照样落 PG、事后可查：

```bash
node packages/coding-agent/src/experimental/durable/main.ts -p "你的问题"
```

起来就能用——`local`（本机）开箱即有。加沙箱：让 agent `create_machine`（默认 docker）。加物理机：让 agent `create_machine(type: "physical")`，把生成的命令拿到目标机上跑一次（linux 是 `curl … | sudo bash`，windows 是管理员 PowerShell 里 `irm … | iex`），目标机自己装好 sshd、写好公钥并注册回来。

