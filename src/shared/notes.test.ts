import { describe, expect, test } from "bun:test";
import { applyEdits, checkBody, checkServices, checkTags, findSecrets, noteLinks, queryTerms, searchNotes, type Searchable } from "./notes.ts";

describe("findSecrets", () => {
  const hit = (s: string) => findSecrets(s).map((h) => h.kind);

  test("ловит явные секреты", () => {
    expect(hit("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toEqual(["приватный ключ"]);
    expect(hit(`token: nk_0123456789ab_${"A".repeat(43)}`)).toContain("API-токен nodeko");
    expect(hit(`ghp_${"a1".repeat(18)}`)).toEqual(["токен GitHub"]);
    expect(hit(`ANTHROPIC_API_KEY=sk-ant-${"x9".repeat(15)}`)).toContain("ключ API (sk-…)");
    expect(hit(`bot 123456789:${"A".repeat(35)}`)).toEqual(["токен Telegram-бота"]);
    expect(hit("DATABASE_URL=postgres://app:s3cretPassw0rd@db.example.com/app")).toContain("пароль в URL");
    expect(hit("BOT_TOKEN=Xk29dk2mdk29fkq")).toEqual(["пароль/токен в присваивании"]);
    expect(hit("пароль: Hq8sLm2pZx01")).toEqual(["пароль/токен в присваивании"]);
  });

  test("не трогает пути, плейсхолдеры и обычный текст", () => {
    for (const s of [
      "Пароль админа: `~/.config/app/admin-password`",
      "token:create <имя> --scope admin",
      "password: <пароль из менеджера>",
      "TOKEN=${SECRET_FROM_ENV}",
      "postgres://app:<password>@db.example.com/app",
      "api_key: см. /etc/app/key",
      "secret_hash BLOB NOT NULL",
      "версия 1.4.0+34cbb9a40, коммит d229f21",
      "token: admin-password-file",
      "| Порт | `127.0.0.1:4170` |",
    ])
      expect(hit(s)).toEqual([]);
  });

  test("checkBody отклоняет секрет с номером строки", () => {
    expect(() => checkBody("# x\n\nkey: \nPASSWORD=Zx81kd02mfq1")).toThrow(/строка 4/);
    expect(checkBody("a\r\nb")).toBe("a\nb");
  });
});

describe("applyEdits", () => {
  test("заменяет фрагменты по порядку", () => {
    expect(applyEdits("a b c", [{ old: "b", new: "B" }, { old: "B c", new: "x" }])).toBe("a x");
  });
  test("не найден / неоднозначен", () => {
    expect(() => applyEdits("a b", [{ old: "z", new: "" }])).toThrow(/не найден/);
    expect(() => applyEdits("a a", [{ old: "a", new: "b" }])).toThrow(/2 раз/);
    expect(() => applyEdits("a", [])).toThrow(/пустой/);
  });
  test("спецсимволы замены не интерпретируются", () => {
    expect(applyEdits("x", [{ old: "x", new: "$& $1" }])).toBe("$& $1");
  });
});

describe("валидация", () => {
  test("services нормализуются", () => {
    expect(checkServices(["atlas/shop-api.service", "atlas/shop-api", " atlas/web "])).toEqual(["atlas/shop-api", "atlas/web"]);
    expect(() => checkServices(["shop-api"])).toThrow(/формат/);
  });
  test("tags — в нижнем регистре, без дублей", () => {
    expect(checkTags(["Bun", "bun", "deploy"])).toEqual(["bun", "deploy"]);
    expect(() => checkTags(["<b>"])).toThrow();
  });
});

describe("поиск", () => {
  const n = (id: string, title: string, body: string, extra: Partial<Searchable> = {}): Searchable => ({
    id,
    kind: "project",
    title,
    summary: "",
    tags: [],
    servers: [],
    services: [],
    rev: 1,
    updatedAt: 0,
    updatedBy: null,
    size: body.length,
    body,
    ...extra,
  });
  const notes = [
    n("shop", "Shop — деплой", "Выкатка: `deploy.sh`. Откат — предыдущий релиз."),
    n("atlas", "Сервер atlas", "Caddy, systemd user. Ёлка.", { kind: "server", services: ["atlas/shop-api"] }),
    n("bun", "Bun — обновление", "Откат версии: установить нужную через install-скрипт."),
  ];

  test("все слова обязаны найтись; заголовок весомее текста", () => {
    expect(searchNotes(notes, "откат").map((r) => r.id)).toEqual(["bun", "shop"]);
    expect(searchNotes(notes, "откат деплой").map((r) => r.id)).toEqual(["shop"]);
    expect(searchNotes(notes, "shop-api").map((r) => r.id)).toEqual(["atlas"]);
  });
  test("ё = е, регистр не важен, есть сниппет", () => {
    const r = searchNotes(notes, "ЕЛКА");
    expect(r.map((x) => x.id)).toEqual(["atlas"]);
    expect(r[0]!.snippet).toContain("Ёлка");
    expect(r[0]).not.toHaveProperty("body");
  });
  test("пустой запрос", () => {
    expect(queryTerms("  , ; ")).toEqual([]);
    expect(searchNotes(notes, "")).toEqual([]);
  });
});

test("noteLinks", () => {
  expect(noteLinks("см. [[shop]] и [[atlas]], [[shop]]; [[Bad]]")).toEqual(["shop", "atlas"]);
});
