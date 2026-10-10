import { defineConfig, devices } from "@playwright/test";

// End-to-end tests: starts the API (development mode, throwaway database) and the Vite dev server.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "npx tsx apps/server/src/index.ts",
      url: "http://127.0.0.1:3000/api/health",
      env: { NODE_ENV: "development", DEV_FAKE_USER: "", DB_PATH: "./var/e2e.sqlite", PORT: "3000" },
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: "node apps/web/node_modules/vite/bin/vite.js apps/web",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
