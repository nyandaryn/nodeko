import type { CheckSummary, Overview, ServerSummary, ServiceSummary, Status } from "@shared/api.ts";
import { worst } from "../lib/status.tsx";

export const SIZES = {
  server: { w: 300, h: 124 },
  external: { w: 300, h: 78 },
  group: { w: 220, h: 46 },
  leaf: { w: 236, h: 60 },
};
const INDENT = 28;
const SPINE = 14;
const COL_GAP = 26;
const ROW_GAP = 70;
const STACK_TOP = 16;
const STACK_GAP = 12;
const BAND_GAP = 120;
const R = 9;

export type Counts = Record<Status, number>;
export const emptyCounts = (): Counts => ({ ok: 0, warn: 0, down: 0, stopped: 0, unknown: 0, pending: 0 });

interface Base {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: Status;
  /** для поиска */
  label: string;
  sub: string;
}
export type TreeNode =
  | (Base & { type: "server"; server: ServerSummary; collapsed: boolean; counts: Counts; hasChildren: boolean })
  | (Base & { type: "external"; collapsed: boolean; counts: Counts; total: number })
  | (Base & { type: "group"; serverId: string; name: string; collapsed: boolean; counts: Counts; size: number })
  | (Base & { type: "service"; service: ServiceSummary; checks: CheckSummary[] })
  | (Base & { type: "check"; check: CheckSummary });

export interface TreeEdge {
  id: string;
  d: string;
  status: Status;
}

export interface TreeLayout {
  nodes: TreeNode[];
  edges: TreeEdge[];
  bounds: { x: number; y: number; w: number; h: number };
  byId: Map<string, TreeNode>;
}

/** Ортогональная ломаная со скруглёнными углами */
export function orth(pts: [number, number][], r = R): string {
  const p = pts.filter((pt, i) => i === 0 || pt[0] !== pts[i - 1]![0] || pt[1] !== pts[i - 1]![1]);
  if (p.length < 2) return "";
  let d = `M${p[0]![0]},${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1]!;
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[i + 1]!;
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 - ((x1 - x0) / (l1 || 1)) * rr;
    const ay = y1 - ((y1 - y0) / (l1 || 1)) * rr;
    const bx = x1 + ((x2 - x1) / (l2 || 1)) * rr;
    const by = y1 + ((y2 - y1) / (l2 || 1)) * rr;
    d += ` L${ax},${ay} Q${x1},${y1} ${bx},${by}`;
  }
  const last = p[p.length - 1]!;
  d += ` L${last[0]},${last[1]}`;
  return d;
}

type Leaf = { kind: "service"; s: ServiceSummary; checks: CheckSummary[] } | { kind: "check"; c: CheckSummary };
const leafStatus = (l: Leaf): Status => (l.kind === "service" ? l.s.status : l.c.status);
const leafLabel = (l: Leaf) => (l.kind === "service" ? (l.s.displayName ?? l.s.name) : l.c.name);
const leafSort = (l: Leaf) => (l.kind === "service" ? l.s.sort : 1e6);
const cmpLeaf = (a: Leaf, b: Leaf) => leafSort(a) - leafSort(b) || leafLabel(a).localeCompare(leafLabel(b), "ru");

type Column =
  | { kind: "group"; key: string; name: string; leaves: Leaf[]; sort: number }
  | { kind: "single"; leaf: Leaf; sort: number; name: string }
  | { kind: "stack"; leaves: Leaf[]; sort: number; name: string };

function countsOf(statuses: Status[]): Counts {
  const c = emptyCounts();
  for (const s of statuses) c[s]++;
  return c;
}

export function buildLayout(ov: Overview, collapsed: Set<string>): TreeLayout {
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const checksBySvc = new Map<number, CheckSummary[]>();
  const checksBySrv = new Map<string, CheckSummary[]>();
  const external: CheckSummary[] = [];
  for (const c of ov.checks) {
    if (c.serviceId != null) {
      const arr = checksBySvc.get(c.serviceId) ?? [];
      arr.push(c);
      checksBySvc.set(c.serviceId, arr);
    } else if (c.serverId) {
      const arr = checksBySrv.get(c.serverId) ?? [];
      arr.push(c);
      checksBySrv.set(c.serverId, arr);
    } else external.push(c);
  }
  const svcBySrv = new Map<string, ServiceSummary[]>();
  for (const s of ov.services) {
    if (!s.tracked) continue;
    const arr = svcBySrv.get(s.serverId) ?? [];
    arr.push(s);
    svcBySrv.set(s.serverId, arr);
  }

  interface Band {
    root: TreeNode;
    columns: Column[];
    serverId: string;
  }
  const bands: Band[] = [];

  const servers = [...ov.servers].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ru"));
  for (const srv of servers) {
    const id = `srv:${srv.id}`;
    const svcs = svcBySrv.get(srv.id) ?? [];
    const sChecks = checksBySrv.get(srv.id) ?? [];
    const leaves: Leaf[] = svcs.map((s) => ({ kind: "service", s, checks: checksBySvc.get(s.id) ?? [] }));
    const groups = new Map<string, Leaf[]>();
    const singles: Leaf[] = [];
    for (const l of leaves) {
      const g = l.kind === "service" ? l.s.group : null;
      if (g) {
        const arr = groups.get(g) ?? [];
        arr.push(l);
        groups.set(g, arr);
      } else singles.push(l);
    }
    const columns: Column[] = [];
    for (const [g, ls] of groups) {
      if (ls.length < 2) singles.push(...ls);
      else
        columns.push({ kind: "group", key: g, name: g, leaves: ls.sort(cmpLeaf), sort: Math.min(...ls.map(leafSort)) });
    }
    for (const l of singles) columns.push({ kind: "single", leaf: l, sort: leafSort(l), name: leafLabel(l) });
    const chkLeaves: Leaf[] = sChecks.map((c) => ({ kind: "check", c }));
    if (chkLeaves.length === 1) columns.push({ kind: "single", leaf: chkLeaves[0]!, sort: 1e6, name: "~" });
    else if (chkLeaves.length > 1)
      columns.push({ kind: "group", key: "__checks", name: "Проверки", leaves: chkLeaves.sort(cmpLeaf), sort: 1e6 });
    columns.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ru"));

    const all: Status[] = [...svcs.map((s) => s.status), ...sChecks.map((c) => c.status)];
    for (const s of svcs) for (const c of checksBySvc.get(s.id) ?? []) all.push(c.status);
    const counts = countsOf(all);
    const isCollapsed = collapsed.has(id);
    bands.push({
      serverId: srv.id,
      columns: isCollapsed ? [] : columns,
      root: {
        id,
        type: "server",
        server: srv,
        collapsed: isCollapsed,
        counts,
        hasChildren: columns.length > 0,
        status: srv.status,
        label: srv.name,
        sub: srv.host?.hostname ?? srv.id,
        x: 0,
        y: 0,
        ...SIZES.server,
      },
    });
  }

  if (external.length) {
    const id = "ext";
    const isCollapsed = collapsed.has(id);
    const leaves: Leaf[] = external.map((c) => ({ kind: "check" as const, c })).sort(cmpLeaf);
    // по 6 в столбик
    const columns: Column[] = [];
    for (let i = 0; i < leaves.length; i += 6) columns.push({ kind: "stack", leaves: leaves.slice(i, i + 6), sort: i, name: String(i) });
    bands.push({
      serverId: "",
      columns: isCollapsed ? [] : columns,
      root: {
        id,
        type: "external",
        collapsed: isCollapsed,
        counts: countsOf(external.map((c) => c.status)),
        total: external.length,
        status: worst(external.map((c) => c.status)),
        label: "Внешние проверки",
        sub: `${external.length}`,
        x: 0,
        y: 0,
        ...SIZES.external,
      },
    });
  }

  // ---- размещение ----
  const colWidth = (c: Column, collapsedSet: Set<string>, srvId: string) => {
    if (c.kind === "single") return SIZES.leaf.w;
    if (c.kind === "stack") return INDENT + SIZES.leaf.w;
    return collapsedSet.has(`grp:${srvId}:${c.key}`) ? SIZES.group.w : Math.max(SIZES.group.w, INDENT + SIZES.leaf.w);
  };
  const bandWidths = bands.map((b) => {
    const row = b.columns.reduce((s, c, i) => s + colWidth(c, collapsed, b.serverId) + (i ? COL_GAP : 0), 0);
    return Math.max(b.root.w, row);
  });
  const maxW = Math.max(0, ...bandWidths);
  let y = 0;

  const leafNode = (l: Leaf, x: number, ly: number): TreeNode => {
    if (l.kind === "service") {
      const s = l.s;
      return {
        id: `svc:${s.id}`,
        type: "service",
        service: s,
        checks: l.checks,
        status: s.status,
        label: s.displayName ?? s.name,
        sub: s.name,
        x,
        y: ly,
        ...SIZES.leaf,
      };
    }
    return {
      id: `chk:${l.c.id}`,
      type: "check",
      check: l.c,
      status: l.c.status,
      label: l.c.name,
      sub: l.c.target,
      x,
      y: ly,
      ...SIZES.leaf,
    };
  };

  bands.forEach((b, bi) => {
    const bw = bandWidths[bi]!;
    const bx = (maxW - bw) / 2;
    const root = b.root;
    root.x = bx + (bw - root.w) / 2;
    root.y = y;
    nodes.push(root);
    const sx = root.x + root.w / 2;
    const sy = root.y + root.h;
    const rowY = y + root.h + ROW_GAP;
    const busY = sy + ROW_GAP / 2;
    const rowW = b.columns.reduce((s, c, i) => s + colWidth(c, collapsed, b.serverId) + (i ? COL_GAP : 0), 0);
    let cx = bx + (bw - rowW) / 2;
    let bandBottom = sy;
    for (const col of b.columns) {
      const w = colWidth(col, collapsed, b.serverId);
      if (col.kind === "single") {
        const n = leafNode(col.leaf, cx, rowY);
        nodes.push(n);
        const ax = cx + n.w / 2;
        edges.push({ id: `${root.id}>${n.id}`, d: orth([[sx, sy], [sx, busY], [ax, busY], [ax, rowY]]), status: n.status });
        bandBottom = Math.max(bandBottom, rowY + n.h);
      } else if (col.kind === "group") {
        const gid = `grp:${b.serverId}:${col.key}`;
        const gCollapsed = collapsed.has(gid);
        const statuses: Status[] = [];
        for (const l of col.leaves) {
          statuses.push(leafStatus(l));
          if (l.kind === "service") for (const c of l.checks) statuses.push(c.status);
        }
        const g: TreeNode = {
          id: gid,
          type: "group",
          serverId: b.serverId,
          name: col.name,
          collapsed: gCollapsed,
          counts: countsOf(statuses),
          size: col.leaves.length,
          status: worst(col.leaves.map(leafStatus)),
          label: col.name,
          sub: root.label,
          x: cx,
          y: rowY,
          ...SIZES.group,
        };
        nodes.push(g);
        const ax = cx + SPINE;
        edges.push({ id: `${root.id}>${gid}`, d: orth([[sx, sy], [sx, busY], [ax, busY], [ax, rowY]]), status: g.status });
        bandBottom = Math.max(bandBottom, rowY + g.h);
        if (!gCollapsed) {
          let ly = rowY + g.h + STACK_TOP;
          for (const l of col.leaves) {
            const n = leafNode(l, cx + INDENT, ly);
            nodes.push(n);
            const my = ly + n.h / 2;
            edges.push({ id: `${gid}>${n.id}`, d: orth([[ax, rowY + g.h], [ax, my], [cx + INDENT, my]]), status: n.status });
            ly += n.h + STACK_GAP;
            bandBottom = Math.max(bandBottom, ly - STACK_GAP);
          }
        }
      } else {
        const ax = cx + SPINE;
        let ly = rowY;
        for (const l of col.leaves) {
          const n = leafNode(l, cx + INDENT, ly);
          nodes.push(n);
          const my = ly + n.h / 2;
          edges.push({ id: `${root.id}>${n.id}`, d: orth([[sx, sy], [sx, busY], [ax, busY], [ax, my], [cx + INDENT, my]]), status: n.status });
          ly += n.h + STACK_GAP;
          bandBottom = Math.max(bandBottom, ly - STACK_GAP);
        }
      }
      cx += w + COL_GAP;
    }
    y = bandBottom + BAND_GAP;
  });

  // проблемные рёбра рисуем последними (поверх)
  const rank = (s: Status) => (s === "down" ? 3 : s === "warn" ? 2 : s === "unknown" ? 1 : 0);
  edges.sort((a, b) => rank(a.status) - rank(b.status));

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  if (!nodes.length) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  return {
    nodes,
    edges,
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    byId: new Map(nodes.map((n) => [n.id, n])),
  };
}
