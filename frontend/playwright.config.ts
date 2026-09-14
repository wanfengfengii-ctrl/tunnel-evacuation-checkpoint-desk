import { defineConfig, devices } from "@playwright/test";

// End-to-end against the real stack. globalSetup builds the Vite app and
// starts uvicorn + `vite preview` (which proxies same-origin /api to it).
// Ports are overridable; the Docker verify service sets the same variables.
const webPort = Number(process.env.E2E_WEB_PORT ?? process.env.WEB_PORT ?? 4173);
const apiPort = Number(process.env.E2E_API_PORT ?? process.env.API_PORT ?? 8000);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    // The suites run inside containers (locally and in the verify image).
    launchOptions: {
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  metadata: { apiPort },
});
