# Agent-Token-Optimizer: instructions for agents

## Install and verify

Read README.md and agent-install.json. Use the canonical GitHub repository and the requested version tag; do not substitute a similarly named npm package. Use a fresh directory, check package.json engines, run `npm run verify`, then `npm run demo`. The source checkout needs no build or dependency installation. CLI help is `node bin/agent-token-optimizer.mjs --help`.

Report command exit codes and the demo paths. The demo is synthetic and makes no model calls; its counts are not measured savings. A source install is complete only after the verification command succeeds.

## Configure only within the user's request

For an explicitly requested deployment, run `init --directory` in a separate directory and configure only sources the user authorized. Defaults are observe mode with no sources. Agent IDs are opaque strings. Preserve unknown values and explicit cache semantics.

Installing the core/CLI does not authorize modifying OpenClaw, installing/enabling plugins, granting conversation access, changing models/skills/heartbeat/permissions/context engines, or making paid requests. Do those only when the user's task explicitly includes them. Follow docs/operations.md for optional plugin setup and preserve unrelated host settings.

Exit 2 from collect/report means unavailable or stale, not success or zero usage. Read the coverage and health fields even when exit is 0. Use CLI report for current health; a saved HTML file only knows its snapshot age. Do not share a writable state directory between independent deployments.

## Develop this repository

Use Node versions allowed by package.json; Linux/Node 24.21.0 is the verified baseline. Run `npm run verify` after runtime changes. It includes real tarball portability. The source lock in evidence/version-lock.json must reflect intentionally reviewed changes; do not update hashes merely to hide an unexpected mismatch.

Keep .state, databases, credentials, conversation content and private host/pilot records out of commits. Never force-open a foreign/newer SQLite schema or delete recovery sidecars to bypass a refusal. Public documentation must retain the preview limitations in docs/coverage.md. Do not claim production gates, complete billing coverage, candidate adoption or real token savings from mocks, fixtures or plugin registration.
