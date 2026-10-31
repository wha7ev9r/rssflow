/** Thin PostgreSQL access layer: works with Hyperdrive-backed `pg` and PGlite in tests. */

import { Client } from 'pg';

export type QueryRunner = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount: number | null }>;

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
  value<T = unknown>(text: string, params?: unknown[]): Promise<T | null>;
  /** Run a write and return the affected row count. */
  execute(text: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export function createDb(run: QueryRunner): Db {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const result = await run(text, params);
      return result.rows as T[];
    },
    async one<T>(text: string, params: unknown[] = []): Promise<T | null> {
      const rows = await this.query<T>(text, params);
      return rows.length > 0 ? (rows[0] as T) : null;
    },
    async value<T>(text: string, params: unknown[] = []): Promise<T | null> {
      const row = await this.one<Record<string, unknown>>(text, params);
      if (!row) return null;
      const values = Object.values(row);
      return (values.length > 0 ? (values[0] as T) : null);
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      const result = await run(text, params);
      return result.rowCount ?? 0;
    },
    async close(): Promise<void> {
      /* no-op: connection lifecycle is owned by connectPg */
    },
  };
}

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

/**
 * One short-lived client per request. Hyperdrive keeps the real pool to the
 * origin database, so this is the recommended pattern on Workers.
 */
export function connectPg(connectionString: string): DbHandle {
  const client = new Client({
    connectionString,
    application_name: 'buffy-reader',
    connectionTimeoutMillis: 15_000,
    query_timeout: 20_000,
  });

  let connecting: Promise<void> | null = null;
  const ensureConnected = (): Promise<void> => {
    if (!connecting) connecting = client.connect().then(() => undefined);
    return connecting;
  };

  const db = createDb(async (text, params = []) => {
    await ensureConnected();
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount };
  });

  return {
    db,
    async close() {
      try {
        await client.end();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Small helper for `col = any($n::bigint[])` style queries. */
export function bigintArray(ids: number[]): string[] {
  return ids.map((id) => String(id));
}
