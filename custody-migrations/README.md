# Plugin namespace migrations

The release lifecycle migration declares a table in the stock host's derived
plugin namespace. Custody reads only the three declared core tables. Historical
migrations in `../migrations` are not activated by this declaration.

The migration is source and package material only in this change; it is not
applied or installed here. Installing a package that declares this migrations
directory can cause the host to apply it, and requires separate authorization.
The lifecycle table is not promotion authorization.
