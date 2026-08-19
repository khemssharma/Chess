import { defineConfig, devices } from "@playwright/test";

/**
 * The app is served as a single origin: the Express backend (src/index.ts)
 * serves the built React app (ui/dist) as static files *and* exposes the
 * REST API + WebSocket endpoint on the same port. So there's only one URL
 * to point Playwright at â no separate frontend/backend base URLs needed.
 *
 * This suite does NOT start the app itself (`webServer`) because a real run
 * needs Postgres, Redis, and the Stockfish binary in place first â see
 * e2e/README.md and .github/workflows/ci-cd.yml for how CI brings the app
 * up before running these tests. Point E2E_BASE_URL at wherever that ends
 * up listening (defaults to http://localhost:3000, matching PORT in
 * .env.example).
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // matchmaking tests coordinate two browser contexts and rely on join order
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
