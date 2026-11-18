#!/usr/bin/env bash
# Idempotent deploy for the Emry Wordle box. Run as root:
#   sudo bash deploy/setup.sh
# Safe to re-run: it pulls the latest code, reinstalls deps, and restarts the
# service without touching an existing ADMIN_TOKEN or database.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/sushant062/Emry-Wordle-functional.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/emry-wordle
DATA_DIR=/var/lib/emry-wordle
ENV_FILE=/etc/emry-wordle.env
SERVICE=emry-wordle
PORT="${PORT:-3000}"
SKIP_FUNNEL="${SKIP_FUNNEL:-0}"

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run this with sudo: sudo bash deploy/setup.sh"

step "system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git sqlite3 >/dev/null

step "node"
if [ -x /usr/bin/node ] && [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  echo "node $(/usr/bin/node --version) already installed"
else
  echo "installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  [ -x /usr/bin/node ] || fail "node did not install to /usr/bin/node"
fi
NODE_BIN=/usr/bin/node

step "service user and directories"
if ! id emry >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin emry
  echo "created user emry"
else
  echo "user emry already exists"
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R emry:emry "$APP_DIR" "$DATA_DIR"

step "code"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u emry git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u emry git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u emry git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
  echo "updated to $(sudo -u emry git -C "$APP_DIR" rev-parse --short HEAD)"
elif [ -z "$(ls -A "$APP_DIR")" ]; then
  sudo -u emry git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  echo "cloned $(sudo -u emry git -C "$APP_DIR" rev-parse --short HEAD)"
else
  fail "$APP_DIR is not empty and is not a git checkout; move it aside first"
fi

step "dependencies"
sudo -u emry env HOME="$APP_DIR" npm --prefix "$APP_DIR" ci --omit=dev --silent
echo "production dependencies installed"

step "environment file"
if [ -s "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; leaving ADMIN_TOKEN alone"
else
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  install -m 600 -o root -g root /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
ADMIN_TOKEN=$TOKEN
DB_PATH=$DATA_DIR/emry.db
PORT=$PORT
EOF
  echo "wrote $ENV_FILE with a fresh token"
fi
ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$ENV_FILE")"

step "word pool"
sudo -u emry env DB_PATH="$DATA_DIR/emry.db" "$NODE_BIN" "$APP_DIR/scripts/seed.js"

step "systemd unit"
UNIT=/etc/systemd/system/$SERVICE.service
install -m 644 "$APP_DIR/systemd/$SERVICE.service" "$UNIT"
# The unit ships with /usr/bin/node; point it at whatever is actually installed.
if ! grep -q "^ExecStart=$NODE_BIN " "$UNIT"; then
  sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP_DIR/src/server.js|" "$UNIT"
fi
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"

step "health check"
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/today" >/tmp/emry-today.json 2>/dev/null; then
    echo "app is responding on port $PORT: $(cat /tmp/emry-today.json)"
    break
  fi
  [ "$i" -eq 20 ] && {
    echo "app did not come up; recent logs:" >&2
    journalctl -u "$SERVICE" -n 40 --no-pager >&2
    exit 1
  }
  sleep 1
done

step "nightly backup"
CRON=/etc/cron.d/emry-wordle-backup
mkdir -p /var/backups/emry-wordle
cat >"$CRON" <<EOF
# Nightly online SQLite backup; keeps 14 days.
15 4 * * * root sqlite3 $DATA_DIR/emry.db ".backup '/var/backups/emry-wordle/emry-\$(date +\\%F).db'" && find /var/backups/emry-wordle -name 'emry-*.db' -mtime +14 -delete
EOF
chmod 644 "$CRON"
echo "installed $CRON"

FUNNEL_STATUS=""
if [ "$SKIP_FUNNEL" = "1" ]; then
  step "tailscale funnel (skipped)"
elif command -v tailscale >/dev/null 2>&1; then
  step "tailscale funnel"
  if tailscale funnel --bg "$PORT" >/tmp/emry-funnel.log 2>&1; then
    FUNNEL_STATUS="$(tailscale funnel status 2>&1 || true)"
  else
    echo "funnel setup failed; output was:" >&2
    sed -n '1,20p' /tmp/emry-funnel.log >&2
    echo "the app is still reachable over Tailscale at http://$(hostname):$PORT" >&2
  fi
else
  step "tailscale funnel (tailscale not installed; skipped)"
fi

cat <<EOF

============================================================
Emry Wordle is deployed.

  on the box:   http://127.0.0.1:$PORT
  over tailnet: http://$(hostname):$PORT
  admin token:  $ADMIN_TOKEN
  admin page:   /admin
  env file:     $ENV_FILE
  database:     $DATA_DIR/emry.db
  backups:      /var/backups/emry-wordle (nightly 04:15, 14-day retention)

Next: write the public URL onto the NFC sticker. Check the game from a phone
on cellular, not dorm Wi-Fi.
============================================================
EOF

if [ -n "$FUNNEL_STATUS" ]; then
  printf '\n%s\n' "$FUNNEL_STATUS"
fi
