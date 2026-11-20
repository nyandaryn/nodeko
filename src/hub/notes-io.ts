import type { Note, NoteCreateBody } from "../shared/api.ts";
import { isNoteKind, NoteError } from "../shared/notes.ts";

/**
 * Заметка ⇄ markdown-файл с YAML-frontmatter (импорт/экспорт CLI, правка в редакторе):
 *
 *   ---
 *   id: shop
 *   kind: project
 *   title: "Shop — деплой"
 *   summary: "…"
 *   tags: ["bun"]
 *   servers: ["atlas"]
 *   services: ["atlas/shop-api"]
 *   ---
 *   # текст
 *
 * id по умолчанию — имя файла без .md.
 */

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseNoteFile(text: string, fallbackId?: string): NoteCreateBody {
  const m = FM.exec(text);
  if (!m) throw new NoteError("нет frontmatter (--- … ---) в начале файла");
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(m[1]!);
  } catch (e) {
    throw new NoteError(`frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new NoteError("frontmatter: ожидается объект");
  const f = meta as Record<string, unknown>;
  const list = (k: string) => {
    const v = f[k];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw new NoteError(`frontmatter.${k}: ожидается список`);
    return v.map(String);
  };
  const id = f.id ?? fallbackId;
  if (typeof id !== "string") throw new NoteError("frontmatter.id: не задан");
  if (!isNoteKind(f.kind)) throw new NoteError("frontmatter.kind: server|project|runbook|reference");
  return {
    id,
    kind: f.kind,
    title: String(f.title ?? ""),
    summary: f.summary === undefined || f.summary === null ? undefined : String(f.summary),
    tags: list("tags"),
    servers: list("servers"),
    services: list("services"),
    body: text.slice(m[0].length).replace(/^\s*\n/, ""),
  };
}

/** JSON-строки и массивы — валидный YAML, так что сериализация не зависит от YAML-писателя. */
export function serializeNote(n: Pick<Note, "id" | "kind" | "title" | "summary" | "tags" | "servers" | "services" | "body">): string {
  const lines = [
    "---",
    `id: ${n.id}`,
    `kind: ${n.kind}`,
    `title: ${JSON.stringify(n.title)}`,
    `summary: ${JSON.stringify(n.summary)}`,
    `tags: ${JSON.stringify(n.tags)}`,
    `servers: ${JSON.stringify(n.servers)}`,
    `services: ${JSON.stringify(n.services)}`,
    "---",
    "",
  ];
  return lines.join("\n") + (n.body.endsWith("\n") ? n.body : `${n.body}\n`);
}
