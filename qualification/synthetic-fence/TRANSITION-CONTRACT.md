# Proposed transition fixture contract — not qualification

This is an implementation and review target, not a claim that these fixtures or a safe execution boundary exist. The in-memory fence is disconnected from retained code and cannot authorize a package run. Do not remove or bypass the retained controller's unconditional refusal. Before any protected execution, independently verify immutable trusted controller/import provenance and requested-head binding, runner and daemon exclusivity, disposable isolation and network containment. Resolve the image-reference prerequisite and retain Security → QA and release gates.

## Inputs and ownership

- Pin candidate source `029068369571717517a2ed96aaff0b921aafc934` and TGZ SHA-256 `15c89cc1100461563553c6a221910151b039bf4df78c5d4c101a325b275dfc2d`; old source `e2fd77b3f77fa0b5c644db077bc3039edde38b8d` and TGZ SHA-256 `836618f38a6c05a84f67a045424005acc875721e3e0d8dbc3f059ace5acb48ec`. Fail before execution on identity mismatch. Package version is not identity. Record the exact SDK and all resolved runtime dependency identities; distinguish retained artifacts from source-built artifacts.
- A future coordinator owns one synthetic durable state and append-only effect-attempt journal, outside each fresh worker. No production credentials, connections, configuration, or effects. Explicitly allowlist host RPCs; unexpected requests fail closed. Simulated effect endpoints must record every attempt, not suppress duplicates by idempotency.
- Each phase identifies its artifact, configuration, commands, input state, observations, and independent snapshot. Use fresh workers in candidate → old → candidate order. Bind snapshots and the journal to the test case, phase and artifact hashes; never mix case evidence.
- Before handing the state to another worker, stop admission, require successful phase completion and independently verified worker close and stream drain, then settle every host handler **and response delivery**. Registration precedes handler dispatch. Any crash, timeout, protocol error, late RPC or ambiguous teardown poisons the entire case and prevents future writers. A timeout does not prove non-dispatch. Stream-drain and exclusive-control claims require independent boundary evidence, not a caller-provided boolean. The current model cannot guarantee safety if a purported drain is false and a late request arrives after another writer starts.

## Required observations at each boundary

Capture full before/after synthetic durable-state snapshots and the ordered effect-attempt journal, with explicit assertions for CI and custody, including relevant hot receipts, archived records and cursors. Assert continuity and interpretation, not merely successful startup. For each subsystem exercise:

1. **Confirmed:** retain evidence of a dispatched/confirmed attempt across both boundaries; no additional attempt for the retained identity.
2. **Ambiguous:** retain the uncertain attempt across both boundaries; no additional attempt while its evidence is retained. A timeout, exception or lost response alone is ambiguous.
3. **Known not sent:** only a positive synthetic host observation proving non-dispatch permits a retry; assert the permitted attempt count and evidence provenance. No inferred non-dispatch from cancellation.

Exercise archive and hot-record retention, cursor continuity, dependency-completion epochs and event gaps as distinct cases with explicit starting states and expected post-boundary states. Include a negative case in which non-comment custody evidence is presented, capture each artifact's actual decision, and report any Security-rejected old-policy behavior honestly. Compatible state is not policy approval. Cases may intentionally fail; report actual results instead of relaxing assertions.

## Evidence and limits

Record fixture/harness commit SHA, exact Actions run and job URLs/head SHA, dependency identities, per-case outcome and snapshots/journal needed to audit claims. Test delayed handlers and responses, close-before-drain, crash, timeout, late RPC and no-next-writer on poison against the eventual adapter, not only this model. A unit model, fake signal or passing same-version suite is not proof of isolation, actual artifact behavior, host configuration, durable live archives, teardown, automatic reconciliation, blanket exactly-once delivery, installation or rollback safety. The provider VM disposal assumption is not a teardown receipt.
