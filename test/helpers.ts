import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import type { AddressInfo } from "node:net";
import { bootstrap } from "../src/app.ts";
import type { Server } from "node:http";
import type Database from "better-sqlite3";

export interface Harness {
  base: string;
  db: Database.Database;
  server: Server;
  setNow: (d: Date) => void;
  getNow: () => Date;
  close: () => void;
}

let current: Harness | null = null;

export function startHarness(initial = new Date("2026-09-10T02:00:00Z")): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
  const dbPath = join(dir, "test.db");
  let now = initial;
  const { server, db } = bootstrap({
    dbPath,
    now: () => now,
  });
  const setNow = (d: Date) => {
    now = d;
  };
  const getNow = () => now;

  const close = () => {
    server.closeAllConnections?.();
    server.close();
    db.close();
  };

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      current = { base, db, server, setNow, getNow, close };
      resolve(current);
    });
  });
}

afterEach(() => {
  if (current) {
    current.close();
    current = null;
  }
});

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  return { status: res.status, body: json };
}

let seq = 0;
export function rid(prefix = "req"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function envelope(over: Record<string, unknown>): Record<string, unknown> {
  const { case_id, ...payloadOver } = over;
  return {
    request_id: rid(),
    operation: "register_case",
    case_id: typeof case_id === "string" ? case_id : `case-${seq}`,
    actor_role: "reviewer",
    occurred_at: "2026-09-10T09:55:00+08:00",
    payload: {
      source_channel: "user_report",
      retention_days: 30,
      ...payloadOver,
    },
  };
}
