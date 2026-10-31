import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readConfig } from '../src/config';
import type { Db } from '../src/db';
import { runRefresh } from '../src/ingest';
import * as store from '../src/store';
import { makeTestDb, rssFeed, stubFetch, testEnv, type TestDb } from './helpers';

const cfg = readConfig(testEnv);
let ctx: TestDb;
let userId: number;

beforeEach(async () => {
  ctx = await makeTestDb();
  userId = (await ctx.db.one<{ id: number }>(
    "insert into users (username) values ('ingest-regression') returning id::int",
  ))!.id;
});

afterEach(async () => { await ctx.close(); });

async function seedFeed(): Promise<number> {
  const id = await store.upsertFeed(ctx.db, 'https://example.com/feed', {});
  await store.subscribe(ctx.db, userId, id, null, null);
  return id;
}

describe('ingestion regressions', () => {
  test('concurrent refresh requests claim an eligible feed only once', async () => {
    await seedFeed();
    let requests = 0;
    const fetchImpl = stubFetch(async () => {
      requests += 1;
      return new Response(null, { status: 304 });
    });
    const reports = await Promise.all([
      runRefresh(ctx.db, cfg, { fetchImpl }),
      runRefresh(ctx.db, cfg, { fetchImpl }),
    ]);
    expect(requests).toBe(1);
    expect(reports.reduce((sum, report) => sum + report.processed, 0)).toBe(1);
  });

  test('selecting a specific feed does not bypass its due time or active lease', async () => {
    const feedId = await seedFeed();
    let requests = 0;
    const fetchImpl = stubFetch(async () => {
      requests += 1;
      return new Response(null, { status: 304 });
    });
    const first = await runRefresh(ctx.db, cfg, { feedId, fetchImpl });
    const second = await runRefresh(ctx.db, cfg, { feedId, fetchImpl });
    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(requests).toBe(1);
  });

  test('entry persistence failures update feed error state and exponential retry delay', async () => {
    const feedId = await seedFeed();
    const failingDb: Db = {
      ...ctx.db,
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (sql.includes('insert into entries')) throw new Error('entry write rejected');
        return ctx.db.query<T>(sql, params);
      },
    };
    const fetchImpl = stubFetch(() => new Response(rssFeed([{ id: '1', title: 'Example' }]), {
      headers: { etag: '"new-version"' },
    }));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await store.scheduleFeed(ctx.db, feedId);
      const report = await runRefresh(failingDb, cfg, { fetchImpl });
      expect(report.errors).toBe(1);
      const state = await ctx.db.one<{
        error_count: number; last_error: string | null; retry_seconds: number; etag: string | null;
      }>(`select error_count, last_error, etag,
        extract(epoch from (next_fetch_at - last_fetch_at))::float8 as retry_seconds
        from feeds where id = $1`, [feedId]);
      expect(state?.error_count).toBe(attempt);
      expect(state?.last_error).toContain('entry write rejected');
      expect(state?.retry_seconds).toBe(cfg.fetchIntervalMinutes * 60 * 2 ** (attempt - 1));
      expect(state?.etag).toBeNull();
    }
  });

  test('a refresh passes its remaining wall-clock budget into the fetch timeout', async () => {
    await seedFeed();
    const started = Date.now();
    let now = started;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const timeouts: number[] = [];
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    const slowDb: Db = {
      ...ctx.db,
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = await ctx.db.query<T>(sql, params);
        // The first database operation has used most of the total budget.
        if (sql.includes('from feeds f')) now = started + 19_000;
        return rows;
      },
    };
    try {
      await runRefresh(slowDb, cfg, {
        deadlineMs: 20_000,
        fetchImpl: stubFetch(() => new Response(null, { status: 304 })),
      });
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeLessThanOrEqual(1_000);
    } finally {
      clock.mockRestore();
      timeout.mockRestore();
    }
  });

  test('an exhausted refresh budget does not start another network request', async () => {
    await seedFeed();
    const started = Date.now();
    let now = started;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    let requests = 0;
    const slowDb: Db = {
      ...ctx.db,
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = await ctx.db.query<T>(sql, params);
        if (sql.includes('from feeds f')) now = started + 20_000;
        return rows;
      },
    };
    try {
      await runRefresh(slowDb, cfg, {
        deadlineMs: 20_000,
        fetchImpl: stubFetch(() => { requests += 1; return new Response(null, { status: 304 }); }),
      });
      expect(requests).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
