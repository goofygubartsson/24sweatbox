// LDARPT view switching (spec 8.2): CTR / GND / TWR per airport, restoring the CTR camera.
import cfg from "@sweatbox/config/public";
import { airportRef, getAirport, groundLayout, runwaysOf } from "@sweatbox/shared";
import type { Camera } from "./camera";
import type { ScopeHandle } from "./ScopeView";
import { useScope } from "./store";
import type { ViewMode } from "./model";

const FIT = cfg.ui.viewFit;

/** GND view of an airport with a ground map: centre on its paved area and fit it on screen. */
function fitGroundMap(cam: Camera, icao: string): boolean {
  const pavement = groundLayout(icao)?.pavement ?? [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of pavement)
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  if (!(maxX > minX && maxY > minY)) return false;
  const fit = Math.min(cam.w / (maxX - minX), cam.h / (maxY - minY)) * FIT.gndMapFill;
  cam.set((minX + maxX) / 2, (minY + maxY) / 2, Math.min(cfg.ui.gndZoom, fit));
  return true;
}

export function switchView(icao: string, mode: ViewMode, scope: ScopeHandle | null): string | null {
  const apt = getAirport(icao);
  if (!apt) return `Unknown airport ${icao}`;
  const st = useScope.getState();
  const cam = scope?.camera;
  if (cam) {
    // remember the CTR picture when leaving it, restore it when coming back
    if (st.mode === "CTR" && mode !== "CTR") st.set({ ctrCamera: cam.snapshot() });
    const ref = airportRef(apt.code);
    if (mode === "CTR") {
      const back = st.mode !== "CTR" ? st.ctrCamera : null;
      if (back && st.apt === apt.code) cam.set(back.cx, back.cy, back.zoom);
      else if (ref) cam.set(ref.x, ref.y, Math.max(cam.zoom, cfg.ui.defaultZoom));
    } else if (mode === "GND" && fitGroundMap(cam, apt.code)) {
      // fitted to the ground map
    } else if (ref) {
      // fit the airport's runways on screen; the configured zoom is the upper limit
      const ends = runwaysOf(apt.code).flatMap((r) => [r.position1, r.position2]);
      const radius = Math.max(FIT.minExtentUnits, ...ends.map((p) => Math.hypot(p.x - ref.x, p.y - ref.y)));
      const fit = Math.min(cam.w, cam.h) / (radius * (mode === "GND" ? FIT.gndRunwayFactor : FIT.twrRunwayFactor));
      cam.set(ref.x, ref.y, Math.min(mode === "GND" ? cfg.ui.gndZoom : cfg.ui.twrZoom, fit));
    }
    scope?.invalidate();
  }
  st.setView(apt.code, mode);
  return null;
}

export const stationLabel = (apt: string | null, mode: ViewMode): string => (apt ? `${apt}_${mode}` : "----_CTR");
