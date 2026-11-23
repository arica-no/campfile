#!/bin/sh
# The image's Node preload supplies owner credentials to migrations and maintenance commands.
set -e
pnpm migrate

# Only startup changes to the least-privilege role; the preload must preserve this exported URL.
DATABASE_URL=$(node --disable-warning=ExperimentalWarning selfhost/app-role.ts)
export DATABASE_URL

exec node --disable-warning=ExperimentalWarning selfhost/server.ts
