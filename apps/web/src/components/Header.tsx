import { useAuth } from "../lib/auth";
import { Link, navigate } from "../lib/router";

/** Thin top line on the inner pages: the name (home link) and the signed-in user. */
export function Header() {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  return (
    <header className="topline">
      <Link to="/" className="topline__name">
        ATC24Academy Sweatbox
      </Link>
      {me && (
        <div className="topline__user">
          <span>{me.displayName}</span>
          <button type="button" className="btn btn--ghost" onClick={() => void logout().then(() => navigate("/"))}>
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
