/**
 * Администрирование хаба с консоли сервера (БД общая с работающим хабом — WAL).
 *   bun run admin user:create <login> [--generate]     создать пользователя (пароль — stdin или --generate)
 *   bun run admin user:password <login> [--generate]   сменить пароль
 *   bun run admin token:create <name> [--scope read|admin]
 *   bun run admin token:list                           список API-токенов (без секретов)
 *   bun run admin token:revoke <id|name>               отозвать токен
 *   bun run admin server:add <id> [name]               сервер + токен регистрации агента
 *   bun run admin sessions:revoke                      завершить все сессии
 *   bun run admin hub:key                              публичный ключ хаба и отпечаток
 *   bun run admin notes:import <файл.md|каталог>… [--dry-run]   заметки из markdown с frontmatter (создать/обновить)
 *   bun run admin notes:export <каталог>               все заметки в <каталог>/<id>.md
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createToken, createUser, deleteToken, listTokens, setPassword, userByName, userCount } from "./auth/core.ts";
import { db } from "./db.ts";
import { hubFingerprint, hubPublicKey } from "./identity.ts";
import { getNote, listNotes, upsertNote } from "./notes.ts";
import { parseNoteFile, serializeNote } from "./notes-io.ts";
import { createServer } from "./servers.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--scope")));

async function readPassword(): Promise<{ password: string; generated: boolean }> {
  if (flag("--generate")) return { password: crypto.randomBytes(18).toString("base64url"), generated: true };
  if (process.stdin.isTTY) {
    process.stdout.write("Пароль (ввод виден; лучше передать через stdin или --generate): ");
  }
  const text = (await Bun.stdin.text()).split("\n")[0]!.trim();
  return { password: text, generated: false };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case "user:create": {
    const login = positional[0] ?? die("укажите логин");
    if (userCount() > 0 && !flag("--force")) die("пользователь уже есть (nodeko однопользовательский); --force, чтобы добавить ещё");
    const { password, generated } = await readPassword();
    const u = await createUser(login, password);
    console.log(`создан пользователь ${u.username}`);
    if (generated) console.log(`пароль: ${password}`);
    break;
  }
  case "user:password": {
    const login = positional[0] ?? die("укажите логин");
    const u = userByName(login) ?? die("нет такого пользователя");
    const { password, generated } = await readPassword();
    await setPassword(u.id, password);
    db.query("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    console.log("пароль изменён, все сессии завершены");
    if (generated) console.log(`пароль: ${password}`);
    break;
  }
  case "token:create": {
    const name = positional[0] ?? die("укажите имя токена");
    const scope = (opt("--scope") ?? "read") as "read" | "admin";
    const t = createToken(name, scope);
    console.log(t.token);
    break;
  }
  case "token:list": {
    for (const t of listTokens()) console.log(`${t.id}  ${t.scope.padEnd(5)}  ${t.name}`);
    break;
  }
  case "token:revoke": {
    const key = positional[0] ?? die("укажите id или имя токена");
    const found = listTokens().filter((t) => t.id === key || t.name === key);
    if (found.length === 0) die("токен не найден");
    if (found.length > 1) die(`имя неоднозначно, укажите id: ${found.map((t) => t.id).join(", ")}`);
    deleteToken(found[0]!.id);
    console.log(`отозван: ${found[0]!.id} ${found[0]!.name}`);
    break;
  }
  case "server:add": {
    const id = positional[0] ?? die("укажите id сервера");
    const e = createServer({ id, name: positional[1] ?? id }, "cli");
    console.log(JSON.stringify(e, null, 2));
    break;
  }
  case "sessions:revoke": {
    const n = db.query("DELETE FROM sessions").run().changes;
    console.log(`завершено сессий: ${n}`);
    break;
  }
  case "hub:key":
    console.log(`${hubPublicKey}\n${hubFingerprint}`);
    break;
  case "notes:import": {
    if (!positional.length) die("укажите файлы .md или каталоги");
    const files = positional.flatMap((p) =>
      fs.statSync(p).isDirectory()
        ? fs
            .readdirSync(p)
            .filter((f) => f.endsWith(".md") && !/^[A-Z]+\.md$/.test(f))
            .sort()
            .map((f) => path.join(p, f))
        : [p],
    );
    const dry = flag("--dry-run");
    let failed = 0;
    for (const f of files) {
      try {
        const body = parseNoteFile(fs.readFileSync(f, "utf8"), path.basename(f, ".md"));
        if (dry) {
          const cur = getNote(body.id);
          console.log(`${cur ? "обновить" : "создать "}  ${body.id}  (${f})`);
          continue;
        }
        const r = upsertNote(body, "cli");
        console.log(`${r.action.padEnd(9)}  ${r.note.id}  v${r.note.rev}`);
      } catch (e) {
        failed++;
        console.error(`ошибка    ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failed) die(`не импортировано: ${failed} из ${files.length}`);
    break;
  }
  case "notes:export": {
    const dir = positional[0] ?? die("укажите каталог");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const all = listNotes();
    for (const s of all) {
      const n = getNote(s.id)!;
      fs.writeFileSync(path.join(dir, `${n.id}.md`), serializeNote(n), { mode: 0o600 });
    }
    console.log(`выгружено заметок: ${all.length} → ${dir}`);
    break;
  }
  default:
    console.log("команды: user:create, user:password, token:create, token:list, token:revoke, server:add, sessions:revoke, hub:key, notes:import, notes:export");
    process.exit(cmd ? 1 : 0);
}
