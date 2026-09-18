import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  // WAL 让重启后队列与清理计划可靠落盘，并允许健康检查并发读取
  const db = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA synchronous=FULL");
  return db;
}

/** 在事务中执行 work；抛出则整体回滚（登记与清理共用此保证） */
export function transaction<T>(db: DB, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 顺序执行未应用的迁移，迁移本身在事务内，失败不留半张表 */
export function runMigrations(db: DB, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);

  const rows = db.prepare("SELECT version FROM schema_migrations").all() as {
    version: number;
  }[];
  const applied = new Set(rows.map((r) => r.version));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isInteger(version)) throw new Error(`非法迁移文件名: ${file}`);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        version,
        file
      );
    });
  }
}
