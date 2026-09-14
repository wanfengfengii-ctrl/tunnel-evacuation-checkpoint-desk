import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import {
  paths,
  ports,
  resetApi,
  startWeb,
  stopApi,
  stopWeb,
} from "./server-ctl";

/**
 * Brings up the real stack for the browser suite:
 *   1. build the production Vite bundle,
 *   2. start uvicorn with a fresh SQLite database,
 *   3. start `vite preview` which proxies same-origin /api to uvicorn.
 * The returned teardown stops both. Tests restart the API themselves to prove
 * durability across a real process restart.
 */
export default async function globalSetup(_config: FullConfig) {
  rmSync(paths.runDir, { recursive: true, force: true });

  const build = spawnSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (build.status !== 0) throw new Error("frontend build failed");

  await resetApi();
  await startWeb();

  console.log(
    `E2E stack ready: web http://127.0.0.1:${ports.web}, api http://127.0.0.1:${ports.api}`,
  );

  return async () => {
    await stopWeb();
    await stopApi();
  };
}
