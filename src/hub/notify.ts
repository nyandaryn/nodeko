import { errMsg, log } from "./log.ts";
import { getSettings } from "./settings.ts";

/**
 * Уведомления в Telegram. Очередь с пакетированием: события за 3 с склеиваются в одно сообщение,
 * не чаще одного сообщения в секунду, 429 — ждём retry_after.
 */
export interface Notice {
  level: "info" | "ok" | "warn" | "error";
  title: string;
  message?: string | null;
  link?: string | null;
}

const EMOJI = { error: "🔴", warn: "🟡", ok: "🟢", info: "🔵" } as const;
const queue: Notice[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(n: Notice): string {
  let s = `${EMOJI[n.level]} <b>${escapeHtml(n.title)}</b>`;
  if (n.message) s += `\n${escapeHtml(n.message.slice(0, 600))}`;
  if (n.link) s += `\n<a href="${escapeHtml(n.link)}">открыть в nodeko</a>`;
  return s;
}

export function enqueueNotice(n: Notice): void {
  const tg = getSettings().notify.telegram;
  if (!tg.enabled || !tg.botToken || !tg.chatId) return;
  queue.push(n);
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  if (!timer) timer = setTimeout(flush, 3000);
}

async function flush(): Promise<void> {
  timer = null;
  if (sending || !queue.length) return;
  sending = true;
  try {
    while (queue.length) {
      const batch: string[] = [];
      let len = 0;
      while (queue.length && batch.length < 15) {
        const text = render(queue[0]!);
        if (len + text.length > 3800 && batch.length) break;
        batch.push(text);
        len += text.length + 2;
        queue.shift();
      }
      const r = await sendTelegram(batch.join("\n\n"));
      if (!r.ok) log.warn("telegram: не отправлено", { error: r.error });
      await Bun.sleep(1100);
    }
  } finally {
    sending = false;
  }
}

export async function sendTelegram(text: string, attempt = 0): Promise<{ ok: boolean; error?: string }> {
  const tg = getSettings().notify.telegram;
  if (!tg.botToken || !tg.chatId) return { ok: false, error: "не задан токен бота или chat id" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: tg.chatId,
        ...(tg.threadId ? { message_thread_id: Number(tg.threadId) } : {}),
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
    if (res.status === 429 && attempt < 3) {
      await Bun.sleep(((body.parameters?.retry_after ?? 5) + 1) * 1000);
      return sendTelegram(text, attempt + 1);
    }
    if (!body.ok) return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    // текст ошибки fetch может содержать URL с токеном — вырезаем
    return { ok: false, error: errMsg(e).replace(/bot\d+:[\w-]+/g, "bot***") };
  }
}
