#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# QuizPe deploy. Run on the server, from the back-end repo root:
#   ./deploy/deploy.sh
#
# Assumes the three repos sit side by side, as they do in development:
#   ~/quizpe/serverpe-quizpe-back-end
#   ~/quizpe/serverpe-quizpe-admin-front-end
#   ~/quizpe/serverpe-quizpe-front-end
# ---------------------------------------------------------------------------
set -euo pipefail

API_BASE="${API_BASE:-https://api.quizpe.in}"
SITE_ROOT="${SITE_ROOT:-/var/www/quizpe-site}"
ADMIN_ROOT="${ADMIN_ROOT:-/var/www/quizpe-admin}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT="$(dirname "$HERE")"
ADMIN_SRC="$PARENT/serverpe-quizpe-admin-front-end"
SITE_SRC="$PARENT/serverpe-quizpe-front-end"

for d in "$ADMIN_SRC" "$SITE_SRC"; do
  [ -d "$d" ] || { echo "missing repo: $d"; exit 1; }
done

# Fail before touching anything if the API host is unreachable — otherwise the
# front-ends deploy fine and every request from them fails in the browser.
echo "==> checking $API_BASE/health"
curl -fsS --max-time 10 "$API_BASE/health" >/dev/null \
  || { echo "API not reachable at $API_BASE — start the back-end first"; exit 1; }

echo "==> back-end"
cd "$HERE"
npm ci --omit=dev

# Schema first: the code deployed below assumes these exist.
echo "==> database schema"
node scripts/migrate.js

echo "==> public site  (VITE_API_BASE=$API_BASE)"
cd "$SITE_SRC"
npm ci
VITE_API_BASE="$API_BASE" npm run build

echo "==> admin panel  (VITE_API_BASE=$API_BASE)"
cd "$ADMIN_SRC"
npm ci
VITE_API_BASE="$API_BASE" npm run build

# Publish only after BOTH builds succeed, so a broken build never leaves one
# half of the site live against the other half's API contract.
echo "==> publishing"
sudo mkdir -p "$SITE_ROOT" "$ADMIN_ROOT"
sudo rsync -a --delete "$SITE_SRC/dist/"  "$SITE_ROOT/"
sudo rsync -a --delete "$ADMIN_SRC/dist/" "$ADMIN_ROOT/"

echo "==> restarting API"
cd "$HERE"
pm2 reload quizpe --update-env || pm2 start src/app.js --name quizpe
pm2 save

echo "==> verifying"
sleep 3
curl -fsS --max-time 10 "$API_BASE/health" && echo
echo "done — https://quizpe.in  ·  https://admin.quizpe.in  ·  $API_BASE"
