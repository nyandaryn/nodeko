import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// БД хаба открывается при импорте — подменяем каталог данных до загрузки модулей.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeko-notes-test-"));
process.env.NODEKO_DATA = dir;
const notes = await import("./notes.ts");
const io = await import("./notes-io.ts");
const { db } = await import("./db.ts");

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  db.exec("DELETE FROM notes; DELETE FROM note_revisions;");
});

const base = {
  id: "shop",
  kind: "project" as const,
  title: "Shop — деплой",
  summary: "где живёт и как выкатывать",
  tags: ["Bun"],
  servers: ["atlas"],
  services: ["atlas/shop-api.service"],
  body: "# Shop\n\nКаталог `/home/deploy/shop`.\n",
};

describe("заметки в БД", () => {
  test("создание, чтение, поиск, привязки", () => {
    const n = notes.createNote(base, "user:test");
    expect(n.rev).toBe(1);
    expect(n.tags).toEqual(["bun"]);
    expect(n.services).toEqual(["atlas/shop-api"]);
    expect(notes.getNote("shop")?.body).toBe(base.body);
    expect(() => notes.createNote(base, "user:test")).toThrow(/уже есть/);
    expect(notes.listNotes({ q: "каталог deploy" }).map((x) => x.id)).toEqual(["shop"]);
    expect(notes.listNotes({ server: "atlas" }).map((x) => x.id)).toEqual(["shop"]);
    expect(notes.listNotes({ service: "atlas/SHOP-API" }).map((x) => x.id)).toEqual(["shop"]);
    expect(notes.notesForService("atlas", "shop-api.service").map((x) => x.id)).toEqual(["shop"]);
    expect(notes.notesForServer("vega")).toEqual([]);
  });

  test("правки: baseRev, edits, без изменений — без версии", () => {
    const n = notes.patchNote("shop", { baseRev: 1, edits: [{ old: "/home/deploy/shop", new: "/srv/shop" }] }, "token:agent");
    expect(n.rev).toBe(2);
    expect(n.body).toContain("/srv/shop");
    expect(n.updatedBy).toBe("token:agent");
    expect(() => notes.patchNote("shop", { baseRev: 1, title: "x" }, "token:agent")).toThrow(/уже изменили/);
    expect(notes.patchNote("shop", { baseRev: 2, title: base.title }, "token:agent").rev).toBe(2);
    expect(() => notes.patchNote("shop", { body: "PASSWORD=Zx81kd02mfq1" }, "token:agent")).toThrow(/секрет/);
    expect(() => notes.patchNote("shop", { body: "x", edits: [] }, "a")).toThrow(/взаимоисключающи/);
  });

  test("история и удаление", () => {
    expect(notes.listRevisions("shop").map((r) => r.rev)).toEqual([2, 1]);
    expect(notes.getRevision("shop", 1).body).toContain("/home/deploy/shop");
    expect(() => notes.deleteNote("shop", "user:test", 1)).toThrow(/уже изменили/);
    notes.deleteNote("shop", "user:test", 2);
    expect(notes.getNote("shop")).toBeNull();
    const h = notes.listRevisions("shop");
    expect(h[0]).toMatchObject({ rev: 3, deleted: true });
    expect(() => notes.getRevision("shop", 3)).toThrow(/отметка удаления/);
    // пересоздание продолжает нумерацию
    expect(notes.createNote(base, "user:test").rev).toBe(4);
    const types = (db.query("SELECT type FROM events WHERE type LIKE 'note.%' ORDER BY id").all() as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(["note.created", "note.updated", "note.deleted", "note.created"]);
  });

  test("upsert и формат файла туда-обратно", () => {
    const n = notes.getNote("shop")!;
    const text = io.serializeNote(n);
    const parsed = io.parseNoteFile(text);
    expect(parsed).toMatchObject({ id: "shop", kind: "project", title: n.title, tags: n.tags, servers: n.servers, services: n.services, body: n.body });
    expect(notes.upsertNote(parsed, "cli").action).toBe("unchanged");
    expect(notes.upsertNote({ ...parsed, summary: "новая" }, "cli").action).toBe("updated");
    expect(notes.upsertNote({ ...parsed, id: "fresh" }, "cli").action).toBe("created");
    expect(() => io.parseNoteFile("# без frontmatter")).toThrow(/frontmatter/);
    expect(io.parseNoteFile('---\nkind: runbook\ntitle: "a: b"\n---\ntext', "from-name")).toMatchObject({ id: "from-name", title: "a: b", body: "text" });
  });
});
