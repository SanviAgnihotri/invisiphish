#!/usr/bin/env bash
#
# Deploy InvisiPhish to the machine.
#
# The frontend is built here and the server is bundled here, because the
# machine has no GPU and not much memory to spare for a build. The machine
# gets the built frontend, the bundled server, and the runtime dependencies.
#
# What goes over:
#   dist/           the built frontend, with the int8 model and nothing else
#   dist-server/    the bundled API server
#   package.json    so the runtime dependencies can be installed
#   pnpm-lock.yaml  so they are installed at the versions that were tested
#   .env.local      the configuration and the secrets, mode 600
#
# What does not: the source, the seed checkpoints, the float32 export, the
# training checkpoints, and the datasets. The machine runs the application;
# it does not train models.
#
# Two instances run on the machine. This script deploys the sanvi
# deployment, on its own port; the instance behind temp.adityavyas.com
# runs an older release from its own directory and is left alone.
#
# Usage:
#   scripts/deploy/deploy.sh av@100.95.166.116

set -euo pipefail

TARGET="${1:-av@100.95.166.116}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-5180}"
PROCESS="${PROCESS:-invisiphish-sanvi}"

# The application's directory on the machine. It is resolved from the machine
# itself: the local $HOME is a different machine's home.
REMOTE_HOME="$(ssh "$TARGET" 'echo $HOME')"
APP_DIR="$REMOTE_HOME/invisiphish"

REMOTE_PATH="$REMOTE_HOME/.local/node22/bin:$REMOTE_HOME/.local/pnpm/bin:$REMOTE_HOME/.local/share/pnpm:$PATH"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

# --- build -----------------------------------------------------------------

say "building the frontend (int8 model)"
cd "$ROOT"
VITE_SEMANTIC_QUANTIZED=1 pnpm build >/dev/null

say "building the server"
pnpm build:server >/dev/null

say "trimming the frontend to what the application needs"
rm -rf dist/models/distilbert-phishing-seed13 \
       dist/models/distilbert-phishing-seed42 \
       dist/models/distilbert-phishing-seed77
rm -f dist/models/distilbert-phishing/model.safetensors \
      dist/models/distilbert-phishing/onnx/model.onnx

printf '    frontend %s\n' "$(du -sh dist | cut -f1)"
printf '    server   %s\n' "$(du -sh dist-server | cut -f1)"

# --- copy ------------------------------------------------------------------

say "copying to $TARGET"
ssh "$TARGET" "mkdir -p '$APP_DIR'"

rsync -az --delete \
  --exclude 'node_modules' \
  dist/ "$TARGET:$APP_DIR/dist/"

rsync -az --delete dist-server/ "$TARGET:$APP_DIR/dist-server/"

for file in package.json pnpm-lock.yaml pnpm-workspace.yaml; do
  rsync -az "$file" "$TARGET:$APP_DIR/$file"
done

# The configuration travels with the deployment and is never in the
# repository. The two settings that differ from a laptop are set here.
say "writing the configuration"
{
  sed -e 's#^MODEL_DIR=.*#MODEL_DIR=./dist/models/#' \
      -e 's#^PORT=.*#PORT='"$PORT"'#' \
      "$ROOT/.env.local"
  echo "SEMANTIC_QUANTIZED=1"
  echo "PORT=$PORT"
  echo "HOST=127.0.0.1"
} | ssh "$TARGET" "cat > '$APP_DIR/.env.local' && chmod 600 '$APP_DIR/.env.local'"

# --- dependencies ----------------------------------------------------------

say "installing the runtime dependencies"
ssh "$TARGET" "cd '$APP_DIR' && PATH='$REMOTE_PATH' pnpm install --prod --frozen-lockfile"

# --- run -------------------------------------------------------------------

say "restarting the service"
ssh "$TARGET" "cd '$APP_DIR' && PATH='$REMOTE_PATH' pm2 delete $PROCESS >/dev/null 2>&1 || true"
ssh "$TARGET" "cd '$APP_DIR' && PORT=$PORT PATH='$REMOTE_PATH' pm2 start dist-server/server.mjs \
  --name $PROCESS \
  --cwd '$APP_DIR' \
  --update-env \
  --time"

ssh "$TARGET" "PATH='$REMOTE_PATH' pm2 save >/dev/null 2>&1 || true"

say "checking it answers"
sleep 4
ssh "$TARGET" "curl -s -o /dev/null -w '    http://127.0.0.1:$PORT/ -> %{http_code}\n' http://127.0.0.1:$PORT/"
ssh "$TARGET" "curl -s http://127.0.0.1:$PORT/api/session"

printf '\n\033[1mThe application is running on the machine at http://127.0.0.1:%s\033[0m\n' "$PORT"
