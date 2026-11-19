import { ChevronsDownUp, ChevronsUpDown, Funnel, Plus, Search, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "../components/ui/Button.tsx";
import { Empty, Kbd } from "../components/ui/misc.tsx";
import { useOverview } from "../lib/queries.ts";
import { store } from "../lib/storage.ts";
import { setUi, useUi } from "../lib/ui-store.ts";
import { CheckPanel } from "../panels/CheckPanel.tsx";
import { DRAWER_W, Drawer } from "../panels/Drawer.tsx";
import { ServerPanel } from "../panels/ServerPanel.tsx";
import { ServicePanel } from "../panels/ServicePanel.tsx";
import { buildLayout, type TreeNode } from "../tree/layout.ts";
import { serviceIcon } from "../tree/nodes.tsx";
import { SearchPalette, type SearchItem } from "../tree/SearchPalette.tsx";
import { TreeView, type TreeViewHandle } from "../tree/TreeView.tsx";
import { Globe } from "lucide-react";

function useWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function useNow(period = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(t);
  }, [period]);
  return now;
}

export function TreePage() {
  const [, nav] = useLocation();
  const [mS, pS] = useRoute("/s/:id");
  const [mV, pV] = useRoute("/svc/:id");
  const [mC, pC] = useRoute("/chk/:id");
  const selectedId = mS ? `srv:${decodeURIComponent(pS!.id)}` : mV ? `svc:${pV!.id}` : mC ? `chk:${pC!.id}` : null;
  const ov = useOverview();
  const { issuesOnly } = useUi();
  const width = useWidth();
  const now = useNow();
  const tree = useRef<TreeViewHandle>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(store.get<string[]>("collapsed", [])));
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const pendingCenter = useRef<string | null>(null);
  const clickSelect = useRef(false);

  const layout = useMemo(() => (ov.data ? buildLayout(ov.data, collapsed) : null), [ov.data, collapsed]);
  const drawerOpen = selectedId != null;
  const rightInset = drawerOpen && width >= 768 ? DRAWER_W : 0;

  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      store.set("collapsed", [...n]);
      return n;
    });
  }, []);

  const close = useCallback(() => nav("/"), [nav]);

  const onSelect = useCallback(
    (n: TreeNode) => {
      clickSelect.current = true;
      if (n.type === "server") nav(`/s/${encodeURIComponent(n.server.id)}`);
      else if (n.type === "service") nav(`/svc/${n.service.id}`);
      else if (n.type === "check") nav(`/chk/${n.check.id}`);
      else toggle(n.id);
    },
    [nav, toggle],
  );

  // переход по ссылке извне (события, поиск) — подвинуть дерево к узлу
  useEffect(() => {
    if (!selectedId) return;
    if (clickSelect.current) {
      clickSelect.current = false;
      return;
    }
    pendingCenter.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const id = pendingCenter.current;
    if (!id || !layout) return;
    if (!layout.byId.has(id)) return;
    pendingCenter.current = null;
    // дать дереву смонтироваться
    requestAnimationFrame(() => {
      tree.current?.centerOn(id, { zoom: 0.8, rightInset });
      setHighlight(id);
      setTimeout(() => setHighlight((h) => (h === id ? null : h)), 2600);
    });
  }, [layout, rightInset]);

  // Ctrl+K / «/» — поиск
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input,textarea,select,[contenteditable]");
      if ((e.key === "k" || e.key === "K" || e.key === "л") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = useMemo<SearchItem[]>(() => {
    if (!ov.data) return [];
    const out: SearchItem[] = [];
    for (const s of ov.data.servers)
      out.push({ id: `srv:${s.id}`, type: "server", label: s.name, sub: `сервер · ${s.host?.hostname ?? s.id}`, status: s.status, expand: [], route: `/s/${encodeURIComponent(s.id)}`, icon: Server });
    for (const s of ov.data.services) {
      if (!s.tracked) continue;
      out.push({
        id: `svc:${s.id}`,
        type: "service",
        label: s.displayName ?? s.name,
        sub: `${s.serverId}${s.group ? ` / ${s.group}` : ""} · ${s.key}`,
        status: s.status,
        expand: [`srv:${s.serverId}`, ...(s.group ? [`grp:${s.serverId}:${s.group}`] : [])],
        route: `/svc/${s.id}`,
        icon: serviceIcon(s),
      });
    }
    for (const c of ov.data.checks)
      out.push({
        id: `chk:${c.id}`,
        type: "check",
        label: c.name,
        sub: c.target,
        status: c.status,
        expand: c.serverId ? [`srv:${c.serverId}`, `grp:${c.serverId}:__checks`] : ["ext"],
        route: `/chk/${c.id}`,
        icon: Globe,
      });
    return out;
  }, [ov.data]);

  const pick = (i: SearchItem) => {
    setSearchOpen(false);
    if (i.expand.some((x) => collapsed.has(x))) {
      setCollapsed((c) => {
        const n = new Set(c);
        i.expand.forEach((x) => n.delete(x));
        store.set("collapsed", [...n]);
        return n;
      });
    }
    pendingCenter.current = i.id;
    clickSelect.current = true;
    if (i.route) nav(i.route);
  };

  const allCollapsible = useMemo(() => (layout ? layout.nodes.filter((n) => n.type === "server" || n.type === "group" || n.type === "external").map((n) => n.id) : []), [layout]);
  const anyExpanded = layout ? layout.nodes.some((n) => (n.type === "server" || n.type === "external") && !n.collapsed) : false;

  return (
    <div className="relative h-full overflow-hidden">
      {layout && layout.nodes.length > 0 ? (
        <TreeView
          ref={tree}
          layout={layout}
          selectedId={selectedId}
          highlightId={highlight}
          issuesOnly={issuesOnly}
          now={now}
          onSelect={onSelect}
          onToggle={toggle}
          rightInset={rightInset}
        />
      ) : ov.isLoading ? (
        <div className="canvas-grid flex h-full items-center justify-center" style={{ backgroundSize: "22px 22px" }}>
          <div className="flex flex-col items-center gap-4">
            <div className="skeleton h-[124px] w-[300px] rounded-2xl" />
            <div className="flex gap-6">
              <div className="skeleton h-[46px] w-[220px]" />
              <div className="skeleton h-[46px] w-[220px]" />
              <div className="skeleton h-[46px] w-[220px] max-md:hidden" />
            </div>
          </div>
        </div>
      ) : (
        <div className="canvas-grid flex h-full items-center justify-center p-6" style={{ backgroundSize: "22px 22px" }}>
          <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-card">
            <Empty icon={<Server size={30} />} title="Пока нет ни одного сервера">
              Добавьте сервер и установите на него агента — сервер станет корнем дерева, а его сервисы появятся ветками.
            </Empty>
            <Button variant="primary" icon={<Plus size={15} />} className="mt-4 w-full justify-center" onClick={() => nav("/settings/servers")}>
              Добавить сервер
            </Button>
          </div>
        </div>
      )}

      {/* панель инструментов */}
      <div data-ui className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-9 w-[240px] items-center gap-2.5 rounded-xl border border-line-2 bg-panel/95 pr-2 pl-3 text-[13px] text-mute shadow-card backdrop-blur transition-colors hover:text-ink max-sm:w-9 max-sm:justify-center max-sm:px-0"
          aria-label="Поиск"
        >
          <Search size={15} />
          <span className="flex-1 text-left max-sm:hidden">Найти узел…</span>
          <span className="flex gap-0.5 max-sm:hidden">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <button
          onClick={() => setUi({ issuesOnly: !issuesOnly })}
          aria-pressed={issuesOnly}
          className={`flex h-9 items-center gap-2 rounded-xl border px-3 text-[13px] shadow-card backdrop-blur transition-colors ${
            issuesOnly ? "border-[color-mix(in_oklab,var(--down)_45%,transparent)] bg-down-soft text-ink" : "border-line-2 bg-panel/95 text-ink-2 hover:text-ink"
          }`}
          title="Затемнить всё, что в порядке"
        >
          <Funnel size={14} />
          <span className="max-sm:hidden">Только проблемы</span>
        </button>
        <button
          onClick={() => {
            const n = new Set<string>(anyExpanded ? allCollapsible.filter((id) => !id.startsWith("grp:")) : []);
            if (anyExpanded) for (const id of collapsed) n.add(id);
            store.set("collapsed", [...n]);
            setCollapsed(n);
          }}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-line-2 bg-panel/95 text-ink-2 shadow-card backdrop-blur hover:text-ink"
          title={anyExpanded ? "Свернуть все серверы" : "Развернуть всё"}
          aria-label={anyExpanded ? "Свернуть все серверы" : "Развернуть всё"}
        >
          {anyExpanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
        </button>
      </div>

      {drawerOpen && (
        <Drawer onClose={close}>
          {mS && <ServerPanel id={decodeURIComponent(pS!.id)} onClose={close} />}
          {mV && <ServicePanel id={Number(pV!.id)} onClose={close} />}
          {mC && <CheckPanel id={Number(pC!.id)} onClose={close} />}
        </Drawer>
      )}

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} items={items} onPick={pick} />
    </div>
  );
}
