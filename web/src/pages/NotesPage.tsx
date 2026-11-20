import type { Note, NoteCreateBody, NoteKind, NotePatchBody, NoteSummary, ServiceSummary } from "@shared/api.ts";
import { NOTE_KINDS } from "@shared/api.ts";
import { findSecrets, NOTE_ID_RE, NOTE_KIND_LABEL, NOTE_LIMITS, queryTerms } from "@shared/notes.ts";
import {
  ArrowLeft,
  BookOpenText,
  FileClock,
  FolderGit2,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Server,
  Tag,
  Trash,
  TriangleExclamationPoint,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { MarkdownView } from "../components/Markdown.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Field, Input, Segmented, Select, Textarea } from "../components/ui/Field.tsx";
import { Confirm } from "../components/ui/Modal.tsx";
import { Badge, Empty, Skeleton } from "../components/ui/misc.tsx";
import { ApiErr, del, errMsg, patch, post } from "../lib/api.ts";
import { ago, bytes, dateFull } from "../lib/format.ts";
import { invalidateNotes, qk, queryClient, useNote, useNoteRevision, useNoteRevisions, useNotes, useOverview } from "../lib/queries.ts";
import { STATUS } from "../lib/status.tsx";
import { toast } from "../lib/toast.tsx";

// ---------- маршруты ----------
// /notes · /notes/_new · /notes/<id> · /notes/<id>/edit · /notes/<id>/history[/<rev>]
// «_new» не может быть id заметки (id начинается с буквы или цифры).

type View =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "note"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "history"; id: string; rev?: number };

function parseView(loc: string): View {
  const parts = loc.replace(/^\/notes\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { kind: "none" };
  if (parts[0] === "_new") return { kind: "new" };
  const id = parts[0]!;
  if (parts[1] === "edit") return { kind: "edit", id };
  if (parts[1] === "history") {
    const rev = parts[2] ? Number(parts[2]) : undefined;
    return { kind: "history", id, rev: rev != null && Number.isInteger(rev) && rev > 0 ? rev : undefined };
  }
  return { kind: "note", id };
}

const noteHref = (id: string, tail = "") => `/notes/${encodeURIComponent(id)}${tail}`;

const KIND_ONE: Record<NoteKind, string> = { server: "сервер", project: "проект", runbook: "процедура", reference: "справка" };
const KIND_ICON: Record<NoteKind, typeof Server> = { server: Server, project: FolderGit2, runbook: ListChecks, reference: BookOpenText };

// ---------- страница ----------

export function NotesPage() {
  const [loc] = useLocation();
  const view = parseView(loc);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | NoteKind>("");
  const [tag, setTag] = useState("");
  const all = useNotes();
  const index = useMemo(() => new Map((all.data ?? []).map((n) => [n.id, n])), [all.data]);
  const selected = view.kind === "none" ? null : view.kind === "new" ? "_new" : view.id;

  return (
    <div className="flex h-full min-h-0">
      <aside className={`flex w-full shrink-0 flex-col border-line md:w-[330px] md:border-r ${selected ? "max-md:hidden" : ""}`}>
        <NotesList q={q} setQ={setQ} kind={kind} setKind={setKind} tag={tag} setTag={setTag} selected={selected} all={all.data} loading={all.isLoading} />
      </aside>
      <main className={`min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] ${selected ? "" : "max-md:hidden"}`}>
        <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-8 sm:py-8">
          {view.kind !== "none" && (
            <Link href="/notes" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink md:hidden">
              <ArrowLeft size={15} /> Все заметки
            </Link>
          )}
          {view.kind === "none" && <Welcome count={all.data?.length} />}
          {view.kind === "new" && <NoteEditor key="new" index={index} />}
          {view.kind === "note" && <NoteView key={view.id} id={view.id} index={index} onTag={(t) => setTag(t)} />}
          {view.kind === "edit" && <EditLoader key={view.id} id={view.id} index={index} />}
          {view.kind === "history" && <NoteHistory key={view.id} id={view.id} rev={view.rev} index={index} />}
        </div>
      </main>
    </div>
  );
}

function Welcome({ count }: { count?: number }) {
  const [, nav] = useLocation();
  return (
    <div className="pt-[8vh]">
      <Empty icon={<BookOpenText size={28} />} title="База знаний">
        Заметки об инфраструктуре: где и как развёрнут проект, что на сервере, процедуры и грабли. Их читают люди и ИИ-агенты — через MCP
        (<code className="num">nodeko_notes</code>, <code className="num">nodeko_note</code>). Секреты сюда не пишут — только где они лежат.
        {count != null && (
          <span className="mt-2 block">
            {count ? `Заметок: ${count}. Выберите слева.` : "Заметок пока нет."}
          </span>
        )}
      </Empty>
      <div className="mt-4 flex justify-center">
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => nav("/notes/_new")}>
          Новая заметка
        </Button>
      </div>
    </div>
  );
}

// ---------- список ----------

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Подсветка слов запроса (без учёта регистра). */
function Hl({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-warn-soft px-px text-ink">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function NotesList({
  q,
  setQ,
  kind,
  setKind,
  tag,
  setTag,
  selected,
  all,
  loading,
}: {
  q: string;
  setQ: (v: string) => void;
  kind: "" | NoteKind;
  setKind: (v: "" | NoteKind) => void;
  tag: string;
  setTag: (v: string) => void;
  selected: string | null;
  all: NoteSummary[] | undefined;
  loading: boolean;
}) {
  const [, nav] = useLocation();
  const dq = useDebounced(q.trim(), 200);
  const search = useNotes(dq);
  const terms = useMemo(() => queryTerms(dq), [dq]);
  const base = dq ? search.data : all;
  const items = (base ?? []).filter((n) => (!kind || n.kind === kind) && (!tag || n.tags.includes(tag)));
  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>();
    for (const n of all ?? []) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [all]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of all ?? []) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [all]);
  const [allTags, setAllTags] = useState(false);
  const shownTags = allTags ? tags : tags.slice(0, 10);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups: { kind: NoteKind; items: NoteSummary[] }[] = dq
    ? []
    : NOTE_KINDS.map((k) => ({ kind: k, items: items.filter((n) => n.kind === k) })).filter((g) => g.items.length);

  const row = (n: NoteSummary) => {
    const Icon = KIND_ICON[n.kind];
    const active = selected === n.id;
    return (
      <Link
        key={n.id}
        href={noteHref(n.id)}
        className={`block border-l-2 px-4 py-2.5 transition-colors ${active ? "border-accent bg-card-hi" : "border-transparent hover:bg-card-hi/60"}`}
        aria-current={active ? "page" : undefined}
      >
        <div className="flex items-center gap-2">
          <Icon size={14} className={`shrink-0 ${active ? "text-accent" : "text-mute"}`} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
            <Hl text={n.title} terms={terms} />
          </span>
        </div>
        <div className="num mt-0.5 truncate pl-[22px] text-[11px] text-mute">
          <Hl text={n.id} terms={terms} />
        </div>
        {dq && n.snippet ? (
          <div className="mt-1 line-clamp-3 pl-[22px] text-[12px] leading-snug text-ink-2">
            <Hl text={n.snippet} terms={terms} />
          </div>
        ) : n.summary ? (
          <div className="mt-1 line-clamp-2 pl-[22px] text-[12px] leading-snug text-ink-2">{n.summary}</div>
        ) : null}
      </Link>
    );
  };

  return (
    <>
      <div className="shrink-0 space-y-3 border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight">Заметки</h1>
            <p className="text-[11.5px] text-mute">база знаний для людей и ИИ-агентов</p>
          </div>
          <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => nav("/notes/_new")} title="Новая заметка">
            Новая
          </Button>
        </div>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-mute" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
            placeholder="Поиск по заметкам…  /"
            className="field !h-8 !pl-8 text-[13px]"
            aria-label="Поиск по заметкам"
            spellCheck={false}
          />
          {q && (
            <button className="absolute top-1/2 right-2 -translate-y-1/2 text-mute hover:text-ink" onClick={() => setQ("")} aria-label="Очистить поиск">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          <Chip active={!kind} onClick={() => setKind("")}>
            Все <span className="num text-mute">{all?.length ?? ""}</span>
          </Chip>
          {NOTE_KINDS.filter((k) => kindCounts.get(k)).map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? "" : k)}>
              {NOTE_KIND_LABEL[k]} <span className="num text-mute">{kindCounts.get(k)}</span>
            </Chip>
          ))}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <Tag size={12} className="mr-0.5 text-mute" />
            {shownTags.map(([t]) => (
              <Chip key={t} small active={tag === t} onClick={() => setTag(tag === t ? "" : t)}>
                {t}
              </Chip>
            ))}
            {tag && !shownTags.some(([t]) => t === tag) && (
              <Chip small active onClick={() => setTag("")}>
                {tag}
              </Chip>
            )}
            {tags.length > 10 && (
              <button className="px-1 text-[11.5px] text-mute hover:text-ink" onClick={() => setAllTags(!allTags)}>
                {allTags ? "меньше" : `ещё ${tags.length - 10}`}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {loading || (dq && search.isLoading) ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !items.length ? (
          <div className="px-6 py-10 text-center text-[12.5px] text-mute">
            {dq || kind || tag ? "Ничего не найдено" : "Заметок пока нет"}
            {(kind || tag) && (
              <button
                className="mt-2 block w-full text-accent hover:underline"
                onClick={() => {
                  setKind("");
                  setTag("");
                }}
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        ) : dq ? (
          <div className={`pt-1 transition-opacity ${search.isFetching ? "opacity-60" : ""}`}>{items.map(row)}</div>
        ) : (
          groups.map((g) => (
            <section key={g.kind} className="pt-3">
              <h3 className="micro px-4 pb-1">{NOTE_KIND_LABEL[g.kind]}</h3>
              {g.items.map(row)}
            </section>
          ))
        )}
      </div>
    </>
  );
}

function Chip({ active, onClick, children, small }: { active: boolean; onClick: () => void; children: ReactNode; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-md border font-medium transition-colors ${small ? "h-6 px-1.5 text-[11.5px]" : "h-7 px-2 text-[12px]"} ${
        active ? "border-transparent bg-accent-soft text-ink" : "border-line bg-sunken text-ink-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// ---------- просмотр ----------

function NoteHeader({ n, actions, onTag }: { n: Note; actions?: ReactNode; onTag?: (t: string) => void }) {
  const Icon = KIND_ICON[n.kind];
  return (
    <header className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone="accent">
          <Icon size={12} /> {KIND_ONE[n.kind]}
        </Badge>
        {n.tags.map((t) =>
          onTag ? (
            <button key={t} onClick={() => onTag(t)} title="Показать заметки с этим тегом">
              <Badge className="hover:text-ink">#{t}</Badge>
            </button>
          ) : (
            <Badge key={t}>#{t}</Badge>
          ),
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance">{n.title}</h1>
      {n.summary && <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{n.summary}</p>}
      <div className="num mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-mute">
        <span>{n.id}</span>
        <span>версия {n.rev}</span>
        <span title={dateFull(n.updatedAt)}>
          {n.historic ? "сохранена" : "обновлена"} {ago(n.updatedAt)}
          {n.updatedBy ? ` · ${n.updatedBy}` : ""}
        </span>
        <span>{bytes(n.size)}</span>
      </div>
      <LinkedTargets servers={n.servers} services={n.services} />
    </header>
  );
}

function findService(list: ServiceSummary[], ref: string): ServiceSummary | undefined {
  const i = ref.indexOf("/");
  if (i <= 0) return undefined;
  const server = ref.slice(0, i);
  const name = ref
    .slice(i + 1)
    .toLowerCase()
    .replace(/\.service$/, "");
  return list.find((s) => s.serverId === server && (s.name.toLowerCase().replace(/\.service$/, "") === name || s.displayName?.toLowerCase() === name));
}

function LinkedTargets({ servers, services }: { servers: string[]; services: string[] }) {
  const ov = useOverview(true);
  if (!servers.length && !services.length) return null;
  const srv = ov.data?.servers ?? [];
  const svc = ov.data?.services ?? [];
  const dot = (status: keyof typeof STATUS) => <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: STATUS[status].color }} />;
  const chip = "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line bg-card px-2 text-[12px]";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {servers.map((id) => {
        const s = srv.find((x) => x.id === id);
        return s ? (
          <Link key={`s:${id}`} href={`/s/${encodeURIComponent(id)}`} className={`${chip} text-ink hover:border-line-2 hover:bg-card-hi`} title={`Сервер ${s.name}: ${STATUS[s.status].label}`}>
            <Server size={12} className="text-mute" />
            {dot(s.status)}
            <span className="num truncate">{id}</span>
          </Link>
        ) : (
          <span key={`s:${id}`} className={`${chip} text-mute`} title="Сервера нет в nodeko">
            <Server size={12} />
            <span className="num truncate">{id}</span>
          </span>
        );
      })}
      {services.map((ref) => {
        const s = findService(svc, ref);
        return s ? (
          <Link key={`v:${ref}`} href={`/svc/${s.id}`} className={`${chip} text-ink hover:border-line-2 hover:bg-card-hi`} title={`${STATUS[s.status].label}${s.statusReason ? ` — ${s.statusReason}` : ""}`}>
            {dot(s.status)}
            <span className="num truncate">{ref}</span>
          </Link>
        ) : (
          <span key={`v:${ref}`} className={`${chip} text-mute`} title="Сервис не найден в nodeko">
            <span className="num truncate">{ref}</span>
          </span>
        );
      })}
    </div>
  );
}

function NoteView({ id, index, onTag }: { id: string; index: Map<string, NoteSummary>; onTag: (t: string) => void }) {
  const q = useNote(id);
  const [, nav] = useLocation();
  const [confirmDel, setConfirmDel] = useState(false);
  if (q.isLoading) return <NoteSkeleton />;
  if (q.error || !q.data) {
    if (q.error instanceof ApiErr && q.error.status === 404) return <Missing id={id} />;
    return <Empty title="Не удалось загрузить заметку">{errMsg(q.error)}</Empty>;
  }
  const n = q.data;
  return (
    <article>
      <NoteHeader
        n={n}
        onTag={onTag}
        actions={
          <>
            <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => nav(noteHref(id, "/edit"))}>
              Изменить
            </Button>
            <Button size="sm" variant="ghost" icon={<FileClock size={14} />} title="История версий" onClick={() => nav(noteHref(id, "/history"))}>
              <span className="max-sm:hidden">История</span>
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setConfirmDel(true)} aria-label="Удалить" title="Удалить">
              <Trash size={14} />
            </Button>
          </>
        }
      />
      <MarkdownView text={n.body} index={index} />
      <Confirm
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title="Удалить заметку?"
        body={
          <p>
            «{n.title}» пропадёт из базы знаний и из ответов ИИ-агентам. История версий останется — заметку можно будет восстановить по адресу{" "}
            <span className="num text-ink">/notes/{n.id}/history</span>.
          </p>
        }
        onConfirm={async () => {
          try {
            await del(`/api/v1/notes/${encodeURIComponent(id)}?baseRev=${n.rev}`);
          } catch (e) {
            toast.error(errMsg(e));
            throw e;
          }
          queryClient.removeQueries({ queryKey: qk.note(id) });
          await invalidateNotes();
          toast("Заметка удалена");
          nav("/notes");
        }}
      />
    </article>
  );
}

function Missing({ id }: { id: string }) {
  const revs = useNoteRevisions(id);
  const last = revs.data?.[0];
  if (revs.isLoading) return <NoteSkeleton />;
  return (
    <Empty icon={<BookOpenText size={26} />} title={last?.deleted ? "Заметка удалена" : "Заметки нет"}>
      {last?.deleted ? (
        <>
          «{last.title}» удалена {ago(last.ts)}
          {last.actor ? ` (${last.actor})` : ""}. История версий сохранилась —{" "}
          <Link href={noteHref(id, "/history")} className="text-accent hover:underline">
            посмотреть и восстановить
          </Link>
          .
        </>
      ) : (
        <>
          Заметки <span className="num">{id}</span> не существует.{" "}
          {NOTE_ID_RE.test(id) && (
            <Link href={`/notes/_new?id=${encodeURIComponent(id)}`} className="text-accent hover:underline">
              Создать
            </Link>
          )}
        </>
      )}
    </Empty>
  );
}

function NoteSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <div className="h-4" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-4" />
      ))}
    </div>
  );
}

// ---------- редактор ----------

interface Form {
  id: string;
  kind: NoteKind;
  title: string;
  summary: string;
  tags: string;
  servers: string;
  services: string;
  body: string;
}

const toForm = (n?: Note, id = ""): Form => ({
  id: n?.id ?? id,
  kind: n?.kind ?? "project",
  title: n?.title ?? "",
  summary: n?.summary ?? "",
  tags: n?.tags.join(", ") ?? "",
  servers: n?.servers.join(", ") ?? "",
  services: n?.services.join(", ") ?? "",
  body: n?.body ?? "",
});

const list = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
const utf8 = (s: string) => new TextEncoder().encode(s).length;

function EditLoader({ id, index }: { id: string; index: Map<string, NoteSummary> }) {
  const q = useNote(id);
  if (q.isLoading) return <NoteSkeleton />;
  if (q.error || !q.data) {
    if (q.error instanceof ApiErr && q.error.status === 404) return <Missing id={id} />;
    return <Empty title="Не удалось загрузить заметку">{errMsg(q.error)}</Empty>;
  }
  return <NoteEditor note={q.data} index={index} />;
}

function NoteEditor({ note, index }: { note?: Note; index: Map<string, NoteSummary> }) {
  const [, nav] = useLocation();
  const presetId = useMemo(() => (note ? "" : (new URLSearchParams(window.location.search).get("id") ?? "")), [note]);
  const initial = useMemo(() => toForm(note, presetId), [note, presetId]);
  const [f, setF] = useState<Form>(initial);
  const [tab, setTab] = useState<"text" | "preview">("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; conflict?: boolean } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const dirty = (Object.keys(f) as (keyof Form)[]).some((k) => f[k] !== initial[k]);
  const idOk = !!note || NOTE_ID_RE.test(f.id.trim());
  const size = utf8(f.body);
  const secrets = useMemo(() => findSecrets(f.body), [f.body]);
  const canSave = idOk && !!f.title.trim() && !!f.body.trim() && size <= NOTE_LIMITS.body && !busy;
  const back = note ? noteHref(note.id) : "/notes";

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const fields = {
      kind: f.kind,
      title: f.title.trim(),
      summary: f.summary.trim(),
      tags: list(f.tags),
      servers: list(f.servers),
      services: list(f.services),
      body: f.body,
    };
    try {
      if (note) {
        const out = await patch<Note>(`/api/v1/notes/${encodeURIComponent(note.id)}`, { ...fields, baseRev: note.rev } satisfies NotePatchBody);
        queryClient.setQueryData(qk.note(note.id), out);
        await invalidateNotes();
        toast(out.rev === note.rev ? "Без изменений" : `Сохранено — версия ${out.rev}`);
        nav(noteHref(note.id));
      } else {
        const id = f.id.trim();
        const out = await post<Note>("/api/v1/notes", { id, ...fields } satisfies NoteCreateBody);
        queryClient.setQueryData(qk.note(id), out);
        await invalidateNotes();
        toast("Заметка создана");
        nav(noteHref(id));
      }
    } catch (e) {
      const conflict = e instanceof ApiErr && e.status === 409;
      setError({ msg: errMsg(e), conflict });
    } finally {
      setBusy(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="micro mb-1">{note ? `версия ${note.rev}` : "новая заметка"}</div>
          <h1 className="text-[22px] font-semibold tracking-tight">{note ? "Изменить заметку" : "Новая заметка"}</h1>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        {note ? (
          <Field label="id" hint="не меняется" htmlFor="note-id">
            <Input id="note-id" value={note.id} disabled className="num opacity-70" />
          </Field>
        ) : (
          <Field
            label="id"
            hint="латиница, цифры, . _ -"
            htmlFor="note-id"
            help={f.id && !idOk ? "Строчная латиница, цифры, «.», «_», «-», до 64 символов, с буквы или цифры" : undefined}
          >
            <Input
              id="note-id"
              value={f.id}
              onChange={(e) => set("id", e.target.value.toLowerCase())}
              placeholder="shop"
              className={`num ${f.id && !idOk ? "!border-down" : ""}`}
              maxLength={NOTE_LIMITS.id}
              spellCheck={false}
              autoFocus
            />
          </Field>
        )}
        <Field label="Вид" htmlFor="note-kind">
          <Select id="note-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as NoteKind)}>
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_ONE[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 space-y-4">
        <Field label="Заголовок" hint={`${f.title.length}/${NOTE_LIMITS.title}`} htmlFor="note-title">
          <Input id="note-title" value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={NOTE_LIMITS.title} placeholder="Магазин — прод и деплой" autoFocus={!!note} />
        </Field>
        <Field
          label="Кратко"
          hint={`${f.summary.length}/${NOTE_LIMITS.summary}`}
          htmlFor="note-summary"
          help="Одна строка: что внутри и когда читать — по ней ИИ-агент решает, открывать ли заметку."
        >
          <Input id="note-summary" value={f.summary} onChange={(e) => set("summary", e.target.value)} maxLength={NOTE_LIMITS.summary} placeholder="Где живёт, как выкатывать и откатывать, грабли" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Теги" hint="через запятую" htmlFor="note-tags">
            <Input id="note-tags" value={f.tags} onChange={(e) => set("tags", e.target.value)} placeholder="deploy, bun" spellCheck={false} />
          </Field>
          <Field label="Серверы" hint="id через запятую" htmlFor="note-servers">
            <Input id="note-servers" value={f.servers} onChange={(e) => set("servers", e.target.value)} placeholder="atlas" className="num" spellCheck={false} />
          </Field>
          <Field label="Сервисы" hint="сервер/имя, через запятую" htmlFor="note-services">
            <Input id="note-services" value={f.services} onChange={(e) => set("services", e.target.value)} placeholder="atlas/shop-api" className="num" spellCheck={false} />
          </Field>
        </div>
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <Segmented
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "text", label: "Текст" },
                { value: "preview", label: "Предпросмотр" },
              ]}
            />
            <span className={`num text-[11.5px] ${size > NOTE_LIMITS.body ? "text-down" : "text-mute"}`}>
              markdown · [[id]] — ссылка на заметку · {bytes(size)} / {bytes(NOTE_LIMITS.body)}
            </span>
          </div>
          {tab === "text" ? (
            <Textarea
              aria-label="Текст заметки (markdown)"
              value={f.body}
              onChange={(e) => set("body", e.target.value)}
              rows={24}
              spellCheck={false}
              className="num min-h-[320px] !text-[12.5px] !leading-relaxed"
              placeholder={"## Где живёт\n\n| | |\n|---|---|\n| Сервер | [[atlas]] |\n| Каталог | `/home/deploy/shop` |\n\n## Выкатка\n\n```sh\n./deploy.sh\n```"}
            />
          ) : (
            <div className="min-h-[320px] rounded-lg border border-line-2 bg-card px-5 py-4">
              {f.body.trim() ? <MarkdownView text={f.body} index={index} /> : <span className="text-[13px] text-mute">Пусто</span>}
            </div>
          )}
        </div>
        {secrets.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-[var(--warn)] bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
            <TriangleExclamationPoint size={15} className="mt-0.5 shrink-0 text-[var(--warn)]" />
            <div>
              Похоже на секрет — хаб не сохранит такой текст:{" "}
              {secrets.slice(0, 4).map((s, i) => (
                <span key={i}>
                  {i ? ", " : ""}
                  {s.kind} (строка {s.line})
                </span>
              ))}
              {secrets.length > 4 ? ` и ещё ${secrets.length - 4}` : ""}. Напишите, где секрет хранится, а не его значение.
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-down/40 bg-down-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink" role="alert">
            {error.conflict ? (
              <>
                <b className="font-semibold">Заметку уже изменили</b> — пока вы редактировали, кто-то сохранил версию новее.
                <div className="mt-1 text-ink-2">{error.msg}</div>
                <div className="mt-1.5 text-ink-2">
                  Скопируйте свой текст, откройте заметку заново и перенесите правки.{" "}
                  <Link href={noteHref(note!.id, "/history")} className="text-accent hover:underline">
                    История версий
                  </Link>
                </div>
              </>
            ) : (
              error.msg
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <span className="mr-auto text-[11.5px] text-mute max-sm:hidden">Ctrl+S — сохранить</span>
          <Button variant="ghost" onClick={() => (dirty ? setConfirmLeave(true) : nav(back))}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!canSave} onClick={save}>
            {note ? "Сохранить" : "Создать"}
          </Button>
        </div>
      </div>
      <Confirm
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Отменить правки?"
        body={<p>Несохранённые изменения пропадут.</p>}
        confirmLabel="Отменить правки"
        onConfirm={() => nav(back)}
      />
    </div>
  );
}

// ---------- история ----------

function NoteHistory({ id, rev, index }: { id: string; rev?: number; index: Map<string, NoteSummary> }) {
  const cur = useNote(id);
  const revs = useNoteRevisions(id);
  const [, nav] = useLocation();
  const [confirm, setConfirm] = useState(false);
  const current = cur.data;
  const deleted = cur.error instanceof ApiErr && cur.error.status === 404;
  const items = revs.data ?? [];
  const viewRev = rev ?? items.find((r) => !r.deleted)?.rev;
  const ver = useNoteRevision(id, viewRev);
  const isCurrent = !!current && viewRev === current.rev;

  if (revs.isLoading || cur.isLoading) return <NoteSkeleton />;
  if (revs.error) {
    if (revs.error instanceof ApiErr && revs.error.status === 404) return <Missing id={id} />;
    return <Empty title="Не удалось загрузить историю">{errMsg(revs.error)}</Empty>;
  }

  const restore = async () => {
    const v = ver.data;
    if (!v) return;
    const fields = { kind: v.kind, title: v.title, summary: v.summary, tags: v.tags, servers: v.servers, services: v.services, body: v.body };
    try {
      if (current) await patch<Note>(`/api/v1/notes/${encodeURIComponent(id)}`, { ...fields, baseRev: current.rev } satisfies NotePatchBody);
      else await post<Note>("/api/v1/notes", { id, ...fields } satisfies NoteCreateBody);
    } catch (e) {
      toast.error(errMsg(e));
      throw e;
    }
    await invalidateNotes();
    toast(`Версия ${v.rev} восстановлена`);
    nav(noteHref(id));
  };

  return (
    <div>
      <div className="mb-5">
        {current ? (
          <Link href={noteHref(id)} className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink max-md:hidden">
            <ArrowLeft size={14} /> {current.title}
          </Link>
        ) : (
          <span className="num text-[12px] text-mute">{id}</span>
        )}
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">История версий</h1>
        {deleted && <p className="mt-1 text-[13px] text-down">Заметка удалена — восстановите нужную версию.</p>}
      </div>
      <div className="mb-6 max-h-[300px] overflow-y-auto rounded-xl border border-line bg-card">
        {items.map((r) => {
          const active = r.rev === viewRev;
          const body = (
            <>
              <span className="num w-10 shrink-0 text-[12px] text-ink-2">v{r.rev}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {r.deleted ? <span className="text-down">удалена</span> : r.title}
                {current?.rev === r.rev && (
                  <Badge tone="ok" className="ml-2">
                    текущая
                  </Badge>
                )}
              </span>
              <span className="num shrink-0 text-[11.5px] text-mute max-sm:hidden">{r.actor ?? ""}</span>
              <span className="num w-[120px] shrink-0 text-right text-[11.5px] whitespace-nowrap text-mute max-sm:w-auto" title={dateFull(r.ts)}>
                {ago(r.ts)}
              </span>
            </>
          );
          return r.deleted ? (
            <div key={r.rev} className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0 opacity-70">
              {body}
            </div>
          ) : (
            <Link
              key={r.rev}
              href={noteHref(id, `/history/${r.rev}`)}
              className={`flex items-center gap-3 border-b border-l-2 border-b-line px-3.5 py-2 last:border-b-0 ${active ? "border-l-accent bg-card-hi" : "border-l-transparent hover:bg-card-hi"}`}
            >
              {body}
            </Link>
          );
        })}
      </div>
      {viewRev == null ? null : ver.isLoading ? (
        <NoteSkeleton />
      ) : ver.error || !ver.data ? (
        <Empty title="Версия недоступна">{errMsg(ver.error)}</Empty>
      ) : (
        <div className="rounded-xl border border-line bg-panel px-5 py-5 sm:px-6">
          <NoteHeader
            n={ver.data}
            actions={
              !isCurrent && (
                <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => setConfirm(true)}>
                  Восстановить
                </Button>
              )
            }
          />
          <MarkdownView text={ver.data.body} index={index} />
        </div>
      )}
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Восстановить версию ${viewRev}?`}
        danger={false}
        confirmLabel="Восстановить"
        body={<p>{current ? `Её содержимое станет новой версией ${current.rev + 1}; текущая версия ${current.rev} останется в истории.` : "Заметка будет создана заново с содержимым этой версии."}</p>}
        onConfirm={restore}
      />
    </div>
  );
}
