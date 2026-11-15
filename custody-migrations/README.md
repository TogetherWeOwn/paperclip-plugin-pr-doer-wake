# Plugin namespace migrations

This directory contains the release lifecycle table in the stock host's derived
plugin namespace. Custody still reads only the three declared core tables.
Historical migrations in `../migrations` are not activated by this declaration.
The lifecycle is not promotion authorization and is not installed by this source change.
