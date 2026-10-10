import { useState, type FormEvent } from "react";
import cfg from "@sweatbox/config/public";
import { SESSION_CODE_RE, type GenerateSpec } from "@sweatbox/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Link, navigate, useSearch } from "../lib/router";
import { Button } from "../components/Button";
import { GenerateForm } from "../components/GenerateForm";

const LOGIN_ERRORS: Record<string, string> = {
  not_in_guild: "Join the ATC24Academy Discord first, then log in again.",
  discord_error: "Discord didn't let us log you in. Please try again.",
  bad_state: "That login link expired. Please log in again.",
};

export function Home() {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const authError = useAuth((s) => s.error);
  const refresh = useAuth((s) => s.refresh);
  const logout = useAuth((s) => s.logout);
  const loginError = useSearch().get("login_error");
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loaded) return <main className="home" />;

  if (!me)
    return (
      <main className="home">
        <div className="home__center">
          <h1 className="home__title">ATC24Academy Sweatbox</h1>
          <div className="home__login">
            <a className="btn btn--primary btn--lg" href={api.loginUrl("/")}>
              Log in with Discord
            </a>
            {(loginError || authError) && (
              <p className="error-text" role="alert" style={{ margin: 0 }}>
                {loginError ? (LOGIN_ERRORS[loginError] ?? "Login failed. Please try again.") : authError}
              </p>
            )}
            {import.meta.env.DEV && (
              <div className="row">
                {(["host", "viewer"] as const).map((as) => (
                  <Button
                    key={as}
                    variant="ghost"
                    onClick={async () => {
                      await api.devLogin(as, as === "host" ? "Dev Host" : "Dev Viewer");
                      await refresh();
                    }}
                  >
                    Dev {as}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    );

  const join = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!SESSION_CODE_RE.test(c)) return setJoinError(`Session codes are ${cfg.session.codeLength} letters (case matters).`);
    setBusy(true);
    setJoinError(null);
    try {
      await api.session(c);
      navigate(`/s/${c}`);
    } catch (err) {
      setJoinError(err instanceof ApiError && err.status === 404 ? `No session ${c}. Check the code; case matters.` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async (spec: GenerateSpec) => {
    setBusy(true);
    setCreateError(null);
    try {
      const r = await api.createSession(spec);
      navigate(`/s/${r.code}`);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <div className="home__user">
        <span>{me.displayName}</span>
        <button type="button" className="btn btn--ghost" onClick={() => void logout()}>
          Log out
        </button>
      </div>
      <div className="home__center">
        <h1 className="home__title">ATC24Academy Sweatbox</h1>
        {me.reauth && (
          <p className="muted" style={{ margin: 0 }}>
            {cfg.auth.reauthBannerText} <a href={api.loginUrl("/")}>Log in again</a>
          </p>
        )}
        <div className="home__options" style={me.isHost ? undefined : { width: "min(360px, 100%)" }}>
          {me.isHost && (
            <section className="home__option" aria-labelledby="create-title">
              <h2 id="create-title">Create Sweatbox</h2>
              <GenerateForm submitLabel="Create Sweatbox" busy={busy} error={createError} onSubmit={(spec) => void create(spec)} />
            </section>
          )}
          <section className="home__option" aria-labelledby="join-title">
            <h2 id="join-title">Join Sweatbox</h2>
            <form className="form" onSubmit={(e) => void join(e)}>
              <div>
                <label className="label" htmlFor="join-code">
                  Session code
                </label>
                <input
                  id="join-code"
                  className="field field--lg"
                  style={{ width: "100%" }}
                  maxLength={cfg.session.codeLength}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z]/g, ""))}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {joinError && (
                <p className="error-text" role="alert" style={{ margin: 0 }}>
                  {joinError}
                </p>
              )}
              <Button variant={me.isHost ? "secondary" : "primary"} size="lg" type="submit" disabled={busy || code.length !== cfg.session.codeLength}>
                Join Sweatbox
              </Button>
            </form>
          </section>
        </div>
      </div>
      <nav className="home__nav" aria-label="More">
        {cfg.features.replay && <Link to="/replay">Replay</Link>}
        {cfg.features.maker && me.isHost && <Link to="/maker">Maker</Link>}
      </nav>
    </main>
  );
}
