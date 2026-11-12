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
No race, recovery, delivery, scheduler, live installation, or full-contract
claim follows from this sequential test.
