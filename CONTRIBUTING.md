# Contributing

Open an issue to describe a bug or proposed change. Include the package, Node and optional host version, the failing command/exit code and a minimal synthetic example. Do not attach secrets, conversation content, production configuration or private runtime databases.

Use the source installation in README.md. Run `npm run verify` before sending a pull request; the command includes source-integrity checks, tests and fresh-package execution. No real model or production host is needed for the default verification. Review intentional source changes before updating the corresponding hashes in evidence/version-lock.json.

Keep agent identities configurable, missing usage distinct from zero, billing identities trustworthy, and state/report/source ownership separate. Do not add a second compressor or context engine. Preserve the observe-only default and the coverage limitations; tests using synthetic evidence do not establish a real savings claim.

For optional host work, state the exact host/runtime/provider/work-class scope and keep it in an isolated instance. Changes involving real models, external side effects or production enablement need an explicit request from the operator. Use docs/operations.md for state migration/recovery and rollback boundaries.

Maintainer: [@yuanzh0u](https://github.com/yuanzh0u). Questions and bug reports: [GitHub Issues](https://github.com/yuanzh0u/Agent-Token-Optimizer/issues).
