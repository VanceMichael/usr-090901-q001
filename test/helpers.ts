import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";

const mkdtempP = promisify(mkdtemp);
const rmP = promisify(rm);

export interface Harness {
  url: string;
  port: number;
  dbPath: string;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 启动真实 HTTP 服务进程（tsx 直跑 TS），独立临时 SQLite 文件 */
export async function startHarness(label: string): Promise<Harness> {
  const dir = await mkdtempP(join(tmpdir(), `dispatch-${label}-`));
  const dbPath = join(dir, "dispatch.db");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  let child: ChildProcess | null = null;
  const logs: string[] = [];

  function spawnServer(): ChildProcess {
    const c = spawn(
      process.execPath,
      ["--experimental-sqlite", "--import", "tsx", "src/index.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SQLITE_PATH: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    c.stdout?.on("data", (d) => logs.push(d.toString()));
    c.stderr?.on("data", (d) => logs.push(d.toString()));
    return c;
  }

  async function waitReady(c: ChildProcess, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (c.exitCode !== null && c.exitCode !== 0) {
        throw new Error(`服务进程提前退出 code=${c.exitCode}\n${logs.join("")}`);
      }
      try {
        const res = await fetch(`${url}/healthz`);
        if (res.ok) return;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待服务就绪超时: ${String(lastErr)}\n${logs.join("")}`);
  }

  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async function restart(): Promise<void> {
    await stop();
    child = spawnServer();
    await waitReady(child);
  }

  child = spawnServer();
  await waitReady(child);

  return {
    url,
    port,
    dbPath,
    stop: async () => {
      await stop();
      await rmP(dir, { recursive: true, force: true });
    },
    restart,
  };
}

let seq = 0;
export function rid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function postJson(
  url: string,
  body: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

export async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

export function envelope(
  operation: string,
  caseId: string,
  payload: unknown,
  extra: Partial<{ request_id: string; actor_role: string; occurred_at: string }> = {}
) {
  return {
    request_id: extra.request_id ?? rid("req"),
    operation,
    case_id: caseId,
    actor_role: extra.actor_role ?? "reviewer",
    occurred_at: extra.occurred_at ?? nowIso(),
    payload,
  };
}
