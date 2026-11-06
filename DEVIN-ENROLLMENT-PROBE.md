# Disposable review enrollment probe

This documentation-only change supplies a fresh pull request head for observing
automatic Devin Review status emission after repository enrollment.

It changes no runtime behavior, dependencies, workflows, or configuration.
The probe pull request must be closed without merging once observation and any
review-finding replies are complete; only its disposable remote branch is removed.
