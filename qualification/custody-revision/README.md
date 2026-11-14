# Sequential revision control

This is a source-only experiment, not a supported release or a custody qualification.
The workflow checks out unchanged public Paperclip source at two fixed commits in
separate, disposable GitHub-hosted runners, checks the source, package, lockfile
and MIT license blob identities, and copies the local synthetic control into each
checkout. The checkout retains the upstream MIT license and copyright notice.
The candidate is the unmerged source of upstream pull request 12036, not an
installed package or an assertion that it matches any deployed runtime.

The intended control connects the SDK worker RPC to the host handlers and the
server's database service. It requires embedded PostgreSQL: lack of database
support is a failure, not a skip. It creates a synthetic company and issue,
then checks the second document write and persisted readback. The baseline is
expected to omit the revision; the candidate is expected to forward it and
update the document. Both jobs must pass before broadening the experiment.
The output includes only synthetic keys, bodies and revision identifiers.

The workflow grants read-only repository access, does not persist checkout
credentials, retains test logs for seven days, and sets a job timeout. Hosted
runner teardown is the cleanup boundary, including on failure or cancellation.
A missing test log means the job did not reach the control; it is not a pass.
The fixture and workflow are experimental until their exact-head jobs pass.
The candidate's document-read authorization differs from the baseline; this
control is not evidence of equivalent private or locked-document protection.

The candidate job also attempts race, invalid-base, authorization and dropped-reply
observations after the sequential control. These cases share state and execute in
one test: a failed assertion prevents later cases from running. The reachability
ledger records starts, not completion or success; abrupt termination can suppress
it. Consult the exact-head job output for the actual result of each observation.
The bridge substitutes a generic error code and discards structured worker
response details, so it cannot establish real worker-manager error classification.
The dropped-reply readback is performed by the harness, not by custody.

After that test succeeds, the candidate job attempts two separately seeded
manager-boundary cases using the real worker manager, SDK worker process and
host handlers. Each checks denial, persisted readback and an authorized update.
The logged error code is an observation, not an assertion of its classification;
any rejection alone does not prove its cause. A failure before the manager step
means both cases are NOT REACHED; a missing manager log is not a pass. A failure
within a case may prevent its positive control from running. Worker startup,
teardown and the full composition remain unverified until Actions executes them.

## Unmet boundaries

This fixture does not invoke the actual custody disposition path or establish
revision-aware custody recovery, no-wake behavior, private/locked/unavailable
access, complete audit attribution, scheduler delivery, or full-contract
qualification. The unchanged custody disposition code does not supply a base
revision or implement conflicting-readback reconciliation. That is a source
observation, not an executed host failure. A pending synthetic write and matching
harness readback are not evidence of custody recovery or durable fail-closed
behavior. Candidate authorization differences remain unresolved; this experiment
does not authorize installation, release, or a change to custody containment.
