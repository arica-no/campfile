#!/usr/bin/env bash
# Puts a backup from ./backup.sh back: ./restore.sh <backup folder>
# Moves this checkout to the backup's code, restores settings, database and page files, and leaves Campfile stopped
# so you can check it first (docs/DEPLOY-ADVANCED.md "Restore a backup").
# Data already on this server is saved first, into <backup folder>-replaced-<time>.
set -euo pipefail

fail() { printf '%s\n' "$@" >&2; exit 1; }
step() { printf '%s\n' "$1"; }
[ $# -eq 1 ] || fail "Usage: ./restore.sh <backup folder>"
b=$(cd "$1" 2>/dev/null && pwd) || fail "No folder $1."
cd "$(dirname "$0")"
[ -f "$b/complete" ] || fail "$b has no 'complete' file: that backup did not finish. Use another one."
tar -tf "$b/files.tar" >/dev/null || fail "$b/files.tar cannot be read: use another backup."
trap 'echo "Restore failed at the step above. Fix the cause, then run ./restore.sh $b again." >&2' ERR
umask 077
# The volume names below are the default project's: campfile_pgdata, campfile_data, campfile_settings.
same_project() { [ "$(docker compose config | sed -n 's/^name: //p')" = campfile ] || fail "COMPOSE_PROJECT_NAME is set: this script works only with the default project name, campfile."; }
same_project

# The code goes to the backup's commit on this branch, so a later git pull --rebase upgrades as usual.
git symbolic-ref -q HEAD >/dev/null || fail "This checkout is not on a branch. Clone https://github.com/arica-no/campfile and run its selfhost/restore.sh."
[ -z "$(git status --porcelain)" ] || fail "This checkout has changes that are not committed (git status shows them). Commit them first."
code=$(git bundle list-heads "$b/code.bundle" HEAD | cut -d' ' -f1)
was=$(git rev-parse HEAD)

old=$(docker volume ls -q | grep -xE 'campfile_(pgdata|data|settings)' || true)
if [ -n "$old" ]; then
  keep="$b-replaced-$(date +%Y%m%d-%H%M%S)"
  step "Campfile already has data on this server. It will be stopped, saved to $keep, then replaced by the backup."
  read -r -p "Type yes to go on: " answer || answer=
  [ "$answer" = yes ] || fail "Nothing was changed."
  step "Stopping Campfile and saving its current data"
  docker compose down
  mkdir "$keep"
  [ ! -f .env ] || cp .env "$keep/env"
  [ ! -f compose.override.yaml ] || cp compose.override.yaml "$keep/compose.override.yaml"
  docker run --rm -v campfile_pgdata:/v/pgdata -v campfile_data:/v/data -v campfile_settings:/v/settings \
    postgres:17-trixie tar -C /v -cf - . > "$keep/volumes.tar"
  docker volume rm campfile_pgdata campfile_data campfile_settings >/dev/null
  step "  Saved, with the code it ran ($was). To go back to it: docs/DEPLOY-ADVANCED.md \"Undo a restore\"."
fi

if [ "$code" != "$was" ]; then
  step "Moving the code to the backup's version"
  git fetch -q "$b/code.bundle" HEAD
  git reset -q --hard "$code"
  step "  Code is now at $code. It was at $was; git reset --hard $was goes back."
fi

now=$(date +%Y%m%d-%H%M%S)
for f in .env compose.override.yaml; do [ ! -f "$f" ] || mv "$f" "$f.before-restore-$now"; done
[ ! -f "$b/env" ] || cp "$b/env" .env
[ ! -f "$b/compose.override.yaml" ] || cp "$b/compose.override.yaml" compose.override.yaml
same_project
step "Building Campfile (a few minutes)"
docker compose build
docker compose create # makes the volumes as Compose's own, so it does not warn about them later
step "Restoring settings and page files"
docker run --rm -i --user 0 -v campfile_settings:/settings -v campfile_data:/data --entrypoint tar campfile-selfhost -C / -xf - < "$b/files.tar"
step "Starting the database"
docker compose up -d --wait postgres
docker compose run --rm --no-deps -T campfile pnpm migrate
step "Restoring the database"
docker compose exec -T postgres psql -U campfile -q -v ON_ERROR_STOP=1 --single-transaction -f - campfile < "$b/database.sql" >/dev/null
trap - ERR

printf '%s\n' "Restored from $b. Campfile is not serving yet." \
  "Before you start it, redo what was closed since the backup: docs/DEPLOY-ADVANCED.md \"Restore a backup\"." \
  "Then start it: docker compose up -d"
