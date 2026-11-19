/**
 * Протокол агент ↔ хаб (поверх защищённого канала из secure.ts).
 *
 * Транспорт — WebSocket `GET /agent` на хабе. Первые два сообщения рукопожатия идут открытым JSON
 * (они не содержат секретов), всё остальное — зашифрованные бинарные кадры SecureChannel.
 *
 * Агент — только наблюдатель: хаб НЕ может заставить его выполнить команду. Конфиг от хаба
 * декларативный (интервал, HTTP/TCP-проверки, шаблон поиска ошибок в логах).
 */

export const PROTOCOL_VERSION = 1;
export const AGENT_VERSION = "1.0.1";

// ---------- рукопожатие (открытый текст) ----------

export interface Hs1 {
  t: "hs1";
  v: number;
  /** raw Ed25519 public key агента, base64url (32 байта) */
  agentKey: string;
  /** эфемерный X25519 public key, base64url */
  eph: string;
  /** 32 случайных байта, base64url */
  nonce: string;
}

export interface Hs2 {
  t: "hs2";
  eph: string;
  nonce: string;
  /** подпись хаба над транскриптом, base64url */
  sig: string;
}

/** Первый зашифрованный кадр агента. */
export interface AuthMsg {
  t: "auth";
  /** подпись агента над транскриптом, base64url */
  sig: string;
  /** id сервера (slug), под которым агент регистрируется/подключается */
  server: string;
  /** одноразовый токен регистрации — только при первом подключении */
  enroll?: string;
  agentVersion: string;
}

export interface AuthOk {
  t: "ok";
  server: string;
  /** true, если агент только что зарегистрирован этим подключением */
  enrolled: boolean;
}

// ---------- данные ----------

export interface HostInfo {
  hostname: string;
  /** PRETTY_NAME из /etc/os-release */
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memTotal: number;
  /** время загрузки, ms epoch */
  bootTime: number;
  /** пользователь, под которым работает агент */
  user: string;
  agentVersion: string;
  /** что агенту доступно на этом хосте */
  caps: {
    systemdUser: boolean;
    systemdSystem: boolean;
    journalSystem: boolean;
    journalUser: boolean;
    docker: boolean;
    pm2: boolean;
  };
}

export interface FsUsage {
  mount: string;
  dev: string;
  fstype: string;
  total: number;
  used: number;
}

export interface SysMetrics {
  /** % общей загрузки CPU, 0..100 */
  cpu: number;
  load: [number, number, number];
  mem: { total: number; used: number; available: number; cached: number };
  swap: { total: number; used: number };
  /** реальные файловые системы; первой идёт `/` */
  fs: FsUsage[];
  /** байт/с */
  disk: { read: number; write: number };
  /** байт/с и счётчики с момента загрузки (все интерфейсы кроме lo/виртуальных) */
  net: { rx: number; tx: number; rxTotal: number; txTotal: number };
  /** задержка TCP-connect до pingTarget, ms; null — недоступно */
  ping: number | null;
  /** секунды с загрузки */
  uptime: number;
  procs: number;
}

export type ServiceKind = "systemd" | "systemd-user" | "docker" | "pm2";

/**
 * Нормализованное состояние сервиса:
 * running — работает; exited — oneshot успешно отработал (RemainAfterExit или ждёт таймера);
 * starting/stopping/restarting — переходные; failed — упал; inactive — не запущен.
 */
export type ServiceState =
  | "running"
  | "exited"
  | "starting"
  | "stopping"
  | "restarting"
  | "failed"
  | "inactive";

export interface ServiceSample {
  /** уникальный в пределах сервера ключ: `${kind}:${name}` */
  key: string;
  kind: ServiceKind;
  /** systemd — имя юнита без `.service`; docker — имя контейнера; pm2 — имя процесса */
  name: string;
  description?: string;
  state: ServiceState;
  /** сырое состояние источника, например `active/running`, `Up 3 days (healthy)` */
  raw: string;
  /** systemd UnitFileState: enabled/disabled/static/…; docker — restart policy; pm2 — autorestart */
  enabled?: string;
  /** oneshot/по таймеру — задача, а не долгоживущий сервис */
  job?: boolean;
  /** true — юнит из /usr/lib (пакетный), false — свой (из /etc или ~/.config) */
  vendor?: boolean;
  /** ms epoch, когда сервис перешёл в текущее активное состояние (база для аптайма) */
  since?: number;
  /** ms epoch последнего завершения (для задач) */
  lastRun?: number;
  /** результат последнего запуска: success/exit-code/signal/oom-kill/… */
  result?: string;
  exitCode?: number;
  pid?: number;
  restarts?: number;
  /** % одного ядра за интервал */
  cpu?: number;
  /** байты RSS/cgroup memory.current */
  mem?: number;
  tasks?: number;
  ports?: number[];
  /** версия приложения (package.json / образ / пакет) */
  version?: string;
  /** git-коммит рабочей директории, короткий */
  commit?: string;
  /** ms epoch коммита */
  commitAt?: number;
  /** рантайм, например `bun 1.4.0`, `node 22.16.0` */
  runtime?: string;
  cwd?: string;
  exec?: string;
  image?: string;
  /** docker health: healthy/unhealthy/starting */
  health?: string;
  /** строк лога в минуту (по journal) */
  logRate?: number;
}

export interface LogLine {
  /** ключ сервиса (ServiceSample.key) */
  key: string;
  /** ms epoch */
  ts: number;
  /** syslog priority 0..7 */
  prio: number;
  msg: string;
}

export type CheckType = "http" | "tcp";

export interface CheckDef {
  id: number;
  type: CheckType;
  /** http(s)://… для http; host:port для tcp */
  target: string;
  /** секунды */
  interval: number;
  /** ms */
  timeout: number;
  /** допустимые коды, например `200-399` или `200,204` (только http) */
  expect?: string | null;
  /** подстрока, которая должна быть в теле ответа (только http) */
  keyword?: string | null;
  method?: "GET" | "HEAD";
  /** не проверять TLS-сертификат */
  insecure?: boolean;
}

export interface CheckResult {
  id: number;
  /** ms epoch */
  t: number;
  ok: boolean;
  code?: number;
  ms?: number;
  err?: string;
  /** ms epoch окончания TLS-сертификата (если https и удалось узнать) */
  certExpires?: number;
}

// ---------- сообщения ----------

export interface HelloMsg {
  t: "hello";
  info: HostInfo;
}

export interface SnapMsg {
  t: "snap";
  /** ms epoch на агенте */
  ts: number;
  /** фактический интервал с прошлого снимка, секунды */
  dt: number;
  m: SysMetrics;
  /** полный список сервисов на каждом снимке */
  svc: ServiceSample[];
  /** результаты проверок с прошлого снимка */
  chk: CheckResult[];
  /** новые строки-ошибки из journal с прошлого снимка (уже с лимитом) */
  logs: LogLine[];
  /** сколько ошибок отброшено лимитом, по ключу сервиса */
  dropped?: Record<string, number>;
}

export interface PongMsg {
  t: "pong";
  id: number;
}

export type AgentMsg = HelloMsg | SnapMsg | PongMsg;

export interface ConfigMsg {
  t: "config";
  /** секунды между снимками */
  interval: number;
  checks: CheckDef[];
  /** регэксп (флаги i) для поиска ошибок в строках лога; пусто — встроенный */
  logPattern: string;
  /** host:port для замера задержки «интернета» */
  pingTarget: string;
}

export interface PingMsg {
  t: "ping";
  id: number;
}

export interface ByeMsg {
  t: "bye";
  reason: string;
}

export type HubMsg = ConfigMsg | PingMsg | ByeMsg;

export const DEFAULT_LOG_PATTERN =
  String.raw`\b(error|exception|fatal|panic|critical|uncaught|unhandled|traceback|segfault)\b|\b[A-Z]\w*(Error|Exception)\b|\[(err|error|fatal)\]|level["'=:\s]+(error|fatal|critical)|Main process exited, code=(exited|killed|dumped)|Failed with result|out of memory|oom-kill`;

export const DEFAULT_PING_TARGET = "1.1.1.1:443";

/** Ограничения протокола (обе стороны) */
export const LIMITS = {
  /** максимальный размер одного кадра на проводе */
  maxFrame: 4 * 1024 * 1024,
  /** максимум строк-ошибок одного сервиса за снимок */
  logsPerServicePerSnap: 20,
  /** максимум строк-ошибок за снимок всего */
  logsPerSnap: 200,
  /** максимальная длина строки лога */
  logLineLen: 1000,
  /** максимум сервисов в снимке */
  services: 500,
  /** время на рукопожатие, ms */
  handshakeTimeout: 10_000,
} as const;
