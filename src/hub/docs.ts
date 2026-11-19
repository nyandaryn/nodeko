import { getSettings } from "./settings.ts";

/** Краткая справка по API для ИИ-агентов: GET /api/v1/docs (markdown). */
export function apiDocs(): string {
  const base = getSettings().publicUrl;
  return `# nodeko API

Мониторинг серверов и сервисов. База: ${base}

## Доступ
- \`Authorization: Bearer nk_<id>_<secret>\` — API-токен (Настройки → API-токены). scope \`read\` — только GET, \`admin\` — ещё и изменения.
- MCP (Streamable HTTP): \`${base}/mcp\` с тем же заголовком. Подключение к Claude Code:
  \`claude mcp add --transport http nodeko ${base}/mcp --header "Authorization: Bearer <токен>"\`
- Единицы: время — ms epoch UTC, память/диск — байты, скорости — байт/с, CPU — %, у сервисов — % одного ядра.

## Модель
- **Сервер** (\`id\` — slug): status ok|warn|down|pending, \`now\` — последние метрики, \`counts\` — статусы его сервисов.
- **Сервис** (\`id\` — число): kind systemd|systemd-user|docker|pm2, role service|job, group — группа в дереве
  (null у автогруппы по префиксу имени), state running|exited|starting|stopping|restarting|failed|inactive.
  status ok|warn|down|stopped|unknown. \`tracked=false\` — скрыт, \`muted=true\` — без уведомлений.
- **Проверка** (\`id\`): http|tcp, runner \`hub\` (снаружи) или id сервера (агент проверяет изнутри),
  привязка к serverId/serviceId; \`retries\` — неудач подряд до down.
- **Событие**: level info|ok|warn|error, type server.offline|server.online|service.down|service.up|service.restart|
  service.new|service.missing|check.down|check.up|alert.cpu|alert.mem|alert.disk|alert.clear|cert.expiring|agent.enrolled|config.*.

## Чтение
| | |
|---|---|
| GET /api/v1/overview[?all=1] | все серверы, сервисы (all=1 — со скрытыми), проверки |
| GET /api/v1/servers/:id | детали сервера |
| GET /api/v1/servers/:id/metrics?range=1h\\|6h\\|24h\\|7d\\|30d\\|1y | ряды: t (UNIX-сек), cpu, cpuMax, mem, memUsed, swapUsed, disk, diskRead, diskWrite, netRx, netTx, load1, ping |
| GET /api/v1/services/:id | детали: версия, коммит, порты, проверки, recentErrors, recentEvents, errorsHourly |
| GET /api/v1/services/:id/metrics?range= | cpu, cpuMax, mem, memMax |
| GET /api/v1/services/:id/logs?limit=&before=&since= | строки-ошибки, новые первыми |
| GET /api/v1/checks, /api/v1/checks/:id, /api/v1/checks/:id/results?range= | проверки и история (ms, up) |
| GET /api/v1/events?limit=&before=&since=&server=&service=&check=&level= | журнал, новые первыми |
| GET /api/v1/settings | настройки (токен бота не раскрывается) |

## Изменения (admin)
| | |
|---|---|
| PATCH /api/v1/services/:id | {displayName?, group? (null — авто, "" — без группы), tracked?, muted?, sort?, notes?} |
| DELETE /api/v1/services/:id | забыть сервис (вернётся, если агент снова его увидит) |
| POST /api/v1/servers | {id, name, description?} → токен регистрации + installCommand |
| PATCH /api/v1/servers/:id | {name?, description?, sort?, overrides? (пороги или null)} |
| POST /api/v1/servers/:id/enroll | новый токен регистрации (старый ключ агента отзывается) |
| DELETE /api/v1/servers/:id | удалить сервер и его историю |
| POST /api/v1/checks | {name?, type, target, runner?, serverId?, serviceId?, interval?, timeout?, expect?, keyword?, method?, insecure?, retries?, enabled?} |
| PATCH /api/v1/checks/:id, DELETE /api/v1/checks/:id | |
| PATCH /api/v1/settings | частичный объект настроек (см. GET) + notify.telegram.botToken для записи |
| POST /api/v1/settings/notify/test | тестовое сообщение в Telegram |

Токены, passkeys, сессии и пароль меняются только из веб-сессии.

## Агент на сервере
Ставится командой из ответа POST /api/v1/servers (\`curl -fsSL ${base}/install/agent.sh | sh -s -- --server <id> --token <токен>\`),
работает user-юнитом \`nodeko-agent\` под пользователем приложений, без root. Обновление — та же команда без --token.
Агент только читает систему и шлёт данные по зашифрованному каналу; команд от хаба не исполняет.
`;
}
