import cfg from "@sweatbox/config/public";
import type { Vec } from "@sweatbox/shared";

/** World (map units) <-> screen (CSS px). zoom = CSS px per map unit. */
export class Camera {
  cx = -3;
  cy = 20;
  zoom = cfg.ui.defaultZoom;
  w = 800;
  h = 600;

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.zoom + this.w / 2, (y - this.cy) * this.zoom + this.h / 2];
  }

  toWorld(sx: number, sy: number): Vec {
    return { x: (sx - this.w / 2) / this.zoom + this.cx, y: (sy - this.h / 2) / this.zoom + this.cy };
  }

  /** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(cfg.ui.minZoom, Math.min(cfg.ui.maxZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.zoom;
    this.cy -= dy / this.zoom;
  }

  set(cx: number, cy: number, zoom: number): void {
    this.cx = cx;
    this.cy = cy;
    this.zoom = Math.max(cfg.ui.minZoom, Math.min(cfg.ui.maxZoom, zoom));
  }

  snapshot(): { cx: number; cy: number; zoom: number } {
    return { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  key(): string {
    return `${this.cx.toFixed(5)}|${this.cy.toFixed(5)}|${this.zoom.toFixed(5)}|${this.w}|${this.h}`;
  }
}
