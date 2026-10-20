// ATC24Academy pieces for hosts: their booked sessions (home page) and the pass / fail form.
import { useEffect, useState, type FormEvent } from "react";
import type { AcademyView } from "@sweatbox/shared";
import { api } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { when } from "../pages/AcademyPage";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { toast } from "./Toast";

const DELIVERY: Record<string, string> = { pending: "sending", delivered: "sent to the academy", failed: "delivery failed: tell staff" };

/** The host's bookings: start them when it's time. Renders nothing without any. */
export function AcademySessions() {
  const [list, setList] = useState<AcademyView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.academySessions().then(setList, () => setList([]));
  }, []);

  if (!list?.length) return null;

  const start = async (v: AcademyView) => {
    setBusy(v.id);
    try {
      navigate(`/s/${(await api.academyStart(v.id)).code}`);
    } catch (e) {
      toast((e as Error).message, "error", 6000);
      setBusy(null);
    }
  };

  return (
    <section className="academy-list" aria-labelledby="academy-title">
      <h2 id="academy-title">ATC24Academy sessions</h2>
      <ul>
        {list.map((v) => (
          <li key={v.id}>
            <div className="grow">
              <div>
                {when(v.scheduledAt)} · <strong>{v.student}</strong>
              </div>
              <div className="muted">
                {v.course}: {v.module}
                {v.status !== "reserved" && ` · ${v.status === "cancelled" ? "cancelled" : `${v.outcome}, ${DELIVERY[v.resultDelivery ?? "pending"]}`}`}
              </div>
              {v.inviteStatus === "failed" && v.inviteError && <div className="error-text">Invite failed: {v.inviteError}</div>}
            </div>
            <Link to={`/academy/${v.id}`}>Details</Link>
            {v.status === "reserved" && (
              <Button variant="primary" disabled={busy !== null} onClick={() => void start(v)}>
                {v.liveCode ? "Open" : "Start"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pass / fail (with an optional score and feedback): ends the session and reports to the academy. */
export function ResultModal({ view, onClose, onDone }: { view: AcademyView; onClose: () => void; onDone: (v: AcademyView) => void }) {
  const [outcome, setOutcome] = useState<"pass" | "fail" | null>(null);
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scoreOk = score === "" || (/^\d{1,3}$/.test(score) && Number(score) <= 100);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!outcome || !scoreOk) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.academyComplete(view.id, { outcome, score: score === "" ? null : Number(score), feedback: feedback.trim() || null });
      toast("Result recorded: it goes to ATC24Academy now", "ok", 5000);
      onDone(v);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Result for ${view.student}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!outcome || !scoreOk || busy} onClick={() => void submit()}>
            Record result and end session
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void submit(e)}>
        <p className="muted" style={{ margin: 0 }}>
          {view.course}: {view.module}. The result is final and is sent to ATC24Academy.
        </p>
        {view.passingCriteria && (
          <p style={{ margin: 0 }}>
            <span className="label">Passing criteria</span>
            {view.passingCriteria}
          </p>
        )}
        <div className="row" role="radiogroup" aria-label="Outcome">
          {(["pass", "fail"] as const).map((o) => (
            <Button key={o} variant={outcome === o ? (o === "pass" ? "primary" : "danger") : "secondary"} active={outcome === o} onClick={() => setOutcome(o)}>
              {o === "pass" ? "Pass" : "Fail"}
            </Button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="academy-score">
            Score (optional, 0-100)
          </label>
          <input id="academy-score" className="field" inputMode="numeric" maxLength={3} value={score} onChange={(e) => setScore(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div>
          <label className="label" htmlFor="academy-feedback">
            Feedback for the student (optional)
          </label>
          <textarea id="academy-feedback" className="field" rows={5} maxLength={5000} style={{ width: "100%", resize: "vertical" }} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </div>
        {error && (
          <p className="error-text" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
