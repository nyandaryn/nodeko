import type { Note, NoteCreateBody, NoteKind, NotePatchBody, NoteRef, NoteRevisionItem, NoteSummary } from "../shared/api.ts";
import { NOTE_KINDS } from "../shared/api.ts";
import {
  applyEdits,
  checkBody,
  checkNoteId,
  checkServers,
  checkServices,
  checkSummary,
  checkTags,
  checkTitle,
  isNoteKind,
  NoteError,
  searchNotes,
} from "../shared/notes.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";

/**
 * База знаний: markdown-заметки об инфраструктуре (проекты, серверы, процедуры) с историей версий.
 * Каждое изменение — новая версия в note_revisions (удаление — версия-отметка), так что любую правку
 * можно посмотреть и откатить. Секреты отсекает checkBody (детектор в shared/notes.ts).
 */

export { NoteError };

interface NoteRow {
  id: string;
  kind: NoteKind;
  title: string;
  summary: string;
  tags_json: string;
  servers_json: string;
  services_json: string;
  body: string;
  rev: number;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
}

interface RevisionRow {
  note_id: string;
  rev: number;
  ts: number;
  actor: string | null;
  deleted: number;
  kind: NoteKind;
  title: string;
  summary: string;
  tags_json: string;
  servers_json: string;
  services_json: string;
  body: string;
}

/** Сколько версий хранить на заметку (старые удаляются при записи). */
const KEEP_REVISIONS = 200;

const arr = (s: string) => parseJson<string[]>(s) ?? [];
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function toNote(r: NoteRow): Note {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    tags: arr(r.tags_json),
    servers: arr(r.servers_json),
    services: arr(r.services_json),
    rev: r.rev,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    size: bytes(r.body),
    body: r.body,
    createdAt: r.created_at,
  };
}

function toSummary(n: Note): NoteSummary {
  const { body: _b, createdAt: _c, ...rest } = n;
  return rest;
}

export const toRef = (n: Pick<Note, "id" | "kind" | "title" | "summary">): NoteRef => ({ id: n.id, kind: n.kind, title: n.title, summary: n.summary });

function allNotes(): Note[] {
  return (db.query("SELECT * FROM notes").all() as NoteRow[]).map(toNote);
}

const kindOrder = (k: NoteKind) => NOTE_KINDS.indexOf(k);
const byKindId = (a: NoteSummary, b: NoteSummary) => kindOrder(a.kind) - kindOrder(b.kind) || a.id.localeCompare(b.id);

const serviceRefKey = (server: string, name: string) => `${server}/${name.toLowerCase().replace(/\.service$/, "")}`;

export interface NoteFilter {
  q?: string;
  kind?: string;
  tag?: string;
  /** привязана к серверу напрямую или через его сервисы */
  server?: string;
  /** "<server>/<имя>" */
  service?: string;
}

export function listNotes(f: NoteFilter = {}): NoteSummary[] {
  let notes = allNotes();
  if (f.kind) {
    if (!isNoteKind(f.kind)) throw new NoteError(`kind: ${NOTE_KINDS.join("|")}`);
    notes = notes.filter((n) => n.kind === f.kind);
  }
  if (f.tag) {
    const t = f.tag.trim().toLowerCase();
    notes = notes.filter((n) => n.tags.includes(t));
  }
  if (f.server) {
    const s = f.server.trim();
    notes = notes.filter((n) => n.servers.includes(s) || n.services.some((x) => x.startsWith(`${s}/`)));
  }
  if (f.service) {
    const i = f.service.indexOf("/");
    if (i <= 0) throw new NoteError("service: формат <server>/<имя>");
    const key = serviceRefKey(f.service.slice(0, i), f.service.slice(i + 1));
    notes = notes.filter((n) => n.services.some((x) => x.toLowerCase() === key));
  }
  if (f.q?.trim()) return searchNotes(notes, f.q);
  return notes.map(toSummary).sort(byKindId);
}

export function getNote(id: string): Note | null {
  const r = db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null;
  return r ? toNote(r) : null;
}

export function noteIndex(): { id: string; kind: NoteKind; title: string }[] {
  return (db.query("SELECT id, kind, title FROM notes ORDER BY id").all() as { id: string; kind: NoteKind; title: string }[]).sort(
    (a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.id.localeCompare(b.id),
  );
}

/** Заметки, привязанные к серверу напрямую или через его сервисы. */
export function notesForServer(serverId: string): NoteRef[] {
  return allNotes()
    .filter((n) => n.servers.includes(serverId) || n.services.some((x) => x.startsWith(`${serverId}/`)))
    .sort(byKindId)
    .map(toRef);
}

/** Заметки сервиса: привязанные к нему самому, затем заметки его сервера с kind=server. */
export function notesForService(serverId: string, name: string, displayName?: string | null): NoteRef[] {
  const keys = new Set([serviceRefKey(serverId, name)]);
  if (displayName) keys.add(serviceRefKey(serverId, displayName));
  const all = allNotes();
  const own = all.filter((n) => n.services.some((x) => keys.has(x.toLowerCase()))).sort(byKindId);
  const srv = all.filter((n) => n.kind === "server" && n.servers.includes(serverId) && !own.includes(n)).sort(byKindId);
  return [...own, ...srv].map(toRef);
}

// ---------- версии ----------

const insRevision = db.query(
  `INSERT INTO note_revisions(note_id, rev, ts, actor, deleted, kind, title, summary, tags_json, servers_json, services_json, body)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function lastRev(id: string): number {
  const r = db.query("SELECT max(rev) AS rev FROM note_revisions WHERE note_id = ?").get(id) as { rev: number | null };
  return r.rev ?? 0;
}

function saveRevision(r: NoteRow, actor: string | null, deleted = false): void {
  insRevision.run(r.id, r.rev, r.updated_at, actor, deleted ? 1 : 0, r.kind, r.title, r.summary, r.tags_json, r.servers_json, r.services_json, deleted ? "" : r.body);
  db.query("DELETE FROM note_revisions WHERE note_id = ? AND rev <= ?").run(r.id, r.rev - KEEP_REVISIONS);
}

export function listRevisions(id: string): NoteRevisionItem[] {
  const rows = db
    .query("SELECT rev, ts, actor, deleted, title, length(CAST(body AS BLOB)) AS size FROM note_revisions WHERE note_id = ? ORDER BY rev DESC")
    .all(id) as { rev: number; ts: number; actor: string | null; deleted: number; title: string; size: number }[];
  if (!rows.length) throw new NoteError("нет такой заметки", "not_found");
  return rows.map((r) => ({ rev: r.rev, ts: r.ts, actor: r.actor, title: r.title, size: r.size, deleted: !!r.deleted }));
}

export function getRevision(id: string, rev: number): Note {
  const r = db.query("SELECT * FROM note_revisions WHERE note_id = ? AND rev = ?").get(id, rev) as RevisionRow | null;
  if (!r) throw new NoteError(`нет версии ${rev} у заметки ${id}`, "not_found");
  if (r.deleted) throw new NoteError(`версия ${rev} — отметка удаления; содержимое — в версии ${rev - 1}`, "not_found");
  const first = db.query("SELECT min(ts) AS ts FROM note_revisions WHERE note_id = ?").get(id) as { ts: number };
  return {
    ...toNote({ ...r, id: r.note_id, created_at: first.ts, updated_at: r.ts, updated_by: r.actor }),
    historic: true,
  };
}

// ---------- изменения ----------

function event(kind: "created" | "updated" | "deleted", n: { id: string; title: string; rev: number }, actor: string): void {
  const verb = kind === "created" ? "создана" : kind === "updated" ? "изменена" : "удалена";
  addEvent({ level: "info", type: `note.${kind}`, title: `Заметка «${n.title}» ${verb}`, message: `${n.id}, версия ${n.rev}`, actor });
}

const insNote = db.query(
  `INSERT INTO notes(id, kind, title, summary, tags_json, servers_json, services_json, body, rev, created_at, updated_at, updated_by)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function createNote(body: NoteCreateBody, actor: string): Note {
  if (!body || typeof body !== "object") throw new NoteError("ожидается объект заметки");
  const id = checkNoteId(body.id);
  if (!isNoteKind(body.kind)) throw new NoteError(`kind: ${NOTE_KINDS.join("|")}`);
  const now = Date.now();
  const row: NoteRow = {
    id,
    kind: body.kind,
    title: checkTitle(body.title),
    summary: checkSummary(body.summary),
    tags_json: JSON.stringify(checkTags(body.tags)),
    servers_json: JSON.stringify(checkServers(body.servers)),
    services_json: JSON.stringify(checkServices(body.services)),
    body: checkBody(body.body),
    rev: 0,
    created_at: now,
    updated_at: now,
    updated_by: actor,
  };
  db.transaction(() => {
    if (getNote(id)) throw new NoteError(`заметка ${id} уже есть — измените её (PATCH / nodeko_write_note с baseRev)`, "conflict");
    row.rev = lastRev(id) + 1; // после удаления нумерация продолжается
    insNote.run(row.id, row.kind, row.title, row.summary, row.tags_json, row.servers_json, row.services_json, row.body, row.rev, row.created_at, row.updated_at, row.updated_by);
    saveRevision(row, actor);
  })();
  event("created", row, actor);
  return toNote(row);
}

function checkBase(cur: NoteRow, baseRev: unknown): void {
  if (baseRev === undefined || baseRev === null) return;
  if (typeof baseRev !== "number" || !Number.isInteger(baseRev)) throw new NoteError("baseRev: целое число");
  if (baseRev !== cur.rev)
    throw new NoteError(
      `заметку ${cur.id} уже изменили: текущая версия ${cur.rev} (${cur.updated_by ?? "?"}), а правка сделана от ${baseRev} — перечитайте и повторите`,
      "conflict",
    );
}

/** Изменить заметку. Ничего не изменилось — версия не создаётся. */
export function patchNote(id: string, body: NotePatchBody, actor: string): Note {
  if (!body || typeof body !== "object") throw new NoteError("ожидается объект изменений");
  if (body.body !== undefined && body.edits !== undefined) throw new NoteError("body и edits взаимоисключающи");
  let out: NoteRow | null = null;
  let changed = false;
  db.transaction(() => {
    const cur = db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null;
    if (!cur) throw new NoteError("нет такой заметки", "not_found");
    checkBase(cur, body.baseRev);
    const next: NoteRow = { ...cur };
    if (body.kind !== undefined) {
      if (!isNoteKind(body.kind)) throw new NoteError(`kind: ${NOTE_KINDS.join("|")}`);
      next.kind = body.kind;
    }
    if (body.title !== undefined) next.title = checkTitle(body.title);
    if (body.summary !== undefined) next.summary = checkSummary(body.summary);
    if (body.tags !== undefined) next.tags_json = JSON.stringify(checkTags(body.tags));
    if (body.servers !== undefined) next.servers_json = JSON.stringify(checkServers(body.servers));
    if (body.services !== undefined) next.services_json = JSON.stringify(checkServices(body.services));
    if (body.body !== undefined) next.body = checkBody(body.body);
    if (body.edits !== undefined) next.body = checkBody(applyEdits(cur.body, body.edits));
    changed = (["kind", "title", "summary", "tags_json", "servers_json", "services_json", "body"] as const).some((k) => next[k] !== cur[k]);
    if (!changed) {
      out = cur;
      return;
    }
    next.rev = cur.rev + 1;
    next.updated_at = Date.now();
    next.updated_by = actor;
    db.query(
      `UPDATE notes SET kind = ?, title = ?, summary = ?, tags_json = ?, servers_json = ?, services_json = ?, body = ?, rev = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(next.kind, next.title, next.summary, next.tags_json, next.servers_json, next.services_json, next.body, next.rev, next.updated_at, next.updated_by, id);
    saveRevision(next, actor);
    out = next;
  })();
  const row = out as NoteRow | null;
  if (!row) throw new NoteError("нет такой заметки", "not_found");
  if (changed) event("updated", row, actor);
  return toNote(row);
}

/** Удалить заметку; история остаётся (последняя версия + отметка удаления). */
export function deleteNote(id: string, actor: string, baseRev?: number): void {
  let gone: NoteRow | null = null;
  db.transaction(() => {
    const cur = db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null;
    if (!cur) throw new NoteError("нет такой заметки", "not_found");
    checkBase(cur, baseRev);
    const mark: NoteRow = { ...cur, rev: cur.rev + 1, updated_at: Date.now(), updated_by: actor };
    saveRevision(mark, actor, true);
    db.query("DELETE FROM notes WHERE id = ?").run(id);
    gone = mark;
  })();
  if (gone) event("deleted", gone, actor);
}

/** Создать или обновить целиком (импорт): без изменений — ничего не пишет. */
export function upsertNote(body: NoteCreateBody, actor: string): { note: Note; action: "created" | "updated" | "unchanged" } {
  const id = checkNoteId(body.id);
  const cur = getNote(id);
  if (!cur) return { note: createNote(body, actor), action: "created" };
  const note = patchNote(
    id,
    {
      kind: body.kind,
      title: body.title,
      summary: body.summary ?? "",
      tags: body.tags ?? [],
      servers: body.servers ?? [],
      services: body.services ?? [],
      body: body.body,
    },
    actor,
  );
  return { note, action: note.rev === cur.rev ? "unchanged" : "updated" };
}
