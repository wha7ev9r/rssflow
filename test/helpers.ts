import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/index';
import { createDb, type Db } from '../src/db';
import type { Env } from '../src/config';

export interface TestDb {
  db: Db;
  lite: PGlite;
  close: () => Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
  const lite = new PGlite();
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await lite.exec(schema);
  const db = createDb(async (text, params = []) => {
    const result = await lite.query(text, params as unknown[]);
    return {
      rows: result.rows as unknown[],
      rowCount: result.affectedRows ?? result.rows.length,
    };
  });
  return {
    db,
    lite,
    close: async () => {
      await lite.close();
    },
  };
}

export const testEnv: Env = {
  // The test suite injects its own database handle; this only satisfies config checks.
  DATABASE_URL: 'postgres://test.invalid/reader',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'test-password',
  AUTH_SECRET: 'test-auth-secret-1234567890',
  CRON_SECRET: 'test-cron-secret',
  SITE_NAME: 'Test Reader',
  MAX_FEEDS_PER_RUN: '2',
  FETCH_INTERVAL_MINUTES: '15',
  MAX_ITEMS_PER_FETCH: '40',
  RETENTION_DAYS: '120',
  MAX_ENTRIES_PER_FEED: '500',
};

export function makeApp(db: Db, fetchImpl: typeof fetch) {
  return createApp({
    createDb: () => ({ db, close: async () => undefined }),
    fetchImpl,
  });
}

export function rssFeed(items: Array<{ id: string; title: string; body?: string; date?: string }>): string {
  const entries = items
    .map(
      (item) => `<item>
  <title>${item.title}</title>
  <link>https://example.com/posts/${item.id}</link>
  <guid isPermaLink="false">${item.id}</guid>
  <pubDate>${item.date ?? 'Tue, 06 Oct 2026 10:00:00 GMT'}</pubDate>
  <description><![CDATA[${item.body ?? `<p>Body of ${item.title}</p>`}]]></description>
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Feed</title>
  <link>https://example.com/</link>
  <description>Example</description>
  ${entries}
</channel></rss>`;
}

export function stubFetch(handler: () => Response | Promise<Response>): typeof fetch {
  const impl = async (): Promise<Response> => handler();
  return impl as unknown as typeof fetch;
}

export function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}
