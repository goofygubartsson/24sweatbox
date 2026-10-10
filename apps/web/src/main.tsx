import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import cfg from "@sweatbox/config/public";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/scope.css";
import "./styles/pages.css";
import { App } from "./App";

// The configured theme colours (sweatbox.config.ts colours.theme) win over the CSS defaults.
const TOKEN: Record<keyof typeof cfg.colours.theme, string> = {
  background: "--c-bg",
  scope: "--c-scope",
  surface: "--c-surface",
  surface2: "--c-surface-2",
  border: "--c-border",
  text: "--c-text",
  muted: "--c-muted",
  primary: "--c-primary",
  onPrimary: "--c-on-primary",
  danger: "--c-danger",
  ok: "--c-ok",
};
for (const [k, v] of Object.entries(cfg.colours.theme)) document.documentElement.style.setProperty(TOKEN[k as keyof typeof TOKEN], v);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
