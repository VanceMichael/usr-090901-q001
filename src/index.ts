import { createServer } from "node:http";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, runMigrations } from "./db.js";
import { loadPolicy } from "./policy.js";
import { createHandler } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.SQLITE_PATH ?? "/data/dispatch.db";

// 兼容两种布局：源码 src/index.ts（../migrations）与编译产物 dist/src/index.js（../../migrations）
function resolveMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "migrations"), join(here, "..", "..", "migrations")];
  return candidates.find((p) => existsSync(join(p, "001_init.sql"))) ?? candidates[0]!;
}
const MIGRATIONS_DIR = resolveMigrationsDir();

const policy = loadPolicy();
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
runMigrations(db, MIGRATIONS_DIR);

const server = createServer(createHandler(db, policy));

server.on("error", (err) => {
  console.error("server error:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      msg: "dispatch service listening",
      host: HOST,
      port: PORT,
      db: DB_PATH,
      policy_version: policy.version,
    })
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  // 强制兜底，避免挂起
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
