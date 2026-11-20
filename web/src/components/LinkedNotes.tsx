import type { NoteKind, NoteRef } from "@shared/api.ts";
import { BookOpenText, ChevronRight, FolderGit2, ListChecks, Server } from "lucide-react";
import { Link } from "wouter";
import { Section } from "./ui/misc.tsx";

const ICON: Record<NoteKind, typeof Server> = { server: Server, project: FolderGit2, runbook: ListChecks, reference: BookOpenText };

/** Заметки базы знаний, привязанные к серверу или сервису. Пусто — блока нет. */
export function LinkedNotes({ notes }: { notes: NoteRef[] | undefined }) {
  if (!notes?.length) return null;
  return (
    <Section title="База знаний">
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
        {notes.map((n) => {
          const Icon = ICON[n.kind] ?? BookOpenText;
          return (
            <Link key={n.id} href={`/notes/${encodeURIComponent(n.id)}`} className="flex items-start gap-3 px-3.5 py-2.5 transition-colors hover:bg-card-hi">
              <Icon size={15} className="mt-0.5 shrink-0 text-mute" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">{n.title}</div>
                {n.summary && <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-mute">{n.summary}</div>}
              </div>
              <ChevronRight size={14} className="mt-0.5 shrink-0 text-mute" />
            </Link>
          );
        })}
      </div>
    </Section>
  );
}
