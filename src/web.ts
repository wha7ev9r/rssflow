/** Web UI routes. */

import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  authenticate,
  issueAuthToken,
  issueSessionToken,
  requireWebAuth,
  SESSION_COOKIE,
  verifyCredentials,
} from './auth';
import type { AppEnv } from './types';
import { normalizeFeedUrl, subscribeToUrl } from './ingest';
import { exportOpml, parseOpml } from './opml';
import * as store from './store';
import { streamFromQuery, type Stream } from './stream';
import { b64urlDecodeText, b64urlEncode, intFrom } from './util';
import {
  errorPage,
  feedsPage,
  itemPage,
  listPage,
  loginPage,
  settingsPage,
} from './views';

function safeNext(value: string | null | undefined): string {
  const candidate = (value ?? '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(candidate)) {
    return '/';
  }
  // Validate with the same URL normalization the browser will use for Location.
  const base = 'https://reader.invalid';
  try {
    return new URL(candidate, base).origin === base ? candidate : '/';
  } catch {
    return '/';
  }
}

function encodeCursor(entry: store.EntryRow): string {
  return b64urlEncode(JSON.stringify({ ms: Math.round(entry.published_ms), id: entry.id }));
}

function decodeCursor(value: string | undefined): { ms: number; id: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(b64urlDecodeText(value)) as { ms?: unknown; id?: unknown };
    const ms = Number(parsed.ms);
    const id = Number(parsed.id);
    if (!Number.isFinite(ms) || !Number.isFinite(id)) return null;
    return { ms, id };
  } catch {
    return null;
  }
}

function streamHref(stream: Stream): string {
  if (stream.kind === 'unread') return '/?stream=unread';
  if (stream.kind === 'starred') return '/?stream=starred';
  if (stream.kind === 'feed') return `/?feed=${encodeURIComponent(stream.ref)}`;
  if (stream.kind === 'label') return `/?folder=${encodeURIComponent(stream.label)}`;
  return '/';
}

function safeFlash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function sameOrigin(referer: string | undefined, currentUrl: string): boolean {
  if (!referer) return false;
  try {
    return new URL(referer).origin === new URL(currentUrl).origin;
  } catch {
    return false;
  }
}

export function createWebRoutes(fetchImpl?: typeof fetch): Hono<AppEnv> {
  const web = new Hono<AppEnv>();

  web.get('/login', async (c) => {
    const cfg = c.get('cfg');
    const existing = await authenticate(c.get('db'), cfg, {
      header: (name) => c.req.header(name),
      query: (name) => c.req.query(name),
      cookie: (name) => {
        const header = c.req.header('cookie') ?? '';
        const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
        if (!match) return undefined;
        try {
          return decodeURIComponent(match[1] as string);
        } catch {
          return match[1] as string;
        }
      },
    });
    if (existing) return c.redirect('/');
    return c.html(
      loginPage(cfg, { error: null, next: safeNext(c.req.query('next')) }),
    );
  });

  web.post('/login', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const body = await c.req.parseBody();
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    const next = safeNext(typeof body.next === 'string' ? body.next : '/');
    const user = await verifyCredentials(db, cfg, username, password);
    if (!user) {
      return c.html(
        loginPage(cfg, { error: '用户名或密码错误', next }),
        401,
      );
    }
    const token = await issueSessionToken(cfg, user);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      secure: new URL(c.req.url).protocol === 'https:',
    });
    await db.execute('update users set last_login_at = now() where id = $1', [user.id]);
    return c.redirect(next);
  });

  web.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // Auth is applied to the UI routes only, so /api/cron and the Google Reader
  // endpoints mounted at the root are not captured by this wildcard.
  for (const path of [
    '/',
    '/item/*',
    '/api/state',
    '/mark-all-read',
    '/refresh',
    '/feeds',
    '/feeds/*',
    '/opml',
    '/settings',
  ]) {
    web.use(path, requireWebAuth);
  }

  web.get('/', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const search = (c.req.query('q') ?? '').trim().slice(0, 200);
    const stream = streamFromQuery({
      stream: c.req.query('stream'),
      feed: c.req.query('feed'),
      folder: c.req.query('folder'),
    });
    const cursor = decodeCursor(c.req.query('c'));
    const limit = intFrom(c.req.query('n'), 30, 1, 100);

    const [{ entries, hasMore }, subscriptions, starred] = await Promise.all([
      store.listEntries(db, user.id, { stream, search: search || null, before: cursor, limit }),
      store.listSubscriptions(db, user.id),
      store.starredCount(db, user.id),
    ]);

    const totalUnread = store.totalUnread(subscriptions);
    let heading = '全部文章';
    if (stream.kind === 'unread') heading = '未读';
    if (stream.kind === 'starred') heading = '收藏';
    if (stream.kind === 'feed') {
      const match = subscriptions.find((sub) => String(sub.feed_id) === stream.ref);
      heading = match ? match.title || match.feed_title || match.url : '订阅源';
    }
    if (stream.kind === 'label') heading = stream.label;
    if (search) heading = `搜索：${search}`;

    const subheading = `${subscriptions.length} 个订阅 · ${totalUnread} 篇未读 · ${starred} 篇收藏`;
    const last = entries[entries.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;

    return c.html(
      listPage({
        cfg,
        user,
        subscriptions,
        totalUnread,
        starred,
        stream,
        heading,
        subheading,
        entries,
        hasMore,
        cursor: nextCursor,
        search,
      }),
    );
  });

  web.get('/item/:id', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const entry = await store.getEntryByItemId(db, user.id, c.req.param('id'));
    if (!entry) {
      return c.html(errorPage('找不到这篇文章', '它可能已被清理，或链接已失效。', cfg), 404);
    }
    if (!entry.read) {
      await store.setEntryStateByItemIds(db, user.id, [entry.item_id], true, null);
      entry.read = true;
    }
    const [subscriptions, starred] = await Promise.all([
      store.listSubscriptions(db, user.id),
      store.starredCount(db, user.id),
    ]);
    return c.html(
      itemPage({
        cfg,
        user,
        subscriptions,
        totalUnread: store.totalUnread(subscriptions),
        starred,
        entry,
      }),
    );
  });

  web.post('/item/:id/state', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const body = await c.req.parseBody();
    const readValue = body.read;
    const starredValue = body.starred;
    const read = readValue === 'true' ? true : readValue === 'false' ? false : null;
    const starred =
      starredValue === 'true' ? true : starredValue === 'false' ? false : null;
    await store.setEntryStateByItemIds(db, user.id, [c.req.param('id')], read, starred);
    // Opening an article marks it read; do not reopen it after marking it unread.
    if (read === false) return c.redirect('/?stream=unread');
    const referer = c.req.header('referer');
    return c.redirect(
      sameOrigin(referer, c.req.url)
        ? (referer as string)
        : `/item/${encodeURIComponent(c.req.param('id'))}`,
    );
  });

  web.post('/api/state', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    if (c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'Expected application/json' }, 415);
    }
    let payload: Record<string, unknown>;
    try {
      const value: unknown = await c.req.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return c.json({ error: 'Expected a JSON object' }, 400);
      }
      payload = value as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const ids = Array.isArray(payload.ids)
      ? payload.ids.map((value) => String(value)).filter(Boolean).slice(0, 200)
      : [];
    if (ids.length === 0) return c.json({ error: 'Missing ids' }, 400);
    const read = typeof payload.read === 'boolean' ? payload.read : null;
    const starred = typeof payload.starred === 'boolean' ? payload.starred : null;
    const updated = await store.setEntryStateByItemIds(db, user.id, ids, read, starred);
    return c.json({ ok: true, updated });
  });

  web.post('/mark-all-read', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const body = await c.req.parseBody();
    const stream = streamFromQuery({
      stream: typeof body.stream === 'string' ? body.stream : null,
      feed: typeof body.feed === 'string' ? body.feed : null,
      folder: typeof body.folder === 'string' ? body.folder : null,
    });
    const search = typeof body.q === 'string' ? body.q.trim() : '';
    await store.markAllRead(db, user.id, stream, search || null, Date.now());
    return c.redirect(streamHref(stream));
  });

  web.get('/feeds', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const [subscriptions, starred] = await Promise.all([
      store.listSubscriptions(db, user.id),
      store.starredCount(db, user.id),
    ]);
    const folders = [...new Set(subscriptions.map((sub) => sub.folder).filter((folder): folder is string => !!folder))];
    return c.html(
      feedsPage({
        cfg,
        user,
        subscriptions,
        totalUnread: store.totalUnread(subscriptions),
        starred,
        folders,
        flash: safeFlash(c.req.query('msg')),
      }),
    );
  });

  web.post('/feeds/add', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const body = await c.req.parseBody();
    const url = String(body.url ?? '');
    const folder = String(body.folder ?? '').trim() || null;
    try {
      const result = await subscribeToUrl(db, cfg, user.id, url, { folder, fetchImpl });
      const message = result.warning ?? `已添加：${result.title}`;
      return c.redirect(`/feeds?msg=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '添加失败';
      return c.redirect(`/feeds?msg=${encodeURIComponent(message)}`);
    }
  });

  web.post('/feeds/:id/update', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const feedId = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(feedId)) return c.redirect('/feeds');
    const body = await c.req.parseBody();
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
    await store.updateSubscription(db, user.id, feedId, {
      title: title || null,
      folder: folder || null,
    });
    return c.redirect(`/feeds?msg=${encodeURIComponent('已保存')}`);
  });

  web.post('/feeds/:id/delete', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const feedId = Number.parseInt(c.req.param('id'), 10);
    if (Number.isFinite(feedId)) await store.removeSubscription(db, user.id, feedId);
    return c.redirect(`/feeds?msg=${encodeURIComponent('已删除订阅')}`);
  });

  web.post('/feeds/:id/refresh', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const feedId = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(feedId)) return c.redirect('/feeds');
    const sub = await store.getSubscription(db, user.id, String(feedId));
    if (sub) await store.scheduleFeed(db, feedId);
    return c.redirect(`/feeds?msg=${encodeURIComponent('已排入抓取队列，cron 下一分钟内处理')}`);
  });

  web.post('/refresh', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    await store.scheduleAll(db, user.id);
    return c.redirect(`/feeds?msg=${encodeURIComponent('所有订阅已排入抓取队列')}`);
  });

  web.get('/opml', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const subscriptions = await store.listSubscriptions(db, user.id);
    return c.body(exportOpml(cfg.siteName, subscriptions), 200, {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': 'attachment; filename="buffy-reader.opml"',
    });
  });

  web.post('/opml', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    let text = '';
    try {
      const body = await c.req.parseBody();
      const file = body.opml;
      if (typeof file === 'string') text = file;
      else if (file && typeof file.text === 'function') text = await file.text();
    } catch {
      text = '';
    }
    if (!text.trim()) {
      return c.redirect(`/feeds?msg=${encodeURIComponent('没有读取到 OPML 内容')}`);
    }
    let feeds;
    try {
      feeds = parseOpml(text);
    } catch (error) {
      return c.redirect(
        `/feeds?msg=${encodeURIComponent(error instanceof Error ? error.message : 'OPML 解析失败')}`,
      );
    }
    let added = 0;
    for (const feed of feeds) {
      const url = normalizeFeedUrl(feed.url);
      if (!url) continue;
      try {
        const feedId = await store.upsertFeed(db, url, { title: feed.title ?? null });
        await store.subscribe(db, user.id, feedId, feed.title ?? null, feed.folder ?? null);
        await store.scheduleFeed(db, feedId);
        added += 1;
      } catch {
        /* skip broken entries */
      }
    }
    return c.redirect(`/feeds?msg=${encodeURIComponent(`已导入 ${added} 个订阅，抓取会在后台进行`)}`);
  });

  web.get('/settings', async (c) => {
    const cfg = c.get('cfg');
    const db = c.get('db');
    const user = c.get('user');
    const [subscriptions, starred, counts] = await Promise.all([
      store.listSubscriptions(db, user.id),
      store.starredCount(db, user.id),
      store.settingsCounts(db, user.id),
    ]);
    const origin = new URL(c.req.url).origin;
    const authToken = await issueAuthToken(cfg, user);
    return c.html(
      settingsPage({
        cfg,
        user,
        subscriptions,
        totalUnread: store.totalUnread(subscriptions),
        starred,
        counts,
        origin,
        authToken,
        hasHyperdrive: !!c.env.HYPERDRIVE,
        hasDatabaseUrl: !!c.env.DATABASE_URL,
        hasCronSecret: !!cfg.cronSecret,
      }),
    );
  });

  return web;
}
