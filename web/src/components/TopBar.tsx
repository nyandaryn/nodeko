import { Bell, ListTree, LogOut, Moon, Settings, Sun } from "lucide-react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api.ts";
import { qk, queryClient, useAuth, useOverview } from "../lib/queries.ts";
import { setUi, useUi } from "../lib/ui-store.ts";
import { Logo } from "./Logo.tsx";

const NAV = [
  { href: "/", label: "Дерево", icon: ListTree, match: (l: string) => l === "/" || /^\/(s|svc|chk)\//.test(l) },
  { href: "/events", label: "События", icon: Bell, match: (l: string) => l.startsWith("/events") },
  { href: "/settings", label: "Настройки", icon: Settings, match: (l: string) => l.startsWith("/settings") },
];

export function TopBar() {
  const [loc, nav] = useLocation();
  const { theme, issuesOnly } = useUi();
  const ov = useOverview();
  const auth = useAuth();
  const servers = ov.data?.servers ?? [];
  const online = servers.filter((s) => s.connected).length;
  const enrolled = servers.filter((s) => s.enrolled).length;
  const problems =
    (ov.data?.services ?? []).filter((s) => s.tracked && (s.status === "down" || s.status === "warn")).length +
    (ov.data?.checks ?? []).filter((c) => c.status === "down" || c.status === "warn").length +
    servers.filter((s) => s.status === "down" || s.status === "warn").length;
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel/90 px-3 backdrop-blur sm:gap-5 sm:px-4">
      <Link href="/" className="shrink-0" aria-label="nodeko — на главную">
        <Logo compact />
      </Link>
      <nav className="flex items-center gap-0.5">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = n.match(loc);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${
                active ? "bg-card-hi text-ink shadow-[inset_0_0_0_1px_var(--line)]" : "text-ink-2 hover:text-ink"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={15} className={active ? "text-accent" : ""} />
              <span className="max-md:hidden">{n.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {ov.data && (
          <div className="num flex items-center gap-1 rounded-lg border border-line bg-sunken p-0.5 text-[12px]">
            <span className="flex h-7 items-center gap-1.5 px-2 text-ink-2" title="агентов на связи">
              <span className={`h-[7px] w-[7px] rounded-full ${online === enrolled ? "bg-ok" : "bg-down"}`} />
              {online}/{enrolled}
              <span className="max-sm:hidden">онлайн</span>
            </span>
            <button
              onClick={() => {
                setUi({ issuesOnly: problems > 0 ? true : !issuesOnly });
                if (!NAV[0]!.match(loc)) nav("/");
              }}
              className={`flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors ${
                problems ? "bg-down-soft text-ink hover:brightness-110" : "text-ink-2 hover:text-ink"
              }`}
              title={problems ? "Показать только проблемы" : "Проблем нет"}
            >
              <span className={`h-[7px] w-[7px] rounded-full ${problems ? "bg-down" : "bg-ok"}`} />
              {problems}
              <span className="max-sm:hidden">{problems === 1 ? "проблема" : problems >= 2 && problems <= 4 ? "проблемы" : "проблем"}</span>
            </button>
          </div>
        )}
        <button
          onClick={() => setUi({ theme: theme === "dark" ? "light" : "dark" })}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-card-hi hover:text-ink"
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          onClick={async () => {
            await api("POST", "/api/auth/logout", {}, { noAuthRedirect: true }).catch(() => {});
            queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
            queryClient.setQueryData(qk.auth, { authenticated: false, configured: true, user: null, passkeys: auth.data?.passkeys ?? 0 });
            nav("/");
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-ink-2 transition-colors hover:bg-card-hi hover:text-ink"
          title={`Выйти (${auth.data?.user?.username ?? ""})`}
        >
          <LogOut size={15} />
          <span className="max-lg:hidden">{auth.data?.user?.username}</span>
        </button>
      </div>
    </header>
  );
}
