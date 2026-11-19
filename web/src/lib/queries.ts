import type {
  AuthState,
  CheckResults,
  CheckSummary,
  EventItem,
  LogItem,
  MetricsRange,
  Overview,
  PasskeyItem,
  ServerDetail,
  ServerMetrics,
  ServiceDetail,
  ServiceMetrics,
  SessionItem,
  Settings,
  TokenItem,
} from "@shared/api.ts";
import { keepPreviousData, useInfiniteQuery, useQuery, QueryCache, QueryClient } from "@tanstack/react-query";
import { api, ApiErr, errMsg, get } from "./api.ts";
import { toast } from "./toast.tsx";

export const queryClient = new QueryClient({
  // данные так и не загрузились — сказать об этом, а не держать скелетон вечно (401 уводит на вход сам)
  queryCache: new QueryCache({
    onError: (e, q) => {
      if (q.state.data !== undefined || q.queryKey[0] === "auth") return;
      if (e instanceof ApiErr && e.status === 401) return;
      toast(`Не удалось загрузить: ${errMsg(e)}`, "error");
    },
  }),
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiErr && (e.status === 401 || e.status === 403 || e.status === 404)) && n < 2,
      refetchOnWindowFocus: true,
      staleTime: 2_000,
    },
  },
});

export const qk = {
  auth: ["auth"] as const,
  overview: (all = false) => ["overview", all] as const,
  server: (id: string) => ["server", id] as const,
  serverMetrics: (id: string, r: MetricsRange) => ["server", id, "metrics", r] as const,
  service: (id: number) => ["service", id] as const,
  serviceMetrics: (id: number, r: MetricsRange) => ["service", id, "metrics", r] as const,
  serviceLogs: (id: number) => ["service", id, "logs"] as const,
  checks: ["checks"] as const,
  checkResults: (id: number, r: MetricsRange) => ["check", id, "results", r] as const,
  events: (f: EventFilter) => ["events", f] as const,
  settings: ["settings"] as const,
  tokens: ["tokens"] as const,
  sessions: ["sessions"] as const,
  passkeys: ["passkeys"] as const,
};

export const useAuth = () =>
  useQuery({
    queryKey: qk.auth,
    queryFn: () => api<AuthState>("GET", "/api/auth/state", undefined, { noAuthRedirect: true }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

export const useOverview = (all = false) =>
  useQuery({ queryKey: qk.overview(all), queryFn: () => get<Overview>(`/api/v1/overview${all ? "?all=1" : ""}`), refetchInterval: 5_000 });

export const useServer = (id: string | undefined) =>
  useQuery({
    queryKey: qk.server(id ?? ""),
    queryFn: () => get<ServerDetail>(`/api/v1/servers/${encodeURIComponent(id!)}`),
    enabled: !!id,
    refetchInterval: 10_000,
  });

export const useServerMetrics = (id: string, range: MetricsRange) =>
  useQuery({
    queryKey: qk.serverMetrics(id, range),
    queryFn: () => get<ServerMetrics>(`/api/v1/servers/${encodeURIComponent(id)}/metrics?range=${range}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

export const useService = (id: number | undefined) =>
  useQuery({
    queryKey: qk.service(id ?? -1),
    queryFn: () => get<ServiceDetail>(`/api/v1/services/${id}`),
    enabled: id != null && Number.isFinite(id),
    refetchInterval: 10_000,
  });

export const useServiceMetrics = (id: number, range: MetricsRange) =>
  useQuery({
    queryKey: qk.serviceMetrics(id, range),
    queryFn: () => get<ServiceMetrics>(`/api/v1/services/${id}/metrics?range=${range}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

export const useServiceLogs = (id: number) =>
  useInfiniteQuery({
    queryKey: qk.serviceLogs(id),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<LogItem[]>(`/api/v1/services/${id}/logs?limit=50${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.length < 50 ? undefined : last[last.length - 1]!.id),
    refetchInterval: 15_000,
  });

export const useChecks = () => useQuery({ queryKey: qk.checks, queryFn: () => get<CheckSummary[]>("/api/v1/checks"), refetchInterval: 10_000 });

export const useCheckResults = (id: number, range: MetricsRange) =>
  useQuery({
    queryKey: qk.checkResults(id, range),
    queryFn: () => get<CheckResults>(`/api/v1/checks/${id}/results?range=${range}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

export interface EventFilter {
  level?: string;
  server?: string;
  service?: number;
  check?: number;
}

export const useEvents = (f: EventFilter, pageSize = 50) =>
  useInfiniteQuery({
    queryKey: qk.events(f),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(pageSize) });
      if (pageParam) p.set("before", String(pageParam));
      if (f.level) p.set("level", f.level);
      if (f.server) p.set("server", f.server);
      if (f.service != null) p.set("service", String(f.service));
      if (f.check != null) p.set("check", String(f.check));
      return get<EventItem[]>(`/api/v1/events?${p}`);
    },
    getNextPageParam: (last) => (last.length < pageSize ? undefined : last[last.length - 1]!.id),
    refetchInterval: 10_000,
  });

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => get<Settings>("/api/v1/settings") });
export const useTokens = () => useQuery({ queryKey: qk.tokens, queryFn: () => get<TokenItem[]>("/api/v1/tokens") });
export const useSessions = () => useQuery({ queryKey: qk.sessions, queryFn: () => get<SessionItem[]>("/api/v1/sessions") });
export const usePasskeys = () => useQuery({ queryKey: qk.passkeys, queryFn: () => get<PasskeyItem[]>("/api/v1/passkeys") });

/** Инвалидация всего, что показывает дерево/детали после мутации */
export function invalidateLive() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["server"] }),
    queryClient.invalidateQueries({ queryKey: ["service"] }),
    queryClient.invalidateQueries({ queryKey: ["checks"] }),
    queryClient.invalidateQueries({ queryKey: ["check"] }),
  ]);
}
