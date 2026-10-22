# Evidence index

Evidence here has different scopes. Do not combine partial observations into a completed production acceptance claim.

| File | Evidence scope |
| --- | --- |
| version-lock.json | Actual historical host/Node versions and hashes of distributed runtime/test sources; rerun verify for the current checkout |
| verification/final-fix-verify.txt | Historical local verification of the 127-test implementation before public documentation/packaging preparation |
| portable-package.json | A specific historical fresh-package/offline install proof; recorded integrity identifies that archive, not every future pack |
| governor-host-inspect.json / host-load | Exact-version isolated plugin registration and permission checks; service startup is not established |
| native-host-loop-run.json | One isolated host route with a local fake provider and harmless fixed exec; zero real-provider calls and no measured savings |
| native-detector-probe.json | Detector-function probes only; not general host run-termination coverage |
| output-candidate-probe.json / candidate-packages.json | Exact downloaded candidates and limited offline/registration probes; no adoption or savings claim |
| demo | Explicitly synthetic local report and health marker |

Private machine/planning/pilot archives and the original raw probe source are omitted. Retained evidence with local-path redactions is labelled; count values are unchanged. Historical hashes alone do not make an unprovided private artifact independently reproducible. Reproduction on another real instance, model pairs, pricing, quality, heldout and actual soak remain pending in docs/coverage.md.
