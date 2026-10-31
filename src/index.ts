/** Worker entry point. */

import { Hono } from 'hono';
import {
  configProblems,
  databaseUrl,
  readConfig,
  type Env,
} from './config';
import { connectPg, type DbHandle } from './db';
import { createCronRoutes } from './cron';
import { createGreaderRoutes } from './greader';
import { createWebRoutes } from './web';
import type { AppEnv } from './types';
import { errorPage, setupPage } from './views';

export interface AppDeps {
  createDb?: (env: Env) => DbHandle;
  fetchImpl?: typeof fetch;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();
  const makeDb = deps.createDb ?? ((env: Env) => connectPg(databaseUrl(env)));

  app.use('*', async (c, next) => {
    const cfg = readConfig(c.env);
    c.set('cfg', cfg);
    const url = new URL(c.req.url);

    if (url.pathname === '/favicon.ico') return c.body(null, 204);

    if (url.pathname === '/health') {
      if (!databaseUrl(c.env)) {
        return c.json({ ok: false, error: 'database not configured' }, 503);
      }
      const handle = makeDb(c.env);
      try {
        await handle.db.value('select 1');
        return c.json({ ok: true, time: new Date().toISOString() });
      } catch {
        return c.json({ ok: false, error: 'database unreachable' }, 503);
      } finally {
        await handle.close();
      }
    }

    const problems = configProblems(c.env);
    if (problems.length > 0) return c.html(setupPage(problems), 500);

    const handle = makeDb(c.env);
    c.set('db', handle.db);
    try {
      await next();
    } finally {
      await handle.close();
    }
  });

  app.route('/api/greader.php', createGreaderRoutes(deps.fetchImpl));
  app.route('/', createGreaderRoutes(deps.fetchImpl));
  app.route('/', createWebRoutes(deps.fetchImpl));
  app.route('/api/cron', createCronRoutes(deps.fetchImpl));

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/reader/') || c.req.path.startsWith('/accounts/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.html(errorPage('页面不存在', '请检查地址是否正确。'), 404);
  });

  app.onError((error, c) => {
    console.error('Unhandled error:', error);
    if (
      c.req.path.startsWith('/api/') ||
      c.req.path.startsWith('/reader/') ||
      c.req.path.startsWith('/accounts/')
    ) {
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    return c.html(errorPage('服务器错误', '请查看 Worker 日志了解详情。'), 500);
  });

  return app;
}

const app = createApp();

export default app;
