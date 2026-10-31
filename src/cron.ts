/** cron-job.org entry point. Keep responses tiny (64KB limit, 30s timeout). */

import { Hono, type Context } from 'hono';
import type { AppEnv } from './types';
import { runRefresh } from './ingest';
import * as store from './store';
import { boolFrom, intFrom, timingSafeEqual } from './util';

export function createCronRoutes(fetchImpl?: typeof fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/refresh', handle);
  app.post('/refresh', handle);

  async function handle(c: Context<AppEnv>) {
    const cfg = c.get('cfg');
    const db = c.get('db');

    if (!cfg.cronSecret) {
      return c.json({ ok: false, error: 'CRON_SECRET is not configured' }, 503);
    }
    const authorization = c.req.header('authorization') ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    const provided =
      bearer ?? c.req.header('x-cron-token') ?? c.req.query('token') ?? '';
    if (!timingSafeEqual(provided, cfg.cronSecret)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const started = Date.now();
    const limitParam = c.req.query('limit');
    const feedParam = c.req.query('feed');
    const report = await runRefresh(db, cfg, {
      limit: limitParam ? intFrom(limitParam, cfg.maxFeedsPerRun, 1, 20) : undefined,
      feedId: feedParam ? intFrom(feedParam, 0, 0, Number.MAX_SAFE_INTEGER) || undefined : undefined,
      fetchImpl,
    });
    const cleanup = boolFrom(c.req.query('cleanup'))
      ? await store.cleanup(db, cfg)
      : null;

    return c.json({
      ok: report.errors === 0,
      processed: report.processed,
      inserted: report.inserted,
      errors: report.errors,
      remaining: report.remaining,
      cleanup,
      ms: Date.now() - started,
      results: report.results.map((result) => ({
        feed: result.feedId,
        status: result.status,
        inserted: result.inserted,
        ...(result.error ? { error: result.error.slice(0, 160) } : {}),
      })),
    });
  }

  return app;
}
