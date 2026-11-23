#!/usr/bin/env bash
# Saves code, settings, database and page files into one new folder: ./backup.sh [--stop] [folder, default ~/campfile-backup]
# Campfile is stopped while it saves, then started again if it was running; --stop leaves it stopped (moving to a new server).
# Restore with ./restore.sh <the printed folder> (docs/DEPLOY.md "Back up").
set -euo pipefail
umask 077

step() { printf '%s\n' "$1"; }
fail() { printf '%s\n' "$@" >&2; exit 1; }
stop=
if [ "${1:-}" = --stop ]; then stop=1; shift; fi
root="${1:-$HOME/campfile-backup}"
mkdir -p "$root" && root=$(cd "$root" && pwd) || fail "Cannot make the folder $root."
cd "$(dirname "$0")"

case "$root/" in "$(git rev-parse --show-toplevel)/"*) fail "$root is inside this checkout: the backup would end up in Git. Give a folder outside it." ;; esac
[ -z "$(git status --porcelain)" ] || fail "This checkout has changes that are not committed (git status shows them)." \
  "Commit them first, so the backup holds the code that is running: docs/DEPLOY.md \"Back up\"."
# The value Compose will use, from .env, the shell or compose.override.yaml.
! docker compose config | grep -qE '^ +DATABASE_URL: +("[^"]|[^" ])' || fail "DATABASE_URL is set: this script backs up the bundled database only." \
  "Use your database's own backup: docs/DEPLOY-ADVANCED.md \"External Postgres\"."
running=$(docker compose ps --status running --services)
grep -x postgres >/dev/null <<<"$running" || fail "Campfile's database is not running: start it with docker compose up -d, then run this again."

b="$root/$(date +%Y%m%d-%H%M%S)"
mkdir "$b"
trap 'echo "Backup failed at the step above. $b is incomplete: delete it." >&2' ERR
step "Saving the code"
git bundle create "$b/code.bundle" HEAD
[ ! -f .env ] || cp .env "$b/env"
[ ! -f compose.override.yaml ] || cp compose.override.yaml "$b/compose.override.yaml"

step "Stopping Campfile, so the database and the files match"
docker compose stop campfile
# Start it again only if it was serving: one stopped on purpose (after a restore, during a leak) stays stopped.
if [ -z "$stop" ] && grep -x campfile >/dev/null <<<"$running"; then
  trap 'docker compose start campfile >/dev/null 2>&1 && echo "Campfile started again." || echo "Campfile did NOT start: run docker compose up -d" >&2' EXIT
fi
step "Saving the database"
docker compose exec -T postgres pg_dump -U campfile --clean --if-exists campfile > "$b/database.sql"
step "Saving page files and settings"
docker compose run --rm --no-deps -T --entrypoint tar campfile -C / -cf - settings data > "$b/files.tar"
touch "$b/complete"
trap - ERR

printf '%s\n' "Backup done: $b" \
  "It holds every page and your passwords: copy it off this server, and keep it private."
if [ -n "$stop" ]; then printf '%s\n' "Campfile stays stopped. Start it here again with: docker compose start campfile"; fi
