import type { ApiError } from "@shared/api.ts";

export class ApiErr extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  onUnauthorized = fn;
}

const FRIENDLY: Record<string, string> = {
  rate_limited: "Слишком много попыток. Подождите немного и попробуйте снова.",
  unauthorized: "Требуется вход.",
  forbidden: "Недостаточно прав.",
  not_found: "Не найдено.",
  internal: "Внутренняя ошибка хаба.",
};

export async function api<T>(method: string, path: string, body?: unknown, opts?: { noAuthRedirect?: boolean }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiErr(0, "network", "Нет связи с хабом.");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  const data: unknown = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const e = (data && typeof data === "object" ? data : {}) as Partial<ApiError>;
    const code = e.code ?? (res.status === 429 ? "rate_limited" : res.status === 401 ? "unauthorized" : "error");
    if (res.status === 401 && !opts?.noAuthRedirect) onUnauthorized();
    throw new ApiErr(res.status, code, e.error ?? FRIENDLY[code] ?? `Ошибка ${res.status}`);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = <T>(path: string) => api<T>("DELETE", path);

export function errMsg(e: unknown): string {
  if (e instanceof ApiErr) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
