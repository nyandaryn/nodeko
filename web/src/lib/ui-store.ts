import { useSyncExternalStore } from "react";
import { store } from "./storage.ts";

export type Theme = "dark" | "light";

interface UiState {
  theme: Theme;
  issuesOnly: boolean;
}

let state: UiState = {
  theme: store.get<Theme>("theme", "dark"),
  issuesOnly: store.get<boolean>("issuesOnly", false),
};
const listeners = new Set<() => void>();

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", t === "dark" ? "#0b0c0e" : "#f3f3f0");
}

export function setUi(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  if (patch.theme) {
    applyTheme(patch.theme);
    store.set("theme", patch.theme);
  }
  if (patch.issuesOnly !== undefined) store.set("issuesOnly", patch.issuesOnly);
  listeners.forEach((l) => l());
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const getUi = () => state;
