/**
 * База знаний — чистая логика без БД: валидация, поиск, точечные правки, детектор секретов.
 * Общая для хаба, веба и мок-хаба.
 */
import { NOTE_KINDS, type NoteEdit, type NoteKind, type NoteSummary } from "./api.ts";

export const NOTE_LIMITS = {
  id: 64,
  title: 120,
  summary: 300,
  tag: 40,
  tags: 20,
  links: 100,
  /** байты UTF-8 */
  body: 256 * 1024,
  edits: 50,
} as const;

export const NOTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\-+#]*$/u;

export class NoteError extends Error {
  constructor(
    message: string,
    readonly code: "bad_request" | "not_found" | "conflict" = "bad_request",
  ) {
    super(message);
  }
}

export const isNoteKind = (v: unknown): v is NoteKind => typeof v === "string" && (NOTE_KINDS as string[]).includes(v);

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  server: "Серверы",
  project: "Проекты",
  runbook: "Процедуры",
  reference: "Справка",
};

export function checkNoteId(id: unknown): string {
  const v = typeof id === "string" ? id.trim() : "";
  if (!NOTE_ID_RE.test(v)) throw new NoteError("id: строчная латиница, цифры, «.», «_», «-», до 64 символов, с буквы или цифры");
  return v;
}

export function checkTitle(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s) throw new NoteError("title: пустой заголовок");
  if (s.length > NOTE_LIMITS.title) throw new NoteError(`title: длиннее ${NOTE_LIMITS.title} символов`);
  return s;
}

export function checkSummary(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new NoteError("summary: ожидается строка");
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length > NOTE_LIMITS.summary) throw new NoteError(`summary: длиннее ${NOTE_LIMITS.summary} символов`);
  return s;
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new NoteError(`${field}: ожидается массив строк`);
  return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
}

export function checkTags(v: unknown): string[] {
  const list = strList(v, "tags").map((t) => t.toLowerCase());
  if (list.length > NOTE_LIMITS.tags) throw new NoteError(`tags: не больше ${NOTE_LIMITS.tags}`);
  for (const t of list) {
    if (t.length > NOTE_LIMITS.tag || !TAG_RE.test(t)) throw new NoteError(`tags: недопустимый тег «${t.slice(0, 50)}»`);
  }
  return [...new Set(list)];
}

export function checkServers(v: unknown): string[] {
  const list = strList(v, "servers");
  if (list.length > NOTE_LIMITS.links) throw new NoteError(`servers: не больше ${NOTE_LIMITS.links}`);
  for (const s of list) if (!SERVER_ID_RE.test(s)) throw new NoteError(`servers: «${s.slice(0, 40)}» — не id сервера`);
  return list;
}

/** Ссылка на сервис: "<server>/<имя>" (имя — как в nodeko, без .service). */
export function normalizeServiceRef(ref: string): string {
  const i = ref.indexOf("/");
  if (i <= 0) throw new NoteError(`services: «${ref.slice(0, 60)}» — нужен формат <server>/<имя сервиса>`);
  const server = ref.slice(0, i).trim();
  const name = ref
    .slice(i + 1)
    .trim()
    .replace(/\.service$/, "");
  if (!SERVER_ID_RE.test(server)) throw new NoteError(`services: «${server.slice(0, 40)}» — не id сервера`);
  if (!name || name.length > 200 || /[\s\u0000-\u001f]/.test(name)) throw new NoteError(`services: недопустимое имя сервиса «${name.slice(0, 60)}»`);
  return `${server}/${name}`;
}

export function checkServices(v: unknown): string[] {
  const list = [...new Set(strList(v, "services").map(normalizeServiceRef))];
  if (list.length > NOTE_LIMITS.links) throw new NoteError(`services: не больше ${NOTE_LIMITS.links}`);
  return list;
}

export function checkBody(v: unknown): string {
  if (typeof v !== "string") throw new NoteError("body: ожидается строка (markdown)");
  const s = v.replace(/\r\n?/g, "\n");
  if (!s.trim()) throw new NoteError("body: пустой текст");
  if (new TextEncoder().encode(s).length > NOTE_LIMITS.body) throw new NoteError(`body: больше ${NOTE_LIMITS.body / 1024} КБ — разбейте на несколько заметок`);
  const secrets = findSecrets(s);
  if (secrets.length) {
    const s0 = secrets[0]!;
    throw new NoteError(
      `текст похож на секрет (${s0.kind}, строка ${s0.line}: «${s0.preview}»${secrets.length > 1 ? ` и ещё ${secrets.length - 1}` : ""}). ` +
        "Секреты в заметках запрещены — напишите, где секрет хранится (файл, менеджер паролей), а не его значение.",
    );
  }
  return s;
}

// ---------- точечные правки ----------

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Применить замены по порядку; каждый фрагмент обязан встречаться в текущем тексте ровно один раз. */
export function applyEdits(body: string, edits: NoteEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) throw new NoteError("edits: пустой список");
  if (edits.length > NOTE_LIMITS.edits) throw new NoteError(`edits: не больше ${NOTE_LIMITS.edits} за раз`);
  let out = body;
  edits.forEach((e, i) => {
    if (!e || typeof e.old !== "string" || typeof e.new !== "string") throw new NoteError(`edits[${i}]: нужны строки old и new`);
    const old = e.old.replace(/\r\n?/g, "\n");
    if (!old) throw new NoteError(`edits[${i}]: пустой old`);
    const n = countOccurrences(out, old);
    if (n === 0) throw new NoteError(`edits[${i}]: фрагмент не найден: «${short(old)}» — перечитайте заметку`);
    if (n > 1) throw new NoteError(`edits[${i}]: фрагмент встречается ${n} раз: «${short(old)}» — возьмите фрагмент длиннее`);
    out = out.replace(old, () => e.new.replace(/\r\n?/g, "\n"));
  });
  return out;
}

// ---------- детектор секретов ----------

export interface SecretHit {
  kind: string;
  line: number;
  /** замаскированное начало совпадения */
  preview: string;
}

const SECRET_PATTERNS: { kind: string; re: RegExp; value?: (m: RegExpExecArray) => string | null }[] = [
  { kind: "приватный ключ", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: "API-токен nodeko", re: /\bnk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}\b/g },
  { kind: "токен GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "ключ API (sk-…)", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "токен Slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "ключ AWS", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "ключ Google API", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "токен Telegram-бота", re: /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "токен Cloudflare Tunnel", re: /\beyJhIjoi[A-Za-z0-9+/=]{40,}/g },
  {
    kind: "пароль в URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{6,})@/gi,
    value: (m) => m[1] ?? null,
  },
  {
    kind: "пароль/токен в присваивании",
    re: /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|пароль)["'`]?\s*[:=]\s*["'`]?([^\s"'`,;)]{10,})/gi,
    value: (m) => m[1] ?? null,
  },
];

/** Похоже ли значение на настоящий секрет, а не на путь, плейсхолдер или имя. */
function looksRandom(v: string): boolean {
  if (/^[~/$<{(.]|^https?:|[<>{}*…]|\$\{|^\[/.test(v)) return false;
  if (v.includes("/")) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (/^[a-z]+(?:[-_.][a-z0-9]+)*$/.test(v) && !/[0-9]{3,}/.test(v)) return false;
  return true;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (p.value) {
        const v = p.value(m);
        if (!v || !looksRandom(v)) continue;
      }
      hits.push({ kind: p.kind, line: lineOf(text, m.index), preview: `${m[0].slice(0, 6)}…` });
      if (hits.length >= 20) return hits;
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

// ---------- поиск ----------

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

export function queryTerms(q: string): string[] {
  return [
    ...new Set(
      norm(q)
        .split(/[\s,;]+/)
        .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

export interface Searchable extends Omit<NoteSummary, "snippet" | "score"> {
  body: string;
}

function snippetOf(body: string, terms: string[]): string | undefined {
  const lower = norm(body);
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return undefined;
  const from = Math.max(0, at - 70);
  const to = Math.min(body.length, at + 130);
  return `${from > 0 ? "…" : ""}${body.slice(from, to).replace(/\s+/g, " ").trim()}${to < body.length ? "…" : ""}`;
}

/**
 * Поиск подстрокой без учёта регистра (ё = е); все слова запроса должны найтись хоть где-то.
 * Вес: id 6, заголовок 5, теги 4, сводка и привязки 3, текст 1 (+ частота, до 2).
 */
export function searchNotes<T extends Searchable>(notes: T[], q: string): (Omit<T, "body"> & { score: number; snippet?: string })[] {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const out: (Omit<T, "body"> & { score: number; snippet?: string })[] = [];
  for (const n of notes) {
    const fields: [string, number][] = [
      [norm(n.id), 6],
      [norm(n.title), 5],
      [norm(n.tags.join(" ")), 4],
      [norm(n.summary), 3],
      [norm([...n.servers, ...n.services].join(" ")), 3],
    ];
    const body = norm(n.body);
    let score = 0;
    let all = true;
    for (const t of terms) {
      let best = 0;
      for (const [f, w] of fields) if (w > best && f.includes(t)) best = w;
      const inBody = countOccurrences(body, t);
      if (!best && !inBody) {
        all = false;
        break;
      }
      score += best + (inBody ? 1 + Math.min(2, Math.log2(inBody)) : 0);
    }
    if (!all) continue;
    const { body: _b, ...rest } = n;
    out.push({ ...rest, score: Math.round(score * 10) / 10, snippet: snippetOf(n.body, terms) ?? (n.summary || undefined) });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Ссылки `[[id]]` из текста заметки. */
export function noteLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([a-z0-9][a-z0-9._-]{0,63})\]\]/g)) out.add(m[1]!);
  return [...out];
}
