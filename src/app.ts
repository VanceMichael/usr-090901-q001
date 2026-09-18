import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { getPolicy } from "./policy.js";
import { TriageService } from "./service.js";
import { createRequestHandler } from "./http.js";

const here = dirname(fileURLToPath(import.meta.url));

export function defaultPolicyPath(): string {
  if (process.env.POLICY_PATH) return process.env.POLICY_PATH;
  const candidates = [join(here, "..", "config", "policy.json"), join(here, "..", "..", "config", "policy.json")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("找不到 config/policy.json，请设置 POLICY_PATH");
  return found;
}

export interface BootstrapOptions {
  dbPath?: string;
  policyPath?: string;
  now?: () => Date;
}

export function bootstrap(opts: BootstrapOptions = {}): {
  server: Server;
  service: TriageService;
  db: ReturnType<typeof openDb>;
} {
  const dbPath = opts.dbPath ?? process.env.DB_PATH ?? join(process.cwd(), "data", "triage.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const policyPath = opts.policyPath ?? defaultPolicyPath();
  const migrationsDir = process.env.MIGRATIONS_DIR ?? join(here, "migrations");
  const db = openDb(dbPath, migrationsDir);
  const policy = getPolicy(policyPath);
  const service = new TriageService(db, policy, opts.now);
  const server = createServer(createRequestHandler({ service, policy, clock: opts.now ?? (() => new Date()) }));
  return { server, service, db };
}

export function listen(server: Server, port: number, host = "0.0.0.0"): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve());
  });
}
