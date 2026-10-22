# Agent-Token-Optimizer

**面向 AI Agent 的本地 LLM token 用量账本、缓存分账、报告与离线评估工具，附可选 OpenClaw 观察插件。**

[English](README.md) · [Agent 安装契约](agent-install.json) · [操作手册](docs/operations.md) · [验收范围](docs/coverage.md)

当前为 **v0.1.0 试用版**。可用能力包括显式来源采集、四维计量、独立 SQLite 账本、JSON/HTML 报告、策略预览和离线实验。核心和 CLI 无第三方运行依赖，不要求安装 OpenClaw。

当前没有经过验证的节省比例；生产请求拦截、完整请求计费、候选压缩器采用和 24–72 小时观察验收仍未完成。观察插件也不是硬计费上限。

## 让你的 Agent 拉取并安装

把下面的任务交给你的编程 Agent：

> 从 https://github.com/yuanzh0u/Agent-Token-Optimizer 拉取 v0.1.0 标签到新目录。阅读 AGENTS.md 和 agent-install.json，检查 Node 版本，执行 npm run verify 和 npm run demo，返回退出码与报告路径。除非我另外明确要求，不接入真实数据源，不修改 OpenClaw 配置。

手动执行同样的步骤：

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/yuanzh0u/Agent-Token-Optimizer.git
cd Agent-Token-Optimizer
node --version
npm run verify
npm run demo
```

Node 要求是 `>=24.16.0 <25 || >=26.1.0`，实际验证基线为 Linux + Node 24.21.0。其他允许版本和系统不能继承本次验证结论。源码直接运行，无需构建或执行 npm install。demo 使用合成数据，真实模型请求为 0，输出配置、JSON、HTML 和健康标记路径。

## 安装成独立 CLI

在验证过的源码目录内执行：

```bash
npm pack --ignore-scripts
npm install --prefix ../ato-tools --ignore-scripts --omit=peer --no-audit --no-fund ./agent-token-optimizer-0.1.0.tgz
../ato-tools/node_modules/.bin/agent-token-optimizer --help
```

CLI 安装到独立工具目录，跳过可选宿主 peer。GitHub Release 也提供安装包与 SHA256SUMS；下载后先校验再安装。目前没有发布到 npm registry，不要假定 npm 上的同名包属于本项目。

## 配置自己的来源

```bash
node bin/agent-token-optimizer.mjs init --directory ../ato-local
node bin/agent-token-optimizer.mjs verify --config ../ato-local/deployment.json
node bin/agent-token-optimizer.mjs policy dry-run --config ../ato-local/deployment.json --agent-id my-agent
```

初始化采用 observe 模式，来源为空，拒绝覆盖已有配置。参考[合成来源](examples/deployment.json)、[策略示例](examples/policy.json)和[操作手册](docs/operations.md)，设置你有权读取的来源；相对路径以配置文件目录为基准。空来源意味着未知，不等于零用量。

配置完成后：

```bash
node bin/agent-token-optimizer.mjs collect --config ../ato-local/deployment.json
node bin/agent-token-optimizer.mjs report --config ../ato-local/deployment.json
```

计量分别保留 uncachedInput、output、cacheRead、cacheWrite，缺失为 null，估算单列；缓存是否已包含在 input 中必须显式映射，不能猜测。可按 provider、model、agent、session、run、runtime 分组，不依赖固定 Agent 名称。

采集失败保留上次 JSON/HTML，但后续 CLI 仍显示 stale，直到成功重新发布。移除来源会从当前汇总排除，历史数据留作审计。保存的 HTML 只描述快照年龄，当前健康请使用 CLI report。退出码 0 表示命令完成（仍需看 degraded 状态），1 表示输入或操作错误，2 表示没有当前可用的采集或报告。

## OpenClaw 插件为可选项

仅在用户明确要求时安装。公开 SDK 加载与授权注册的精确验证版本为 OpenClaw **2026.10.3**；真实 gateway 生命周期、其他版本和完整付费请求覆盖仍待验证。插件只观察有界的 llm_output 元数据，不修改模型、skills、心跳或历史引擎，不执行 L1/L2/L3 gate。

先阅读[隔离加载流程](docs/operations.md)，再按英文 README 的 先安装为禁用状态的步骤操作。宿主 hooks.allowConversationAccess 与插件 conversationAccess 都需要显式授予；CLI 安装不会自动授权。配置片段必须合并，保留原 allow 成员与引擎选择。

## 使用边界

- 仅读取显式配置且获准的来源；不扫描整个 home，不在账本或报告保存 prompt/assistant 原文。
- JSONL 与一致的 rollback-journal SQLite 快照受支持；活跃 WAL、journal、SHM 来源或中断状态拒绝打开，不得通过删除日志强行恢复。
- 单个部署独占可写状态与报告目录；schema v2 仅升级完全匹配的 v0/v1，拒绝外来或较新结构。
- JSON、HTML、collection-health.json 一起备份；不覆盖宿主会话历史。
- 真实节省、质量、heldout 和 soak 仍需证据，详见[完整验收矩阵](docs/coverage.md)。

问题反馈：[GitHub Issues](https://github.com/yuanzh0u/Agent-Token-Optimizer/issues)。提交版本、环境、命令、退出码与脱敏诊断，不上传凭据或会话内容。维护者为 [@yuanzh0u](https://github.com/yuanzh0u)，本项目不是 OpenClaw 官方发行物。

许可证仍待选择；当前试用版尚未选定开源许可证。
