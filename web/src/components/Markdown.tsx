import type { NoteSummary } from "@shared/api.ts";
import { createContext, memo, useContext, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "wouter";

/**
 * Markdown заметок: GFM (таблицы, списки задач, зачёркивание), ссылки `[[id]]` на другие заметки.
 * Сырой HTML не рендерится (react-markdown без rehype-raw показывает его текстом), URL — через
 * стандартный безопасный urlTransform.
 */

// ---------- [[id]] → ссылка на заметку ----------

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const WIKI = /\[\[([a-z0-9][a-z0-9._-]{0,63})\]\]/g;
const SKIP = new Set(["link", "linkReference", "definition", "code", "inlineCode", "html"]);

function splitWiki(value: string): MdNode[] | null {
  WIKI.lastIndex = 0;
  if (!WIKI.test(value)) return null;
  const out: MdNode[] = [];
  let last = 0;
  WIKI.lastIndex = 0;
  for (let m = WIKI.exec(value); m; m = WIKI.exec(value)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({ type: "link", url: `/notes/${m[1]}`, children: [{ type: "text", value: m[1]! }] });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const c of node.children) {
    if (c.type === "text" && c.value) {
      const parts = splitWiki(c.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    walk(c);
    next.push(c);
  }
  node.children = next;
}

const remarkWikiLinks = () => (tree: MdNode) => walk(tree);

// ---------- рендер ----------

/** Известные заметки: для подписи `[[id]]` заголовком и приглушения битых ссылок. */
const NotesIndex = createContext<Map<string, NoteSummary> | null>(null);

function NoteLink({ id, children }: { id: string; children: ReactNode }) {
  const index = useContext(NotesIndex);
  const n = index?.get(id);
  if (index && !n)
    return (
      <span className="md-broken" title={`Заметки «${id}» нет`}>
        {children}
      </span>
    );
  const plain = Array.isArray(children) ? children.join("") : children;
  return (
    <Link href={`/notes/${id}`} className="md-note" title={n?.summary || id}>
      {n && plain === id ? n.title : children}
    </Link>
  );
}

const components: Components = {
  a({ href, children, node: _n, ...rest }) {
    const url = href ?? "";
    const note = /^\/notes\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(url);
    if (note) return <NoteLink id={note[1]!}>{children}</NoteLink>;
    if (url.startsWith("/") && !url.startsWith("//"))
      return (
        <Link href={url} {...rest}>
          {children}
        </Link>
      );
    if (url.startsWith("#")) return <a href={url}>{children}</a>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  table({ node: _n, ...p }) {
    return (
      <div className="md-table">
        <table {...p} />
      </div>
    );
  },
  img({ node: _n, src, alt }) {
    // внешние картинки не грузим (CSP и приватность) — показываем ссылкой
    return typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        🖼 {alt || src}
      </a>
    ) : null;
  },
};

const plugins = [remarkGfm, remarkWikiLinks];

export const MarkdownView = memo(function MarkdownView({ text, index, className = "" }: { text: string; index?: Map<string, NoteSummary>; className?: string }) {
  return (
    <NotesIndex.Provider value={index ?? null}>
      <div className={`md ${className}`}>
        <Markdown remarkPlugins={plugins} components={components}>
          {text}
        </Markdown>
      </div>
    </NotesIndex.Provider>
  );
});
