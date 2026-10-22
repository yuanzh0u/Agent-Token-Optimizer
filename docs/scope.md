# Public preview scope

Agent-Token-Optimizer 0.1.0 provides reusable local token accounting, policy preview, synthetic/offline experiment tools, and an optional observation-only OpenClaw plugin. Its distribution is independent of the original development machine, pilot identities and monitoring scripts.

The R01–R14 and T01–T28 identifiers in coverage.md describe the broader acceptance program. They do not mean that program has completed. Pending real host gates, model/provider coverage, candidate adoption, quality/heldout pairs and elapsed soak remain pending. Unverified versions cannot reuse an exact-host capability label.

The initial public main branch is a clean source snapshot. Private planning archives, pilot mappings, local configuration fingerprints, raw probe source with machine paths and the earlier local development history are deliberately not published. The original implementation branch remains in the owner's local repository. This avoids publishing those records in ancestor commits. Historical evidence retained here is marked partial; it is not a substitute for rerunning the workload in another instance.

Repository source and tests can be checked with npm run verify. Exact runtime source hashes are in evidence/version-lock.json. The historical host inspection only proves the stated registration path on the stated version. Generated archive integrity belongs to the specific archive described; newly generated archives have their own integrity. Public release assets have independent SHA256SUMS.
