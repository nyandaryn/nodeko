/** localStorage, который не падает в приватном режиме/при блокировке. */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`nodeko:${key}`);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`nodeko:${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
