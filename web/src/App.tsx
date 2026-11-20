import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { Route, Switch } from "wouter";
import { LogoMark } from "./components/Logo.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { setUnauthorizedHandler } from "./lib/api.ts";
import { qk, queryClient, useAuth } from "./lib/queries.ts";
import { Toaster } from "./lib/toast.tsx";
import { EventsPage } from "./pages/EventsPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TreePage } from "./pages/TreePage.tsx";

// markdown-рендер тянет заметную часть бандла — грузим страницу заметок по требованию
const NotesPage = lazy(() => import("./pages/NotesPage.tsx").then((m) => ({ default: m.NotesPage })));

function Gate() {
  const auth = useAuth();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const prev = queryClient.getQueryData<{ passkeys?: number }>(qk.auth);
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
      queryClient.setQueryData(qk.auth, { authenticated: false, configured: true, user: null, passkeys: prev?.passkeys ?? 0 });
    });
  }, []);
  if (auth.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-pulse">
          <LogoMark size={40} />
        </div>
      </div>
    );
  if (auth.isError && !auth.data)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <LogoMark size={40} />
        <div className="text-[15px] font-medium">Хаб недоступен</div>
        <p className="max-w-sm text-[13px] text-mute">Не удалось связаться с сервером nodeko. Проверьте соединение — страница повторит попытку сама.</p>
        <button className="mt-2 text-[13px] text-accent hover:underline" onClick={() => auth.refetch()}>
          Повторить сейчас
        </button>
      </div>
    );
  if (!auth.data?.authenticated) return <LoginPage state={auth.data} />;
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        <Switch>
          <Route path="/events" component={EventsPage} />
          <Route path={/^\/notes(?:\/.*)?$/}>
            <Suspense fallback={null}>
              <NotesPage />
            </Suspense>
          </Route>
          <Route path="/settings" component={SettingsPage} />
          <Route path="/settings/:section" component={SettingsPage} />
          <Route>
            <TreePage />
          </Route>
        </Switch>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Gate />
      <Toaster />
    </QueryClientProvider>
  );
}
