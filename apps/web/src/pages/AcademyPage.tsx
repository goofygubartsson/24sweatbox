// ATC24Academy launches: /join/:token (and /join?token=) checks the student's link, then
// /academy/:id shows the booking until the host starts it (and the result afterwards).
import { useEffect, useState, type ReactNode } from "react";
import type { AcademyView } from "@sweatbox/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { navigate } from "../lib/router";
import { Button } from "../components/Button";

const POLL_MS = 10_000;

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Return to ATC24Academy": the stored returnUrl exactly as the academy sent it. */
export function ReturnLink({ url, primary }: { url: string; primary?: boolean }) {
  return (
    <a className={`btn${primary ? " btn--primary" : ""}`} href={url}>
      Return to ATC24Academy
    </a>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="home">
      <div className="home__center">
        <h1 className="home__title">ATC24Academy Sweatbox</h1>
        <div className="academy-card">{children}</div>
      </div>
    </main>
  );
}

function LoginFirst() {
  return (
    <Shell>
      <p>Log in with the Discord account linked to your ATC24Academy profile to start your session.</p>
      <a className="btn btn--primary btn--lg" href={api.loginUrl(location.pathname + location.search)}>
        Log in with Discord
      </a>
    </Shell>
  );
}

// A one-time token must be sent once, even when React runs the effect twice (StrictMode).
const launches = new Map<string, ReturnType<typeof api.academyLaunch>>();

export function JoinPage({ token }: { token: string }) {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const logout = useAuth((s) => s.logout);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!me) return;
    let p = launches.get(token);
    if (!p) launches.set(token, (p = api.academyLaunch(token)));
    let live = true;
    p.then(({ view }) => {
      if (!live) return;
      // replace: the link leaves the address bar and the back button doesn't reuse it
      navigate(view.liveCode ? `/s/${view.liveCode}` : `/academy/${view.id}`, true);
    }).catch((e: unknown) => {
      if (!live) return;
      launches.delete(token);
      setError(e instanceof ApiError ? e : new ApiError(0, "SERVER_ERROR", (e as Error).message));
    });
    return () => {
      live = false;
    };
  }, [me, token]);

  if (!loaded) return <main className="home" />;
  if (!me) return <LoginFirst />;
  if (!error)
    return (
      <Shell>
        <p className="muted">Checking your launch link…</p>
      </Shell>
    );
  return (
    <Shell>
      <p role="alert">{error.message}</p>
      <div className="row" style={{ justifyContent: "center" }}>
        {error.code === "WRONG_ACCOUNT" && (
          <Button
            onClick={async () => {
              await logout();
              location.href = api.loginUrl(location.pathname + location.search);
            }}
          >
            Switch Discord account
          </Button>
        )}
        {error.returnUrl && <ReturnLink url={error.returnUrl} primary />}
      </div>
    </Shell>
  );
}

export function AcademyPage({ id }: { id: string }) {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const [view, setView] = useState<AcademyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let live = true;
    let timer = 0;
    const load = async () => {
      try {
        const v = await api.academySession(id);
        if (!live) return;
        setView(v);
        // the student goes straight in once the host has started it
        if (v.liveCode && v.status === "reserved" && !me.isHost) return navigate(`/s/${v.liveCode}`, true);
        if (v.status === "reserved") timer = window.setTimeout(() => void load(), POLL_MS);
      } catch (e) {
        if (live) setError(e instanceof ApiError && e.status === 404 ? "This session isn't available to your account." : (e as Error).message);
      }
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id, me]);

  if (!loaded) return <main className="home" />;
  if (!me) return <LoginFirst />;
  if (error)
    return (
      <Shell>
        <p role="alert">{error}</p>
      </Shell>
    );
  if (!view)
    return (
      <Shell>
        <p className="muted">Loading…</p>
      </Shell>
    );
  return (
    <Shell>
      <h2 style={{ fontSize: "var(--fs-lg)" }}>
        {view.course}: {view.module}
      </h2>
      <dl className="summary">
        <dt>When</dt>
        <dd>{when(view.scheduledAt)}</dd>
        {view.assessmentType && (
          <>
            <dt>Assessment</dt>
            <dd>{view.assessmentType}</dd>
          </>
        )}
        {view.host && (
          <>
            <dt>Host</dt>
            <dd>{view.host}</dd>
          </>
        )}
      </dl>
      {view.instructions && (
        <section className="academy-text">
          <h3>Instructions</h3>
          <p>{view.instructions}</p>
        </section>
      )}
      {view.passingCriteria && (
        <section className="academy-text">
          <h3>Passing criteria</h3>
          <p>{view.passingCriteria}</p>
        </section>
      )}
      {view.status === "reserved" ? (
        <p className="muted" aria-live="polite">
          {view.liveCode ? "Your host has started the session." : "Waiting for your host to start the session. This page opens it as soon as they do."}
        </p>
      ) : (
        <p>{view.status === "cancelled" ? "This session was cancelled." : "This session has finished. Your result is on ATC24Academy."}</p>
      )}
      <div className="row" style={{ justifyContent: "center" }}>
        {view.liveCode && view.status === "reserved" && (
          <Button variant="primary" onClick={() => navigate(`/s/${view.liveCode}`)}>
            Open session
          </Button>
        )}
        <ReturnLink url={view.returnUrl} primary={view.status !== "reserved"} />
      </div>
    </Shell>
  );
}
