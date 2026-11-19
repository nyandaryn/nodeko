#!/usr/bin/env bash
# Выкатка хаба nodeko по ssh (запускать откуда угодно).
#   NODEKO_DEPLOY_HOST=user@host deploy/hub/deploy.sh   — собрать веб и агентов, залить, перезапустить
#   SKIP_BUILD=1 …                                      — без пересборки
# Хост можно задать в deploy/hub/.deploy.env (в git не попадает). Первичная настройка хоста — README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
[ -f "$here/.deploy.env" ] && . "$here/.deploy.env"
HOST="${NODEKO_DEPLOY_HOST:?задайте NODEKO_DEPLOY_HOST=user@host (или deploy/hub/.deploy.env)}"
cd "$here/../.."

bun install --frozen-lockfile >/dev/null
if [ -z "${SKIP_BUILD:-}" ]; then
  bun run build:web
  bun run build:agent
fi
[ -f web/dist/index.html ] || { echo "нет web/dist — соберите веб"; exit 1; }
[ -f dist/agent/manifest.json ] || { echo "нет dist/agent — соберите агента"; exit 1; }

rsync -az --delete --relative \
  package.json bun.lock tsconfig.json src web/dist dist/agent deploy \
  "$HOST:nodeko/"

ssh "$HOST" 'set -e
  cd ~/nodeko
  ~/.bun/bin/bun install --frozen-lockfile --production >/dev/null
  systemctl --user restart nodeko-hub
  sleep 2
  systemctl --user is-active nodeko-hub
  curl -fsS http://127.0.0.1:4170/api/health; echo'
