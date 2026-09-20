#!/usr/bin/env bash
#
# scripts/deploy.sh — pull the latest main onto this server and restart.
#
#   cd /var/www/serverpe-quizpe-back-end && ./scripts/deploy.sh
#
# Run it ON THE SERVER. It does what a careful person would do by hand, in the
# same order, and refuses rather than guesses when something looks wrong.
#
# WHY THIS EXISTS. Production once carried 52 files that had been edited
# directly on the box: whole features that existed nowhere in git, and a `main`
# branch three commits behind the code that was actually running. Nothing was
# lost that time, but only because every file turned out to be a duplicate of
# an unmerged branch. The next time would not be so lucky, and a plain
# `git pull` would have overwritten the lot without a word.
#
# So the first thing this does is refuse to run on a dirty tree.
#
set -euo pipefail

cd "$(dirname "$0")/.."

APP="${PM2_APP:-serverpe-quizpe}"
BRANCH="${DEPLOY_BRANCH:-main}"
FORCE="${1:-}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

# ── 1. never deploy into a quiz ──────────────────────────────────────────────
# The window is 7:00–11:45 PM IST and a restart drops whatever is in flight.
# A child halfway through ten questions does not care that the release was
# important. Pass --force if you genuinely must.
HOUR=$(TZ=Asia/Kolkata date +%H)
MIN=$(TZ=Asia/Kolkata date +%M)
NOW=$((10#$HOUR * 60 + 10#$MIN))
if [ "$NOW" -ge $((19 * 60)) ] && [ "$NOW" -lt $((23 * 60 + 45)) ] && [ "$FORCE" != "--force" ]; then
  fail "It is $(TZ=Asia/Kolkata date +%H:%M) IST — inside the quiz window (19:00–23:45).
  Children may be mid-quiz. Deploy after 23:45, or re-run with --force if you must."
fi

# ── 2. the tree must be clean ────────────────────────────────────────────────
# Anything uncommitted here was written on the server and exists nowhere else.
# Stop, and let a human decide what it is — do not pull over the top of it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short
  fail "Files have been modified on this server.
  They exist nowhere else, and pulling would overwrite them.

  To keep them:   git checkout -b server-changes-\$(date +%Y%m%d) && git add -A && git commit -m 'server edits'
  To discard:     git checkout -- .
  Then run this again."
fi

BEFORE=$(git rev-parse HEAD)
say "Deploying $BRANCH  ·  currently at $(git log --oneline -1)"

# ── 3. fast-forward only ─────────────────────────────────────────────────────
# --ff-only refuses to invent a merge commit. If it fails, this server's
# history has diverged from the remote, which is a thing to look at rather
# than automate past.
git fetch origin --quiet
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then
  say "Already up to date — nothing to deploy."
  exit 0
fi

git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/  incoming: /'
git merge --ff-only "origin/$BRANCH" --quiet \
  || fail "Cannot fast-forward. This server's history has diverged from origin/$BRANCH."

AFTER=$(git rev-parse HEAD)

# ── 4. dependencies, only when they actually changed ─────────────────────────
# npm ci deletes and rebuilds node_modules, which takes minutes. Worth it when
# the lockfile moved, pure delay when it did not.
if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json package.json; then
  say "Dependencies changed — installing"
  npm ci --omit=dev
else
  echo "  dependencies unchanged — skipping npm ci"
fi

# ── 5. restart ───────────────────────────────────────────────────────────────
# --update-env so a changed .env is picked up. Without it pm2 keeps the values
# it started with, and an edited setting appears to do nothing at all.
say "Restarting $APP"
pm2 restart "$APP" --update-env >/dev/null

# ── 6. prove it came back ────────────────────────────────────────────────────
# A deploy that ends at "restarted" is a deploy that has not been checked. The
# app must be online AND have logged that it is listening, since pm2 reports a
# process that crashes on boot as online for a moment before it dies.
sleep 6
STATUS=$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(p=>p.name===process.argv[1]);console.log(a?a.pm2_env.status:"missing")})' "$APP")
[ "$STATUS" = "online" ] || fail "$APP is '$STATUS' after restart. Roll back with:
  git checkout $BEFORE && pm2 restart $APP --update-env"

if pm2 logs "$APP" --lines 40 --nostream 2>/dev/null | grep -q "listening on"; then
  say "✓ Deployed $(git log --oneline -1)"
  pm2 logs "$APP" --lines 40 --nostream 2>/dev/null \
    | grep -iE "listening|scheduler|worker" | tail -3 | sed 's/^/  /'
else
  fail "$APP restarted but never logged 'listening'. Check: pm2 logs $APP --err --lines 40
  Roll back with: git checkout $BEFORE && pm2 restart $APP --update-env"
fi

# The previous commit, so a rollback needs no detective work.
printf '\n  previous: %s\n  rollback: git checkout %s && pm2 restart %s --update-env\n\n' \
  "$BEFORE" "$BEFORE" "$APP"
