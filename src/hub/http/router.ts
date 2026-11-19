import type { TokenScope } from "../../shared/api.ts";
import type { SessionRow, UserRow } from "../auth/core.ts";

export type Auth =
  | { kind: "session"; session: SessionRow; user: UserRow }
  | { kind: "token"; token: { id: string; name: string; scope: TokenScope } }
  | null;

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  auth: Auth;
  /** для журнала изменений: user:<login> | token:<имя> */
  actor: string;
  /** заголовки, которые нужно добавить к ответу (Set-Cookie) */
  headers: Headers;
  json<T = any>(): Promise<T>;
}

/** public — без входа; read — сессия или любой токен; admin — сессия или токен admin. */
export type Access = "public" | "read" | "admin" | "session";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extraHeaders?: Record<string, string>,
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, "bad_request", msg);
export const notFound = (msg = "не найдено") => new HttpError(404, "not_found", msg);

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  access: Access;
  handler: (c: Ctx) => unknown;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, access: Access, handler: (c: Ctx) => unknown): this {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        path.replace(/\/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return "/([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, re, keys, access, handler });
    return this;
  }

  get = (p: string, a: Access, h: (c: Ctx) => unknown) => this.add("GET", p, a, h);
  post = (p: string, a: Access, h: (c: Ctx) => unknown) => this.add("POST", p, a, h);
  patch = (p: string, a: Access, h: (c: Ctx) => unknown) => this.add("PATCH", p, a, h);
  del = (p: string, a: Access, h: (c: Ctx) => unknown) => this.add("DELETE", p, a, h);

  match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
    return pathMatched ? "method" : null;
  }
}
