import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/**
 * Process control for the real end-to-end stack. globalSetup starts one
 * uvicorn (with a fresh SQLite file) and one Vite preview server; tests can
 * hard-restart the API at will. Pids are written under E2E_RUN_DIR so a
 * restart issued from a worker process (Playwright runs globalSetup and test
 * files in different processes) can still stop the daemon reliably.
 */

const runDir = process.env.E2E_RUN_DIR ?? path.join(process.cwd(), ".e2e-run");
const apiPort = Number(process.env.E2E_API_PORT ?? process.env.API_PORT ?? 8000);
const webPort = Number(process.env.E2E_WEB_PORT ?? process.env.WEB_PORT ?? 4173);
const dbPath = process.env.DRILL_DB_PATH ?? path.join(runDir, "drill.db");
const repoRoot = path.resolve(process.cwd(), "..");
const backendDir = path.join(repoRoot, "backend");
const pythonBin = process.env.PYTHON_BIN ?? "python3";

const apiPidFile = path.join(runDir, "api.pid");
const apiLogFile = path.join(runDir, "api.log");
const webPidFile = path.join(runDir, "web.pid");
const webLogFile = path.join(runDir, "web.log");

let apiProc: ChildProcess | null = null;
let webProc: ChildProcess | null = null;

export const ports = { api: apiPort, web: webPort };
export const paths = { runDir, dbPath, apiLogFile, webLogFile };

export function ensureRunDir() {
  mkdirSync(runDir, { recursive: true });
}

async function waitForHttp(url: string, name: string, retries = 120) {  for (let attempt = 0; attempt < retries; attempt += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = existsSync(apiLogFile) ? await readFile(apiLogFile, "utf8") : "";
  throw new Error(`${name} never became ready at ${url}\n${log}`);
}

async function waitForPortFree(port: number, retries = 100) {
  for (let i = 0; i < retries; i += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(false);
      });
      sock.on("error", () => resolve(true));
      sock.setTimeout(500, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (free) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`port ${port} never released`);
}

async function waitForProcessDead(proc: ChildProcess | null, pid?: number) {
  if (proc) {
    if (proc.exitCode === null) {
      await new Promise<void>((resolve) => proc!.once("exit", () => resolve()));
    }
  } else if (pid) {
    for (let i = 0; i < 100; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // ESRCH = gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function stopWithPid(pidFile: string, proc: ChildProcess | null) {
  let pid: number | undefined;
  if (existsSync(pidFile)) {
    pid = Number((await readFile(pidFile, "utf8")).trim()) || undefined;
  }
  if (proc && proc.exitCode === null) {
    proc.kill("SIGTERM");
  } else if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await waitForProcessDead(proc, pid).catch(() => undefined);
  // Escalate if still alive.
  if (proc && proc.exitCode === null) proc.kill("SIGKILL");
  else if (pid) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      await waitForProcessDead(null, pid).catch(() => undefined);
    } catch {
      /* gone */
    }
  }
  rmSync(pidFile, { force: true });
}

export async function startApi() {
  ensureRunDir();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const out = openSync(apiLogFile, "a");
  const proc = spawn(
    pythonBin,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
    {
      cwd: backendDir,
      env: { ...process.env, DRILL_DB_PATH: dbPath, PYTHONPATH: backendDir },
      stdio: ["ignore", out, out],
    },
  );
  apiProc = proc;
  await writeFile(apiPidFile, String(proc.pid));
  await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, "API");
}

export async function stopApi() {
  await stopWithPid(apiPidFile, apiProc);
  apiProc = null;
  await waitForPortFree(apiPort);
}

/** Kill API, delete the SQLite file (and WAL/SHM), start again. */
export async function resetApi() {
  await stopApi();
  ensureRunDir();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(dbPath + suffix, { force: true });
  }
  await startApi();
}

export async function startWeb() {
  ensureRunDir();
  const out = openSync(webLogFile, "a");
  const proc = spawn("npm", ["run", "preview"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_PORT: String(webPort),
      API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
    stdio: ["ignore", out, out],
  });
  webProc = proc;
  await writeFile(webPidFile, String(proc.pid));
  await waitForHttp(`http://127.0.0.1:${webPort}/`, "Web");
}

export async function stopWeb() {
  await stopWithPid(webPidFile, webProc);
  webProc = null;
}
