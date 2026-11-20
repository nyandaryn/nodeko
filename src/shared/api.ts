/**
 * Контракт REST API хаба — общий для веб-интерфейса, MCP и ИИ-агента.
 *
 * Аутентификация: cookie-сессия (веб) или `Authorization: Bearer nk_<id>_<secret>` (API-токен).
 * Токены со scope `read` — только GET; `admin` — всё. Мутирующие запросы с cookie обязаны
 * приходить с того же Origin (CSRF). Ошибки: HTTP 4xx/5xx + `ApiError`.
 * Все времена — ms epoch (UTC), размеры — байты, скорости — байт/с, CPU — проценты.
 *
 * Эндпоинты (префикс /api):
 *   GET    /auth/state                      → AuthState            (без авторизации)
 *   POST   /auth/login        LoginBody     → AuthState
 *   POST   /auth/logout                     → {ok}
 *   POST   /auth/passkey/login/options      → {challengeId, options}       (без авторизации)
 *   POST   /auth/passkey/login/verify  {challengeId, response} → AuthState
 *   POST   /auth/passkey/register/options   → {challengeId, options}
 *   POST   /auth/passkey/register/verify {challengeId, response, name} → PasskeyItem
 *
 *   GET    /v1/overview                     → Overview
 *   GET    /v1/servers/:id                  → ServerDetail
 *   GET    /v1/servers/:id/metrics?range=   → ServerMetrics          range: MetricsRange
 *   POST   /v1/servers          ServerCreateBody → ServerEnrollment
 *   PATCH  /v1/servers/:id      ServerPatchBody  → ServerDetail
 *   POST   /v1/servers/:id/enroll           → ServerEnrollment (новый токен; старый ключ агента отзывается)
 *   DELETE /v1/servers/:id                  → {ok}
 *   GET    /v1/services/:id                 → ServiceDetail
 *   GET    /v1/services/:id/metrics?range=  → ServiceMetrics
 *   GET    /v1/services/:id/logs?limit=&before= → LogItem[]   (строки-ошибки, новые сначала)
 *   PATCH  /v1/services/:id     ServicePatchBody → ServiceDetail
 *   DELETE /v1/services/:id                 → {ok}   (забыть сервис; вернётся, если агент его снова увидит)
 *   GET    /v1/checks                       → CheckSummary[]
 *   POST   /v1/checks           CheckBody   → CheckSummary
 *   PATCH  /v1/checks/:id       Partial<CheckBody> → CheckSummary
 *   DELETE /v1/checks/:id                   → {ok}
 *   GET    /v1/checks/:id/results?range=    → CheckResults
 *   GET    /v1/events?limit=&before=&server=&service=&check=&level= → EventItem[]
 *   GET    /v1/settings                     → Settings
 *   PATCH  /v1/settings         SettingsPatch → Settings
 *   POST   /v1/settings/notify/test         → {ok, error?}
 *   GET    /v1/tokens                       → TokenItem[]
 *   POST   /v1/tokens           {name, scope} → TokenCreated (секрет показывается один раз)
 *   DELETE /v1/tokens/:id                   → {ok}
 *   GET    /v1/sessions                     → SessionItem[]
 *   DELETE /v1/sessions/:id                 → {ok}
 *   GET    /v1/passkeys                     → PasskeyItem[]
 *   PATCH  /v1/passkeys/:id     {name}      → PasskeyItem
 *   DELETE /v1/passkeys/:id                 → {ok}
 *   POST   /v1/account/password {current, next} → {ok}
 *   GET    /v1/notes?q=&kind=&tag=&server=&service= → NoteSummary[]   (база знаний; q — поиск)
 *   GET    /v1/notes/:id                    → Note
 *   POST   /v1/notes            NoteCreateBody → Note             (409, если id занят)
 *   PATCH  /v1/notes/:id        NotePatchBody  → Note             (409 при устаревшем baseRev)
 *   DELETE /v1/notes/:id?baseRev=           → {ok}   (история версий сохраняется)
 *   GET    /v1/notes/:id/revisions          → NoteRevisionItem[]  (новые первыми; работает и для удалённой)
 *   GET    /v1/notes/:id/revisions/:rev     → Note   (содержимое версии)
 *   GET    /v1/docs                         → text/markdown — описание API для ИИ-агентов
 *
 * Прочее: POST /mcp — MCP (Streamable HTTP, Bearer-токен); GET /agent — WebSocket агентов;
 * GET /install/agent.sh, /install/nodeko-agent-linux-{x64,arm64} — установка агента.
 */
import type { CheckType, ServiceKind, ServiceState } from "./protocol.ts";

export type Status = "ok" | "warn" | "down" | "stopped" | "unknown" | "pending";

export interface ApiError {
  error: string;
  /** машинный код: unauthorized, forbidden, not_found, bad_request, rate_limited, conflict, internal */
  code: string;
}

// ---------- auth ----------

export interface AuthState {
  authenticated: boolean;
  /** есть ли вообще пользователь (если нет — нужно создать через CLI на хабе) */
  configured: boolean;
  user: { username: string } | null;
  passkeys: number;
}

export interface LoginBody {
  username: string;
  password: string;
}

// ---------- overview / tree ----------

export interface HostInfoDto {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memTotal: number;
  bootTime: number;
  user: string;
  agentVersion: string;
  caps: Record<string, boolean>;
}

export interface ServerNow {
  /** ms epoch снимка */
  ts: number;
  cpu: number;
  load: [number, number, number];
  memUsed: number;
  memTotal: number;
  /** % памяти */
  mem: number;
  swapUsed: number;
  swapTotal: number;
  /** корневая ФС */
  diskUsed: number;
  diskTotal: number;
  /** % корневой ФС */
  disk: number;
  diskRead: number;
  diskWrite: number;
  netRx: number;
  netTx: number;
  ping: number | null;
  /** секунды с загрузки */
  uptime: number;
  procs: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string | null;
  status: Status;
  /** человекочитаемая причина статуса: «нет связи 3 мин», «CPU 97% > 90%» */
  statusReason: string | null;
  statusSince: number;
  connected: boolean;
  lastSeen: number | null;
  sort: number;
  host: HostInfoDto | null;
  now: ServerNow | null;
  /** количество отслеживаемых сервисов/проверок сервера по статусам */
  counts: Record<Status, number>;
  /** агент зарегистрирован (есть ключ) */
  enrolled: boolean;
  /** версия агента устарела относительно хаба */
  agentOutdated: boolean;
}

export type ServiceRole = "service" | "job";

export interface ServiceSummary {
  id: number;
  serverId: string;
  key: string;
  kind: ServiceKind;
  /** имя у источника (юнит/контейнер/процесс) */
  name: string;
  /** имя для отображения (если задано) */
  displayName: string | null;
  /** группа в дереве; null — сервис висит прямо на сервере */
  group: string | null;
  role: ServiceRole;
  status: Status;
  statusReason: string | null;
  statusSince: number;
  state: ServiceState | null;
  tracked: boolean;
  muted: boolean;
  /** пропал из обнаружения (юнит удалён/контейнер удалён) */
  missing: boolean;
  sort: number;
  /** ms epoch начала текущего запуска (аптайм) */
  since: number | null;
  /** для задач — когда последний раз отработала */
  lastRun: number | null;
  version: string | null;
  commit: string | null;
  cpu: number | null;
  mem: number | null;
  restarts: number | null;
  ports: number[];
  /** строк-ошибок за последний час */
  errors1h: number;
  /** проверки, привязанные к сервису */
  checks: { total: number; ok: number };
}

export interface CheckSummary {
  id: number;
  name: string;
  type: CheckType;
  target: string;
  /** "hub" — проверяет хаб (снаружи); иначе id сервера, чей агент проверяет (изнутри) */
  runner: string;
  /** сервер, под которым показывать в дереве (null — корень «Внешние») */
  serverId: string | null;
  /** сервис, к которому привязана проверка (влияет на его статус) */
  serviceId: number | null;
  interval: number;
  timeout: number;
  expect: string | null;
  keyword: string | null;
  method: "GET" | "HEAD";
  insecure: boolean;
  /** сколько неудач подряд до статуса down */
  retries: number;
  enabled: boolean;
  status: Status;
  statusReason: string | null;
  statusSince: number;
  last: { t: number; ok: boolean; code: number | null; ms: number | null; err: string | null } | null;
  uptime24h: number | null;
  uptime30d: number | null;
  avgMs24h: number | null;
  certExpires: number | null;
  /** последние до 60 результатов, старые первыми: 1 ok, 0 fail */
  beats: (0 | 1)[];
}

export interface Overview {
  servers: ServerSummary[];
  /** только отслеживаемые (tracked) сервисы; ?all=1 — все */
  services: ServiceSummary[];
  checks: CheckSummary[];
  /** id → человекочитаемое имя группы не нужно: группа = строка */
  generatedAt: number;
  hubVersion: string;
}

// ---------- server detail / metrics ----------

export interface Thresholds {
  cpu: { pct: number; minutes: number };
  mem: { pct: number; minutes: number };
  disk: { pct: number };
  /** через сколько секунд без данных сервер считается offline */
  offlineSeconds: number;
}

export interface ServerDetail extends ServerSummary {
  filesystems: { mount: string; dev: string; fstype: string; used: number; total: number }[];
  /** эффективные пороги (дефолт + переопределения) */
  thresholds: Thresholds;
  /** переопределения порогов сервера (null — всё по умолчанию) */
  overrides: Partial<Thresholds> | null;
  agentKeyFingerprint: string | null;
  traffic: { rx24h: number; tx24h: number; rx30d: number; tx30d: number };
  /** активное предупреждение о порогах */
  alerts: { cpu: boolean; mem: boolean; disk: boolean };
  /** есть действующий токен регистрации */
  enrollPending: boolean;
  remoteAddr: string | null;
  connectedAt: number | null;
  /** RTT хаб↔агент, ms */
  rtt: number | null;
  /** заметки базы знаний, привязанные к серверу (или к его сервисам) */
  linkedNotes: NoteRef[];
}

export type MetricsRange = "1h" | "6h" | "24h" | "7d" | "30d" | "1y";
export const METRICS_RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d", "30d", "1y"];

export interface SeriesBase {
  range: MetricsRange;
  from: number;
  to: number;
  /** шаг точки, секунды */
  step: number;
  /** время точек, UNIX-секунды */
  t: number[];
}

export interface ServerMetrics extends SeriesBase {
  cpu: (number | null)[];
  cpuMax: (number | null)[];
  /** % памяти */
  mem: (number | null)[];
  memUsed: (number | null)[];
  swapUsed: (number | null)[];
  /** % корневой ФС */
  disk: (number | null)[];
  diskRead: (number | null)[];
  diskWrite: (number | null)[];
  netRx: (number | null)[];
  netTx: (number | null)[];
  load1: (number | null)[];
  ping: (number | null)[];
}

export interface ServiceMetrics extends SeriesBase {
  cpu: (number | null)[];
  cpuMax: (number | null)[];
  mem: (number | null)[];
  memMax: (number | null)[];
}

export interface CheckResults extends SeriesBase {
  /** средняя задержка, ms */
  ms: (number | null)[];
  /** доля успешных в точке 0..1 */
  up: (number | null)[];
}

export interface ServerCreateBody {
  /** slug: [a-z0-9-], 1..32 */
  id: string;
  name: string;
  description?: string | null;
}

export interface ServerPatchBody {
  name?: string;
  description?: string | null;
  sort?: number;
  /** null — сбросить переопределения */
  overrides?: Partial<Thresholds> | null;
}

export interface ServerEnrollment {
  serverId: string;
  /** одноразовый токен регистрации агента, показывается один раз */
  token: string;
  expiresAt: number;
  hubUrl: string;
  hubKey: string;
  hubKeyFingerprint: string;
  /** готовая команда для установки агента на сервере */
  installCommand: string;
}

// ---------- service detail ----------

export interface ServiceDetail extends ServiceSummary {
  description: string | null;
  /** сырое состояние источника */
  raw: string | null;
  enabled: string | null;
  vendor: boolean;
  result: string | null;
  exitCode: number | null;
  pid: number | null;
  tasks: number | null;
  commitAt: number | null;
  runtime: string | null;
  cwd: string | null;
  exec: string | null;
  image: string | null;
  health: string | null;
  logRate: number | null;
  notes: string | null;
  firstSeen: number;
  lastSeen: number;
  checkList: CheckSummary[];
  recentErrors: LogItem[];
  recentEvents: EventItem[];
  /** ошибок за 24ч по часам, старые первыми (24 значения) */
  errorsHourly: number[];
  /** заметки базы знаний, привязанные к сервису или его серверу */
  linkedNotes: NoteRef[];
}

export interface ServicePatchBody {
  displayName?: string | null;
  /** null — автогруппа (по префиксу имени, если таких сервисов на сервере ≥2); "" — без группы; иначе имя группы */
  group?: string | null;
  tracked?: boolean;
  muted?: boolean;
  sort?: number;
  notes?: string | null;
}

export interface LogItem {
  id: number;
  serviceId: number;
  ts: number;
  prio: number;
  msg: string;
}

// ---------- checks ----------

export interface CheckBody {
  name: string;
  type: CheckType;
  target: string;
  runner?: string;
  serverId?: string | null;
  serviceId?: number | null;
  interval?: number;
  timeout?: number;
  expect?: string | null;
  keyword?: string | null;
  method?: "GET" | "HEAD";
  insecure?: boolean;
  retries?: number;
  enabled?: boolean;
}

// ---------- events ----------

export type EventLevel = "info" | "ok" | "warn" | "error";

export interface EventItem {
  id: number;
  ts: number;
  level: EventLevel;
  /** server.offline, server.online, service.down, service.up, service.restart, check.down, check.up,
   *  alert.cpu, alert.mem, alert.disk, alert.clear, cert.expiring, agent.enrolled, config.* */
  type: string;
  serverId: string | null;
  serviceId: number | null;
  checkId: number | null;
  title: string;
  message: string | null;
  /** кто сделал (для config.*): user, token:<name>, system */
  actor: string | null;
}

// ---------- settings ----------

export interface NotifyEvents {
  serverOffline: boolean;
  serviceDown: boolean;
  serviceRestart: boolean;
  checkDown: boolean;
  thresholds: boolean;
  recovery: boolean;
  certExpiry: boolean;
  newService: boolean;
}

export interface Settings {
  publicUrl: string;
  /** секунды между снимками агентов */
  agentInterval: number;
  thresholds: Thresholds;
  /** через сколько секунд непрерывного down слать уведомление по сервису (антидребезг) */
  serviceDownDelay: number;
  notify: {
    telegram: {
      enabled: boolean;
      chatId: string;
      threadId: string | null;
      /** токен бота задан (сам токен API никогда не отдаёт) */
      botTokenSet: boolean;
    };
    events: NotifyEvents;
  };
  logPattern: string;
  pingTarget: string;
  retention: {
    rawHours: number;
    minuteDays: number;
    quarterDays: number;
    eventsDays: number;
    logsDays: number;
  };
  /** за сколько дней предупреждать об истечении TLS-сертификата */
  certWarnDays: number;
}

export interface SettingsPatch {
  publicUrl?: string;
  agentInterval?: number;
  thresholds?: Partial<Thresholds>;
  serviceDownDelay?: number;
  notify?: {
    telegram?: { enabled?: boolean; chatId?: string; threadId?: string | null; botToken?: string | null };
    events?: Partial<NotifyEvents>;
  };
  logPattern?: string;
  pingTarget?: string;
  retention?: Partial<Settings["retention"]>;
  certWarnDays?: number;
}

// ---------- security ----------

export type TokenScope = "read" | "admin";

export interface TokenItem {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: number;
  lastUsed: number | null;
  /** последние 4 символа секрета */
  hint: string;
}

export interface TokenCreated extends TokenItem {
  /** полный токен — показывается один раз */
  token: string;
}

export interface SessionItem {
  id: string;
  createdAt: number;
  lastSeen: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
  /** "password" | "passkey" */
  method: string;
}

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number | null;
  /** singleDevice | multiDevice */
  deviceType: string | null;
  backedUp: boolean;
}

// ---------- база знаний (заметки) ----------

/**
 * Заметка базы знаний — markdown-документ об инфраструктуре: где и как развёрнут проект, что на сервере,
 * процедуры. Читают люди и ИИ-агенты (MCP). Секреты в заметках запрещены — хаб отклоняет текст,
 * похожий на ключ/токен/пароль; в заметке пишут, где секрет лежит.
 * Ссылка на другую заметку в тексте — `[[id]]`.
 */
export type NoteKind = "server" | "project" | "runbook" | "reference";
export const NOTE_KINDS: NoteKind[] = ["server", "project", "runbook", "reference"];

export interface NoteRef {
  id: string;
  kind: NoteKind;
  title: string;
  summary: string;
}

export interface NoteSummary extends NoteRef {
  tags: string[];
  /** id серверов */
  servers: string[];
  /** сервисы: "<server>/<имя сервиса>" */
  services: string[];
  rev: number;
  updatedAt: number;
  updatedBy: string | null;
  /** размер текста, байты */
  size: number;
  /** при поиске: фрагмент с совпадением */
  snippet?: string;
  /** при поиске: релевантность (больше — лучше) */
  score?: number;
}

export interface Note extends NoteSummary {
  body: string;
  createdAt: number;
  /** true — это историческая версия (GET …/revisions/:rev), а не текущая */
  historic?: boolean;
}

export interface NoteCreateBody {
  /** [a-z0-9][a-z0-9._-]*, до 64 */
  id: string;
  kind: NoteKind;
  title: string;
  summary?: string;
  tags?: string[];
  servers?: string[];
  services?: string[];
  body: string;
}

export interface NoteEdit {
  /** фрагмент текущего текста; должен встречаться ровно один раз */
  old: string;
  /** замена ("" — удалить фрагмент) */
  new: string;
}

export interface NotePatchBody {
  /** ожидаемая текущая версия; не совпала — 409 conflict (кто-то изменил заметку раньше) */
  baseRev?: number;
  kind?: NoteKind;
  title?: string;
  summary?: string;
  tags?: string[];
  servers?: string[];
  services?: string[];
  /** новый текст целиком (взаимоисключающе с edits) */
  body?: string;
  /** точечные замены в тексте, применяются по порядку */
  edits?: NoteEdit[];
}

export interface NoteRevisionItem {
  rev: number;
  ts: number;
  actor: string | null;
  title: string;
  size: number;
  /** версия-отметка удаления */
  deleted: boolean;
}
