#!/usr/bin/env bash
# Asks how this Campfile should run, writes .env (and compose.override.yaml without screenshots), then starts it.
# For a new install: it stops if .env exists. The manual way is docs/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$@"; }
fail() { say "$@" >&2; exit 1; }
# The answer is left in $answer, not printed into $( ): there a failed read (Ctrl-D, input ended) could not stop the script.
ask() { read -r -p "$1 " answer || fail "" "Cancelled: nothing was written."; answer=${answer:-${2:-}}; }
secret() { IFS= read -r -s -p "$1 " answer || fail "" "Cancelled: nothing was written."; say ""; }
need() { answer=; while [ -z "$answer" ]; do ask "$1"; done; }
yes_no() { while :; do ask "$1 [$2]" "$2"; case $answer in [Yy]*) return 0 ;; [Nn]*) return 1 ;; esac; done; }
# .env values are single-quoted, so $ and spaces stay as typed; a single quote cannot be inside one.
no_quote() { [[ $answer != *"'"* ]] || { say "   A single quote (') cannot be used here. Type it again."; return 1; }; }
set_env() { env+=("$1='$2'"); }
tunnel="On a remote server, run 'ssh -L 8787:localhost:8787 <user>@<server>' on your own computer and keep it open; then open http://localhost:8787 there. Agents on your computer use the same tunnel."

if [ -e .env ]; then fail ".env exists already: this script is for a new install. To change a setting, edit .env, then run docker compose up -d. To start over, move .env away."; fi
docker compose version >/dev/null 2>&1 || fail "Docker with Compose is not installed: docs/DEPLOY.md \"Before you start\"."
docker info >/dev/null 2>&1 || fail "Docker is installed, but this user cannot use it (or it is not running)." \
  "Run this as root, or join the docker group: sudo usermod -aG docker \$USER, then log out and in again."

say "Campfile install. Enter accepts the answer in [brackets]." ""

# 1. Address
say "1. Address" \
  "   Press Enter to run Campfile on this computer only (http://localhost:8787)." \
  "   $tunnel" \
  "   Or type a domain name, such as pages.example.com, to share pages with other people over HTTPS." \
  "   A domain needs: DNS (one A record, no AAAA, no CDN proxy) pointing at this server, and TCP ports 80 and 443 open" \
  "   in your provider's firewall (docs/DEPLOY.md \"Before you start\")."
while :; do ask "   Domain:"; no_quote && break; done
domain=${answer#https://}; domain=${domain#http://}; domain=${domain%%/*}
env=()
if [ -n "$domain" ]; then
  set_env APP_ORIGIN "https://$domain"
  set_env COMPOSE_PROFILES https
  origin="https://$domain"
else
  origin="http://localhost:8787"
fi
say ""

# 2. Screenshots
say "2. Screenshots" \
  "   The screenshot service is a locked-down browser next to Campfile. It takes a picture of each published page, shown:" \
  "   - when a link is shared in WhatsApp, Slack, iMessage and similar apps" \
  "   - on the page's card in Your pages, and in the public view of how a page spread" \
  "   Without it those places show a picture drawn from the page's title. Everything else works the same." \
  ""
printf '   %-16s %-40s %s\n' "" "With screenshots" "Without" \
  "Memory (RAM)" "2 GB (1 GB works; heavy pages can fail)" "1 GB" \
  "Disk, programs" "about 2.5 GB" "about 1.4 GB" \
  "Security" "opens pages others wrote in a browser" "no browser on the server"
memory=$(awk '/^MemTotal:/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo 2>/dev/null || true)
disk=$(df -Pk . | awk 'NR == 2 { printf "%.1f", $4 / 1048576 }')
say "   This computer: ${memory:-unknown} GB of RAM, $disk GB of free disk here (Docker may store images elsewhere)."
if yes_no "   Take screenshots?" Y; then screenshots=1; else screenshots=; fi
say ""

# 3. Sign-in
say "3. Sign-in" \
  "   e) Email: Campfile emails sign-in codes, approvals and invitations. Needs an SMTP account (docs/DEPLOY.md \"Get outgoing email\")." \
  "   p) Password: only you sign in, with an email address and a password you choose. No email is sent." \
  "   l) Log: sign-in codes are printed in 'docker compose logs campfile'. Enough to try Campfile out; nobody else can sign in."
while :; do
  ask "   Choose e, p or l [p]:" p
  signin=$answer
  case $signin in e | p | l) break ;; esac
done
warn_open="   Anyone who finds this address can make an account and publish pages on your domain. There is no switch to stop that.
   Watch the notices sent to your email below; remove accounts with: docker compose exec campfile pnpm admin disable-tester <name>"
case $signin in
  e)
    if [ -n "$domain" ]; then say "$warn_open"; fi
    while :; do need '   SMTP server (such as smtp.example.com):'; no_quote && break; done
    set_env SMTP_HOST "$answer"
    while :; do ask '   SMTP port [587]:' 587; no_quote && break; done
    set_env SMTP_PORT "$answer"
    while :; do ask '   SMTP user name (Enter for none):'; no_quote && break; done
    if [ -n "$answer" ]; then
      set_env SMTP_USER "$answer"
      while :; do secret '   SMTP password:'; [ -n "$answer" ] && no_quote && break; done
      set_env SMTP_PASSWORD "$answer"
    fi
    while :; do need '   Send from (an address your provider allows, such as signin@example.com):'; no_quote && break; done
    set_env EMAIL_FROM "Campfile <$answer>"
    while :; do need '   Your email, for notices of new accounts and pages:'; no_quote && break; done
    set_env ADMIN_EMAIL "$answer"
    ;;
  p)
    while :; do need '   Your email address:'; no_quote && break; done
    set_env OWNER_EMAIL "$answer"
    while :; do
      secret '   Password (12 or more characters):'
      no_quote || continue
      if [ ${#answer} -ge 12 ]; then break; fi
      say "   Too short."
    done
    set_env OWNER_PASSWORD "$answer"
    if [ -n "$domain" ]; then say "   Only you can sign in until email is set up: nobody else gets a code."; fi
    ;;
  l) if [ -n "$domain" ]; then say "   On a domain, set up email before you share pages: until then nobody else can sign in."; fi ;;
esac
say ""

if yes_no "Start Campfile once the settings are written? It builds first, which takes a few minutes." Y; then start=1; else start=; fi

printf '%s\n' "# Written by install.sh. Every setting: docs/DEPLOY-ADVANCED.md, \"Settings reference\"." "${env[@]}" > .env
chmod 600 .env
if [ -z "$screenshots" ]; then
  if [ -e compose.override.yaml ]; then
    say "compose.override.yaml exists: add the 'Without screenshots' lines of docs/DEPLOY.md to it yourself." \
      "Settings are saved in .env. Campfile was NOT started: run docker compose up -d --build when the file is ready."
    exit 0
  else
    cat > compose.override.yaml <<'EOF'
# Written by install.sh: no screenshot service (docs/DEPLOY.md "Without screenshots"). Delete this file to turn it on.
services:
  screenshot:
    profiles: [screenshots] # not started, and not built
  campfile:
    environment:
      SCREENSHOT_URL: '' # no new screenshots: a page without one shows the picture drawn from its title
EOF
  fi
fi
if [ -n "$screenshots" ]; then say "Settings written to .env."; else say "Settings written to .env and compose.override.yaml."; fi

if [ -n "$start" ]; then
  docker compose up -d --build || fail "" "Settings are saved in .env. Fix the error above, then run: docker compose up -d --build"
  say "" "Campfile is starting at $origin" "Ready when 'docker compose ps' shows campfile as healthy (about a minute)."
  if [ -z "$domain" ]; then say "$tunnel"; fi
  case $signin in
    l) say "Sign-in codes: docker compose logs campfile" ;;
    p) say "Log in with your email; where Campfile asks for a code, type your password." ;;
  esac
  say "Change a setting later: edit .env here, then run docker compose up -d. Day-to-day commands: docs/DEPLOY.md \"Run, stop, restart\"."
else
  say "Start it later with: docker compose up -d --build"
fi
