import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface Migration {
  version: string;
  sql: string;
}

export function loadMigrations(migrationsDir: string): Migration[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      version: f.replace(/\.sql$/, ""),
      sql: readFileSync(join(migrationsDir, f), "utf8"),
    }));
}

export function openDb(dbPath: string, migrationsDir?: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (migrationsDir) {
    runMigrations(db, migrationsDir);
  }
  return db;
}

export function runMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: string }).version),
  );
  const migrations = loadMigrations(migrationsDir);
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString(),
      );
    });
    tx();
    // eslint-disable-next-line no-console
    console.log(`[db] 迁移已应用: ${m.version}`);
  }
}

export { here };
