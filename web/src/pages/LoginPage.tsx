import type { AuthState } from "@shared/api.ts";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication } from "@simplewebauthn/browser";
import { FingerprintPattern, LockKeyhole, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "../components/Logo.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Field, Input } from "../components/ui/Field.tsx";
import { ApiErr, api, errMsg } from "../lib/api.ts";
import { qk, queryClient } from "../lib/queries.ts";

function passkeyError(e: unknown): string | null {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return null; // пользователь отменил
  if (e instanceof ApiErr) return e.message;
  return `Passkey: ${errMsg(e)}`;
}

export function LoginPage({ state }: { state: AuthState | undefined }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"pw" | "pk" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supportsPk = browserSupportsWebAuthn();
  const autofillStarted = useRef(false);

  const done = (s: AuthState) => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
    queryClient.setQueryData(qk.auth, s);
  };

  const passkey = async (autofill: boolean) => {
    if (!autofill) {
      setBusy("pk");
      setError(null);
    }
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
        "POST",
        "/api/auth/passkey/login/options",
        {},
        { noAuthRedirect: true },
      );
      const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
      setBusy("pk");
      const s = await api<AuthState>("POST", "/api/auth/passkey/login/verify", { challengeId, response }, { noAuthRedirect: true });
      done(s);
    } catch (e) {
      const m = passkeyError(e);
      if (m && !autofill) setError(m);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (autofillStarted.current || !state?.configured || !state.passkeys) return;
    autofillStarted.current = true;
    browserSupportsWebAuthnAutofill().then((ok) => {
      if (ok) void passkey(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.configured, state?.passkeys]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("pw");
    setError(null);
    try {
      const s = await api<AuthState>("POST", "/api/auth/login", { username: username.trim(), password }, { noAuthRedirect: true });
      done(s);
    } catch (err) {
      setError(err instanceof ApiErr && err.status === 401 ? "Неверный логин или пароль." : errMsg(err));
      setPassword("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="canvas-grid relative flex min-h-full items-center justify-center overflow-hidden p-4" style={{ backgroundSize: "22px 22px" }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(600px 400px at 50% 38%, var(--accent-soft), transparent 70%)" }}
      />
      <div className="relative w-full max-w-[380px] animate-pop">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <LogoMark size={46} />
          <div>
            <h1 className="num text-[22px] font-semibold tracking-tight">
              node<span className="text-accent">ko</span>
            </h1>
            <p className="mt-1 text-[13px] text-mute">Мониторинг серверов и сервисов</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line-2 bg-panel/95 p-6 shadow-pop backdrop-blur">
          {state && !state.configured ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[14px] font-medium">
                <Terminal size={16} className="text-accent" /> Хаб ещё не настроен
              </div>
              <p className="text-[13px] leading-relaxed text-ink-2">Создайте пользователя на хабе, затем обновите страницу:</p>
              <pre className="num rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] text-ink">bun run admin user:create &lt;login&gt;</pre>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Логин" htmlFor="login-user">
                <Input
                  id="login-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username webauthn"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </Field>
              <Field label="Пароль" htmlFor="login-pass">
                <Input
                  id="login-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && (
                <div className="rounded-lg border border-[color-mix(in_oklab,var(--down)_40%,transparent)] bg-down-soft px-3 py-2 text-[12.5px] text-ink" role="alert">
                  {error}
                </div>
              )}
              <Button type="submit" variant="primary" className="w-full justify-center" loading={busy === "pw"} disabled={busy != null} icon={<LockKeyhole size={15} />}>
                Войти
              </Button>
              {supportsPk && (
                <>
                  <div className="flex items-center gap-3 text-[11px] text-mute">
                    <span className="h-px flex-1 bg-[var(--line-2)]" />
                    или
                    <span className="h-px flex-1 bg-[var(--line-2)]" />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full justify-center"
                    loading={busy === "pk"}
                    disabled={busy != null}
                    icon={<FingerprintPattern size={16} />}
                    onClick={() => passkey(false)}
                  >
                    Войти с passkey
                  </Button>
                </>
              )}
            </form>
          )}
        </div>
        <p className="mt-5 text-center text-[11.5px] text-mute">Доступ только для владельца. Попытки входа ограничены и журналируются.</p>
      </div>
    </div>
  );
}
