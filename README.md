# Agent-Token-Optimizer

**Local LLM token accounting, cache-aware usage reports, and offline evaluation for AI agents — with an optional OpenClaw observation plugin.**

[中文说明](README.zh-CN.md) · [Agent installation contract](agent-install.json) · [Operations](docs/operations.md) · [Verified coverage](docs/coverage.md) · [Releases](https://github.com/yuanzh0u/Agent-Token-Optimizer/releases)

Agent-Token-Optimizer helps developers understand where an AI agent's tokens go and evaluate proposed optimizations before adopting them. It imports explicitly configured local usage records, maintains a separate SQLite ledger, and produces JSON/HTML reports. The CLI and core have **no third-party runtime dependencies** and do not require OpenClaw.

**Status: v0.1.0 preview.** Token accounting and offline evaluation are available. Automatic production request blocking, proven token savings, third-party compression adoption, and 24–72-hour production soak acceptance are **not implemented or not yet verified**. The OpenClaw plugin observes metadata; it does not enforce a hard billing limit.

## Quick start: clone, verify, run

Requirements: Git, npm, and Node.js `>=24.16.0 <25 || >=26.1.0`. The verified baseline is **Linux + Node.js 24.21.0**. Other allowed Node versions and operating systems do not inherit that validation.

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/yuanzh0u/Agent-Token-Optimizer.git
cd Agent-Token-Optimizer
node --version
npm run verify
npm run demo
```

There is **no build step and no `npm install` step** for this source checkout. `npm run verify` checks the source hashes, runs the tests, creates an actual npm tarball, and executes it in a fresh directory. A successful run ends with `Verified offline tests, source lock and fresh package portability.`

The demo prints paths to its temporary configuration, JSON report, HTML report, and collection-health marker. It uses synthetic usage, makes **zero real-model requests**, and labels its report accordingly. Open the printed HTML path to inspect the sample. Package downloads require network access; the demo and collector do not call model providers.

## Install instructions for your AI agent

Give your coding agent this task:

> Install Agent-Token-Optimizer from `https://github.com/yuanzh0u/Agent-Token-Optimizer` at tag `v0.1.0` into a new directory. Read `AGENTS.md` and `agent-install.json`. Check the Node engine requirement, run `npm run verify`, then run `npm run demo`. Report the exit codes and the generated report paths. Do not configure a real data source or change OpenClaw settings unless I explicitly request it.

The machine-readable [installation contract](agent-install.json) specifies the repository, version, prerequisites, commands, working directories, and success criteria. [AGENTS.md](AGENTS.md) explains the configuration and development boundaries. These files are installation conveniences, not requirements for search indexing or AI citations.

### Install the CLI from a local package

From the verified checkout:

```bash
npm pack --ignore-scripts
npm install --prefix ../ato-tools --ignore-scripts --omit=peer --no-audit --no-fund ./agent-token-optimizer-0.1.0.tgz
../ato-tools/node_modules/.bin/agent-token-optimizer --help
```

This installs into a separate local tools directory and skips the optional OpenClaw peer. The same root tarball contains the core, CLI, and plugin entry. The nested plugin directory is not an independent distribution.

GitHub releases also provide the tarball and `SHA256SUMS`. Verify a downloaded release asset before installing it. **This project has not been published to the npm registry**: use this repository or its GitHub release assets rather than assuming a same-named registry package belongs to this project.

## What can I use it for?

| Capability | Available behavior | Current boundary |
| --- | --- | --- |
| LLM token accounting | Separate `uncachedInput`, `output`, `cacheRead`, and `cacheWrite` | Missing values remain `null`; token counts are not a monetary bill |
| Usage import | Explicit JSONL and supported SQLite sources with field mappings | No automatic home-directory scan; active WAL/journal SQLite sources are unsupported |
| Multi-source ledger | Transactional record/cursor updates, reliable-ID deduplication, conflict quarantine | Provider/account/request identity is required for reliable global deduplication |
| Agent attribution | Group by provider, model, agent, session, run, and runtime | Agent names are opaque configuration values, not hardcoded roles |
| Local reports | Private JSON/HTML snapshots, durable collection health, active-source scope | Saved HTML shows snapshot age; use the CLI for current collection health |
| Policy preview | Defaults → bound profile → overrides, with provenance and conservative fallback | A policy preview does not install runtime enforcement |
| Offline evaluation | Synthetic controller/replay, quality/cost gates, paired-result validation | Synthetic data cannot establish real savings or complete elapsed soak gates |
| OpenClaw plugin | Bounded `llm_output` metadata observation through the public SDK | Exact-host registration validation only; full gateway lifecycle remains pending |

## Create your own deployment

```bash
node bin/agent-token-optimizer.mjs init --directory ../ato-local
node bin/agent-token-optimizer.mjs verify --config ../ato-local/deployment.json
node bin/agent-token-optimizer.mjs policy dry-run --config ../ato-local/deployment.json --agent-id my-agent
```

Initialization creates private `deployment.json` and `policy.json` files, starts in **observe mode**, and leaves `sources` empty. Re-running initialization refuses to overwrite an existing configuration. No sources means unknown coverage, not zero usage.

Configure sources you are authorized to read. Start with [the synthetic deployment](examples/deployment.json), [the policy example](examples/policy.json), and [source/privacy rules](docs/operations.md). Relative paths resolve from the deployment file's directory. Cache mappings must state whether the input count already includes cache reads or writes; do not guess a provider's accounting semantics.

After configuring a source:

```bash
node bin/agent-token-optimizer.mjs collect --config ../ato-local/deployment.json
node bin/agent-token-optimizer.mjs report --config ../ato-local/deployment.json
```

`collect` scans only configured sources and publishes a separate report. `report` reads the saved snapshot and its health marker; it does not start a new collection. If collection fails, the last successful JSON/HTML files remain available while subsequent CLI reads stay stale until a successful recovery publication. Removing a source excludes its records from current totals but retains the historical audit data.

### CLI commands and exit codes

| Command | Purpose |
| --- | --- |
| `init --directory DIR` | Create a private, empty, observe-only deployment |
| `verify [--config FILE]` | Validate local configuration/contracts; does not certify host enforcement |
| `policy dry-run --config FILE --agent-id ID` | Preview policy, provenance, and effective mode |
| `collect --config FILE` | Import explicit sources and publish a local snapshot |
| `report --config FILE` | Read the snapshot and current collection-health marker |
| `evaluate --input FILE` | Evaluate a result dataset without authenticating arbitrary JSON as real evidence |

Exit **0** means the command completed; inspect coverage because an explicitly degraded result can still exit 0. Exit **1** means invalid input or an operation error. Exit **2** means no currently usable collection/report. An agent must not convert exit 2 into a successful zero-usage result.

## Optional OpenClaw plugin

The CLI does not need OpenClaw. The optional `openclaw-token-governor` plugin has an exact optional peer of **OpenClaw 2026.10.3**. Its public-SDK import and permission-dependent registration were inspected in an isolated instance. Other host versions, real gateway start/reload/incognito behavior, and complete paid-request coverage remain unverified.

For an explicitly requested plugin installation, build the root tarball and install it disabled first:

```bash
npm pack --ignore-scripts
openclaw plugins install ./agent-token-optimizer-0.1.0.tgz --no-enable
openclaw plugins inspect openclaw-token-governor --runtime --json
```

Follow [the isolated host procedure](docs/operations.md) before enabling it. Merge [the observer configuration fragment](examples/openclaw-observer.fragment.json) into your own configuration while preserving existing plugin allow entries and engine selection. Observation requires both the host's `hooks.allowConversationAccess` grant and the plugin's local `conversationAccess` opt-in. Installing the CLI does not grant either permission.

`llm_output` is an attempt aggregate, not a complete request-level billing feed. Its channel account is not a provider billing account. The plugin does not register a context engine, compress outputs, change models/skills/heartbeat, or enforce L1/L2/L3 request gates.

## Privacy, recovery, and compatibility

- Usage sources are explicit and permission-gated. Persisted data is numeric usage plus allowlisted metadata; prompt/assistant payloads are not stored in the ledger or report.
- Reports/state belong to this tool. It does not overwrite native conversation history. Keep runtime state out of version control.
- One deployment owns each writable ledger/report directory. Do not share one state directory between independent writers.
- State schema v2 only migrates the exact recognized v0/v1 layouts. Foreign, modified, or newer schemas are rejected.
- SQLite WAL headers and journal/WAL/SHM sidecars cause refusal, including interrupted tool-owned state. Preserve the main file and sidecars together and follow [recovery guidance](docs/operations.md); do not delete journals to force the tool open.
- Static HTML is a saved snapshot. Copy JSON, HTML, and `collection-health.json` together, and use CLI `report` for current health.

## Frequently asked questions

### Does Agent-Token-Optimizer automatically reduce my token bill?

No. This preview provides accounting, observation, policy previews, and evaluation tools. It does not prove a savings percentage or automatically enforce production budgets. Real savings require complete request accounting, matched workloads, quality checks, independent heldout data, and actual elapsed observation. See [the acceptance matrix](docs/coverage.md).

### Can it work with agents other than OpenClaw?

Yes, the CLI/core can import supported local usage records through explicit mappings independently of OpenClaw. There is no automatic integration with every agent framework. Configure identities and input/cache semantics for your own source.

### Are cached tokens treated as free or missing usage treated as zero?

No. The four usage dimensions remain separate. Unknown measurements stay unknown; estimated values are reported separately. Monetary cost comparisons require independently verified pricing and evidence.

### Does the package install Tokenjuice, Lossless, or another compressor?

No. Candidate inspection and offline fidelity contracts are historical/partial evidence, not adoption. This preview does not install a second output compressor or take over the context-engine slot.

### Where can I get help?

Open a [GitHub issue](https://github.com/yuanzh0u/Agent-Token-Optimizer/issues) with the version, Node/host versions, failing command, exit code, and redacted diagnostics. Do not upload credentials, conversation contents, or your production configuration.

## Documentation and contribution

- [中文说明](README.zh-CN.md)
- [Operations, source configuration, upgrades, and rollback](docs/operations.md)
- [Public scope and evidence interpretation](docs/scope.md)
- [R01–R14 / T01–T28 acceptance matrix](docs/coverage.md)
- [Core API](packages/openclaw-token-efficiency/README.md)
- [Evidence index](evidence/README.md)
- [Changelog](CHANGELOG.md) and [contribution guide](CONTRIBUTING.md)

Maintained by [@yuanzh0u](https://github.com/yuanzh0u). This project is independently maintained and is not an official OpenClaw distribution.

## License

The license selection is pending. This preview currently has no selected open-source license.
