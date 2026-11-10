# Read-only core access

The stock manifest requires a migrations directory for a database declaration.
This directory intentionally contains no SQL migrations. Custody uses only the
three declared core-read tables; all plugin receipts live in plugin state.
Historical migrations in `../migrations` are not activated by this declaration.
