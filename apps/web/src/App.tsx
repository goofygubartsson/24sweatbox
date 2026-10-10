import { useEffect } from "react";
import cfg from "@sweatbox/config/public";
import { SESSION_CODE_RE } from "@sweatbox/shared";
import { usePath, navigate } from "./lib/router";
import { useAuth } from "./lib/auth";
import { Toaster } from "./components/Toast";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { ScopePage } from "./pages/ScopePage";
import { ReplayPage } from "./pages/ReplayPage";
import { MakerPage } from "./pages/maker/MakerPage";

function NotFound() {
  return (
    <div className="page">
      <Header />
      <main className="page__main">
        <p>
          That page doesn't exist. <a href="/">Back to the start</a>
        </p>
      </main>
    </div>
  );
}

export function App() {
  const path = usePath();
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // the Discord redirect normally reaches the API directly; if a proxy served this app instead, forward it
    if (path === "/auth/callback") location.replace(`${cfg.app.apiBase}/auth/callback${location.search}`);
  }, [path]);

  useEffect(() => {
    document.title = path.startsWith("/s/") ? `${path.slice(3)} · ${cfg.app.name}` : cfg.app.name;
  }, [path]);

  let page: JSX.Element;
  const session = /^\/s\/([^/]+)$/.exec(path);
  if (path === "/") page = <Home />;
  else if (session) {
    if (!SESSION_CODE_RE.test(session[1]!)) {
      navigate("/", true);
      page = <Home />;
    } else page = <ScopePage key={session[1]} code={session[1]!} />;
  } else if (path === "/replay" && cfg.features.replay) page = <ReplayPage />;
  else if (path === "/maker" && cfg.features.maker) page = <MakerPage />;
  else if (path === "/auth/callback") page = <div className="page" />;
  else page = <NotFound />;

  return (
    <>
      {page}
      <Toaster />
    </>
  );
}
