// Airport + Position + Runway format. The server generates the sweatbox file from these, so the
// trainer never builds or edits a file. Used by Create Sweatbox (home) and Load sweatbox (session).
import { useMemo, useState, type FormEvent } from "react";
import { POSITIONS, generatorAirports, hasGroundMap, needsGroundMap, runwayFormats, type GenerateSpec, type Position } from "@sweatbox/shared";
import { loadJson, saveJson } from "../lib/storage";
import { Button } from "./Button";

const POSITION_NAMES: Record<Position, string> = {
  DEL: "Delivery",
  GND: "Ground",
  TWR: "Tower",
  APP: "Approach",
  CTR: "Centre",
};

const available = (apt: string, p: Position) => !needsGroundMap(p) || hasGroundMap(apt);

function sanitize(raw: unknown): GenerateSpec | null {
  const r = raw as Partial<GenerateSpec> | null;
  if (!r || typeof r.apt !== "string" || typeof r.position !== "string" || typeof r.runway !== "string") return null;
  if (!generatorAirports().some((a) => a.code === r.apt) || !POSITIONS.includes(r.position as Position)) return null;
  return { apt: r.apt, position: r.position as Position, runway: r.runway };
}

function initial(): GenerateSpec {
  const last = loadJson<GenerateSpec | null>("generate.last", null, sanitize);
  const apt = last?.apt ?? generatorAirports()[0]?.code ?? "IRFD";
  const formats = runwayFormats(apt);
  return {
    apt,
    position: last && available(apt, last.position) ? last.position : "TWR",
    runway: formats.some((f) => f.id === last?.runway) ? last!.runway : (formats[0]?.id ?? ""),
  };
}

export function GenerateForm({ submitLabel, busy, error, onSubmit }: { submitLabel: string; busy?: boolean; error?: string | null; onSubmit: (spec: GenerateSpec) => void }) {
  const [spec, setSpec] = useState<GenerateSpec>(initial);
  const airports = useMemo(() => generatorAirports(), []);
  const formats = runwayFormats(spec.apt);

  const setAirport = (apt: string) => {
    const f = runwayFormats(apt);
    setSpec((s) => ({
      apt,
      position: available(apt, s.position) ? s.position : "TWR",
      runway: f.some((x) => x.id === s.runway) ? s.runway : (f[0]?.id ?? ""),
    }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveJson("generate.last", spec);
    onSubmit(spec);
  };

  return (
    <form className="form" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="gen-apt">
          Airport
        </label>
        <select id="gen-apt" className="field field--lg" style={{ width: "100%" }} value={spec.apt} onChange={(e) => setAirport(e.target.value)}>
          {airports.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="gen-pos">
          Position
        </label>
        <select
          id="gen-pos"
          className="field field--lg"
          style={{ width: "100%" }}
          value={spec.position}
          onChange={(e) => setSpec((s) => ({ ...s, position: e.target.value as Position }))}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p} disabled={!available(spec.apt, p)}>
              {POSITION_NAMES[p]} ({p}){available(spec.apt, p) ? "" : ": needs a ground map"}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="gen-rwy">
          Runway format
        </label>
        <select id="gen-rwy" className="field field--lg" style={{ width: "100%" }} value={spec.runway} onChange={(e) => setSpec((s) => ({ ...s, runway: e.target.value }))}>
          {formats.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="error-text" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <Button variant="primary" size="lg" type="submit" disabled={busy || !spec.runway}>
        {busy ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
