#!/bin/sh
# nodeko-agent — установка / обновление.
#
# Шаблон: хаб отдаёт его по GET /install/agent.sh, подставив:
#   __HUB_URL__   https-база хаба (оттуда качается бинарь)
#   __HUB_WS__    wss://…/agent — куда подключается агент
#   __HUB_KEY__   публичный ключ хаба (base64url, закрепляется в конфиге агента)
#   __SHA_X64__ / __SHA_ARM64__   sha256 бинарей
#   __VERSION__   версия агента
#
# Первая установка:  curl -fsSL <hub>/install/agent.sh | sh -s -- --server <id> --token <токен>
# Обновление:        curl -fsSL <hub>/install/agent.sh | sh
#
# Без root — user-юнит под текущим пользователем (нужен Linger=yes, чтобы работал без входа).
# Под root — системный юнит с песочницей systemd.
set -eu

HUB_URL="__HUB_URL__"
HUB_WS="__HUB_WS__"
HUB_KEY="__HUB_KEY__"
VERSION="__VERSION__"
SHA_X64="__SHA_X64__"
SHA_ARM64="__SHA_ARM64__"

SERVER=""
TOKEN=""
LOCAL_BIN=""

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) [ $# -ge 2 ] || die "--server: нужно значение"; SERVER="$2"; shift 2 ;;
    --server=*) SERVER="${1#*=}"; shift ;;
    --token) [ $# -ge 2 ] || die "--token: нужно значение"; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --bin) [ $# -ge 2 ] || die "--bin: нужен путь"; LOCAL_BIN="$2"; shift 2 ;;
    --hub-ws) [ $# -ge 2 ] || die "--hub-ws: нужен адрес"; HUB_WS="$2"; shift 2 ;;
    -h|--help) echo "install.sh [--server <id> --token <токен>] [--bin <локальный бинарь>] [--hub-ws <ws(s)://…/agent>]"; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

case "$HUB_URL$HUB_WS$HUB_KEY$VERSION$SHA_X64$SHA_ARM64" in
  *__*) die "скрипт не подготовлен хабом (остались плейсхолдеры) — качайте его с хаба: <hub>/install/agent.sh" ;;
esac
if [ -n "$SERVER" ]; then
  printf '%s' "$SERVER" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' || die "--server: ожидается slug [a-z0-9-]"
fi
printf '%s' "$HUB_WS" | grep -Eq '^wss?://[A-Za-z0-9.:/_-]+$' || die "--hub-ws: ожидается ws(s)://host/agent"
if [ -n "$TOKEN" ]; then
  printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9_-]{16,200}$' || die "--token: неверный формат"
fi

command -v systemctl >/dev/null 2>&1 || die "нужен systemd"
command -v sha256sum >/dev/null 2>&1 || die "нужен sha256sum (coreutils)"
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https,http' --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "нужен curl или wget"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64; SHA="$SHA_X64" ;;
  aarch64|arm64) ARCH=arm64; SHA="$SHA_ARM64" ;;
  *) die "архитектура $(uname -m) не поддерживается" ;;
esac

if [ "$(id -u)" = "0" ]; then
  MODE=system
  BIN_DIR=/opt/nodeko-agent
  CONF_DIR=/etc/nodeko-agent
  STATE_DIR=/var/lib/nodeko-agent
  UNIT_DIR=/etc/systemd/system
  SCTL="systemctl"
  JCTL="journalctl"
else
  MODE=user
  BIN_DIR="$HOME/.local/share/nodeko-agent"
  CONF_DIR="$HOME/.config/nodeko-agent"
  STATE_DIR="$BIN_DIR"
  UNIT_DIR="$HOME/.config/systemd/user"
  SCTL="systemctl --user"
  JCTL="journalctl --user"
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  export XDG_RUNTIME_DIR
  [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
BIN="$BIN_DIR/nodeko-agent"
CONF="$CONF_DIR/agent.json"
KEY="$STATE_DIR/agent.key"
UNIT="$UNIT_DIR/nodeko-agent.service"

if [ ! -f "$CONF" ] && { [ -z "$SERVER" ] || [ -z "$TOKEN" ]; }; then
  die "первая установка: нужны --server <id> и --token <токен регистрации> (выдаются в nodeko → Настройки → Серверы)"
fi

umask 077
mkdir -p "$BIN_DIR" "$CONF_DIR" "$STATE_DIR" "$UNIT_DIR"
chmod 700 "$CONF_DIR" "$STATE_DIR"

# --- бинарь ---
say "nodeko-agent $VERSION ($ARCH, режим: $MODE)"
TMP="$BIN_DIR/.nodeko-agent.download.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
if [ -n "$LOCAL_BIN" ]; then
  say "бинарь из файла $LOCAL_BIN"
  cp "$LOCAL_BIN" "$TMP" || die "не удалось скопировать $LOCAL_BIN"
else
  say "загрузка $HUB_URL/install/nodeko-agent-linux-$ARCH"
  fetch "$HUB_URL/install/nodeko-agent-linux-$ARCH" "$TMP" || die "не удалось скачать бинарь"
fi
GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"
[ "$GOT" = "$SHA" ] || die "sha256 не совпадает (ожидалось $SHA, получено $GOT) — установка прервана"
chmod 755 "$TMP"
"$TMP" --version >/dev/null 2>&1 || die "скачанный бинарь не запускается на этой системе"
mv -f "$TMP" "$BIN"   # атомарная замена: работающий процесс держит старый inode до рестарта
trap - EXIT INT TERM
say "бинарь: $BIN (sha256 ок)"

# --- конфиг ---
if [ -n "$TOKEN" ] || [ ! -f "$CONF" ]; then
  [ -n "$SERVER" ] || die "--server обязателен вместе с --token"
  CTMP="$CONF.tmp.$$"
  cat > "$CTMP" <<EOF
{
  "hub": "$HUB_WS",
  "hubKey": "$HUB_KEY",
  "server": "$SERVER",
  "enroll": "$TOKEN",
  "keyFile": "$KEY"
}
EOF
  chmod 600 "$CTMP"
  mv -f "$CTMP" "$CONF"
  say "конфиг: $CONF (токен регистрации будет удалён агентом после первого подключения)"
else
  say "конфиг сохранён как есть: $CONF"
fi

# --- юнит ---
if [ "$MODE" = system ]; then
  cat > "$UNIT" <<EOF
[Unit]
Description=nodeko agent — мониторинг сервера
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN --config $CONF
Restart=always
RestartSec=5
Nice=5
MemoryMax=256M
StateDirectory=nodeko-agent
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$CONF_DIR $STATE_DIR
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictNamespaces=yes

[Install]
WantedBy=multi-user.target
EOF
else
  cat > "$UNIT" <<EOF
[Unit]
Description=nodeko agent — мониторинг сервера
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/share/nodeko-agent/nodeko-agent --config %h/.config/nodeko-agent/agent.json
Restart=always
RestartSec=5
Nice=5
MemoryMax=256M
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
fi
chmod 644 "$UNIT"

$SCTL daemon-reload
$SCTL enable nodeko-agent.service >/dev/null 2>&1 || die "не удалось включить юнит"
$SCTL restart nodeko-agent.service || die "не удалось запустить юнит"

if [ "$MODE" = user ] && command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    warn "Linger выключен — агент остановится после выхода из ssh. Включите: sudo loginctl enable-linger $(id -un)"
  fi
fi

sleep 3
if $SCTL is-active --quiet nodeko-agent.service; then
  say "агент запущен"
else
  warn "агент не запущен — смотрите журнал ниже"
fi
$SCTL --no-pager --lines=0 status nodeko-agent.service 2>/dev/null | sed -n '1,4p' || true
$JCTL -u nodeko-agent.service -n 8 --no-pager -o cat 2>/dev/null || true
