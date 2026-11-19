/** Планировщик HTTP/TCP-проверок, присланных хабом (декларативно: только цель и параметры). */
import { runCheck, tlsCertExpiry, validateCheckTarget } from "../shared/checks.ts";
import type { CheckDef, CheckResult } from "../shared/protocol.ts";

const CERT_EVERY = 6 * 3600_000;
const MAX_BUFFER = 500;

interface Slot {
  def: CheckDef;
  sig: string;
  timer: ReturnType<typeof setInterval> | null;
  first: ReturnType<typeof setTimeout> | null;
  running: boolean;
  certAt: number;
  cert: number | null;
}

export class CheckRunner {
  private slots = new Map<number, Slot>();
  private results: CheckResult[] = [];

  setChecks(defs: CheckDef[]): void {
    const next = new Map<number, CheckDef>();
    for (const d of defs) {
      if (!d || typeof d.id !== "number" || (d.type !== "http" && d.type !== "tcp")) continue;
      if (validateCheckTarget(d.type, d.target)) continue;
      next.set(d.id, {
        ...d,
        interval: Math.min(Math.max(Math.round(d.interval) || 60, 10), 86_400),
        timeout: Math.min(Math.max(Math.round(d.timeout) || 10_000, 500), 60_000),
      });
    }
    for (const [id, slot] of this.slots) {
      const d = next.get(id);
      if (!d || JSON.stringify(d) !== slot.sig) this.stopSlot(id);
    }
    for (const [id, d] of next) {
      if (this.slots.has(id)) continue;
      const slot: Slot = { def: d, sig: JSON.stringify(d), timer: null, first: null, running: false, certAt: 0, cert: null };
      this.slots.set(id, slot);
      // разносим старт проверок по времени, чтобы не било пачкой
      const delay = Math.floor(Math.random() * Math.min(d.interval * 1000, 15_000));
      slot.first = setTimeout(() => {
        slot.first = null;
        void this.tick(slot);
        slot.timer = setInterval(() => void this.tick(slot), d.interval * 1000);
      }, delay);
    }
  }

  private stopSlot(id: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    if (s.first) clearTimeout(s.first);
    this.slots.delete(id);
  }

  private async tick(slot: Slot): Promise<void> {
    if (slot.running) return;
    slot.running = true;
    try {
      const r = await runCheck(slot.def);
      if (slot.def.type === "http" && slot.def.target.startsWith("https:")) {
        if (Date.now() - slot.certAt > CERT_EVERY) {
          slot.certAt = Date.now();
          slot.cert = await tlsCertExpiry(slot.def.target).catch(() => null);
        }
        if (slot.cert) r.certExpires = slot.cert;
      }
      if (!this.slots.has(slot.def.id)) return; // проверку убрали, пока она шла
      this.results.push(r);
      if (this.results.length > MAX_BUFFER) this.results.splice(0, this.results.length - MAX_BUFFER);
    } finally {
      slot.running = false;
    }
  }

  drain(): CheckResult[] {
    const r = this.results;
    this.results = [];
    return r;
  }

  requeue(results: CheckResult[]): void {
    this.results = [...results, ...this.results].slice(-MAX_BUFFER);
  }

  stop(): void {
    for (const id of [...this.slots.keys()]) this.stopSlot(id);
  }
}
