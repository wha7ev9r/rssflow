/** Google Reader API (v0), compatible with FreshRSS clients. */

import { Hono, type Context } from 'hono';
import {
  actionToken,
  authenticate,
  issueAuthToken,
  verifyCredentials,
} from './auth';
import type { AppEnv, User } from './types';
import { subscribeToUrl } from './ingest';
import * as store from './store';
import {
  KEPT_UNREAD,
  READ,
  READING_LIST,
  STARRED,
  feedStreamId,
  labelStreamId,
  parseStreamId,
  type Stream,
} from './stream';
import {
  b64urlDecodeText,
  b64urlEncode,
  intFrom,
  timingSafeEqual,
} from './util';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function itemJson(entry: store.EntryRow): Record<string, unknown> {
  const publishedSec = Math.floor(entry.published_ms / 1000);
  const categories: string[] = [READING_LIST];
  if (entry.folder) categories.push(labelStreamId(entry.folder));
  if (entry.read) categories.push(READ);
  if (entry.starred) categories.push(STARRED);

  return {
    id: entry.item_id,
    crawlTimeMsec: String(Math.round(entry.fetched_ms)),
    timestampUsec: String(publishedSec * 1_000_000),
    published: publishedSec,
    updated: publishedSec,
    title: entry.title ?? '',
    canonical: entry.url ? [{ href: entry.url }] : [],
    alternate: entry.url ? [{ href: entry.url, type: 'text/html' }] : [],
    summary: { content: entry.summary ?? entry.content ?? '' },
    content: { content: entry.content ?? entry.summary ?? '' },
    author: entry.author ?? '',
    origin: {
      streamId: feedStreamId(entry.feed_url),
      title: entry.feed_title,
      htmlUrl: entry.feed_site_url ?? entry.feed_url,
    },
    categories,
    ...(entry.enclosure_url
      ? {
          enclosure: [
            {
              href: entry.enclosure_url,
              type: entry.enclosure_type ?? 'application/octet-stream',
            },
          ],
        }
      : {}),
  };
}

function subscriptionJson(sub: store.SubscriptionRow): Record<string, unknown> {
  return {
    id: feedStreamId(sub.url),
    title: sub.title || sub.feed_title || sub.url,
    categories: sub.folder
      ? [{ id: labelStreamId(sub.folder), label: sub.folder }]
      : [],
    url: sub.url,
    htmlUrl: sub.site_url || sub.url,
    iconUrl: sub.icon_url || '',
  };
}

function collectParams(
  c: Context<AppEnv>,
  name: string,
  splitWhitespace = true,
): string[] {
  const values = [...(c.req.queries(name) ?? [])];
  const single = c.req.query(name);
  if (single && values.length === 0) values.push(single);
  return values
    .flatMap((value) => value.split(splitWhitespace ? /[,\s]+/ : /,/))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Tag names may contain spaces (folder names), so do not split on whitespace. */
function collectTags(c: Context<AppEnv>, name: string): string[] {
  return collectParams(c, name, false);
}

function labelFromTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const marker = '/label/';
  const index = trimmed.indexOf(marker);
  if (index >= 0) return safeDecode(trimmed.slice(index + marker.length));
  if (trimmed.includes('/state/')) return null;
  return trimmed;
}

function collectLabels(c: Context<AppEnv>, name: string): string[] {
  return collectTags(c, name)
    .map(labelFromTag)
    .filter((label): label is string => !!label);
}

function encodeContinuation(entry: store.EntryRow): string {
  return b64urlEncode(JSON.stringify({ ms: Math.round(entry.published_ms), id: entry.id }));
}

function decodeContinuation(value: string | undefined): { ms: number; id: number } | null {
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

function streamIdFromRequest(c: Context<AppEnv>): string {
  const queryStream = c.req.query('s');
  if (queryStream) return safeDecode(queryStream);
  const marker = '/stream/contents/';
  const path = c.req.path;
  const index = path.indexOf(marker);
  if (index < 0) return '';
  return safeDecode(path.slice(index + marker.length));
}

async function readTokenIsValid(c: Context<AppEnv>, user: User): Promise<boolean> {
  const provided = c.req.query('T');
  if (!provided) return true;
  const expected = await actionToken(c.get('cfg'), user);
  return timingSafeEqual(provided, expected);
}

export function createGreaderRoutes(fetchImpl?: typeof fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  app.post('/accounts/ClientLogin', async (c) => {
    const db = c.get('db');
    const cfg = c.get('cfg');
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.parseBody();
    } catch {
      body = {};
    }
    const email = String(body.Email ?? body.email ?? body.username ?? '').trim();
    const password = String(body.Passwd ?? body.passwd ?? body.password ?? '');
    const user = await verifyCredentials(db, cfg, email, password);
    if (!user) {
      return c.text('Error=BadAuthentication', 403, {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
    await db.execute('update users set last_login_at = now() where id = $1', [user.id]);
    const auth = await issueAuthToken(cfg, user);
    return c.text(`SID=${auth}\nLSID=${auth}\nAuth=${auth}\n`, 200, {
      'content-type': 'text/plain; charset=utf-8',
    });
  });

  app.get('/accounts/ClientLogin', (c) =>
    c.text('Use POST with Email and Passwd', 405),
  );

  app.use('/reader/api/0/*', async (c, next) => {
    const user = await authenticate(c.get('db'), c.get('cfg'), {
      header: (name) => c.req.header(name),
      query: (name) => c.req.query(name),
      cookie: (name) => {
        const cookie = c.req.header('cookie') ?? '';
        const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie);
        return match ? safeDecode(match[1] as string) : undefined;
      },
    });
    if (!user) {
      return c.text('Unauthorized', 401, {
        'www-authenticate': 'GoogleLogin realm="reader"',
      });
    }
    c.set('user', user);
    await next();
  });

  app.get('/reader/api/0/user-info', (c) => {
    const user = c.get('user');
    return c.json({
      userId: String(user.id),
      userName: user.username,
      userProfileId: String(user.id),
      userEmail: '',
    });
  });

  app.get('/reader/api/0/token', async (c) => {
    const token = await actionToken(c.get('cfg'), c.get('user'));
    return c.text(token, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  app.all('/reader/api/0/check', (c) => c.json({}));

  app.get('/reader/api/0/subscription/list', async (c) => {
    const subscriptions = await store.listSubscriptions(c.get('db'), c.get('user').id);
    return c.json({ subscriptions: subscriptions.map(subscriptionJson) });
  });

  app.get('/reader/api/0/tag/list', async (c) => {
    const subscriptions = await store.listSubscriptions(c.get('db'), c.get('user').id);
    const folders = new Set<string>();
    for (const sub of subscriptions) if (sub.folder) folders.add(sub.folder);
    return c.json({
      tags: [
        { id: STARRED },
        ...[...folders].map((folder) => ({ id: labelStreamId(folder) })),
      ],
    });
  });

  app.get('/reader/api/0/unread-count', async (c) => {
    const subscriptions = await store.listSubscriptions(c.get('db'), c.get('user').id);
    const total = store.totalUnread(subscriptions);
    const folders = store.folderUnread(subscriptions);
    return c.json({
      max: total,
      unreadcounts: [
        { id: READING_LIST, count: total },
        ...subscriptions.map((sub) => ({
          id: feedStreamId(sub.url),
          count: sub.unread,
        })),
        ...[...folders.entries()].map(([folder, count]) => ({
          id: labelStreamId(folder),
          count,
        })),
      ],
    });
  });

  async function contents(c: Context<AppEnv>) {
    const db = c.get('db');
    const user = c.get('user');
    const rawStreamId = streamIdFromRequest(c);
    if (!rawStreamId) return c.json({ error: 'Missing stream id' }, 400);
    const stream: Stream | null = parseStreamId(rawStreamId);
    if (!stream) return c.json({ error: 'Unknown stream' }, 400);

    const xt = (c.req.queries('xt') ?? []).join(',');
    const it = (c.req.queries('it') ?? []).join(',');
    const cursor = decodeContinuation(c.req.query('c'));
    const olderThan = Number.parseInt(c.req.query('ot') ?? '', 10);
    const newerThan = Number.parseInt(c.req.query('nt') ?? '', 10);
    const order = c.req.query('r') === 'o' ? 'asc' : 'desc';
    const before =
      cursor ??
      (Number.isFinite(olderThan) && olderThan > 0
        ? { ms: Math.floor(olderThan / 1000), id: Number.MAX_SAFE_INTEGER }
        : null);
    const afterMs =
      Number.isFinite(newerThan) && newerThan > 0 ? Math.floor(newerThan / 1000) : null;

    const { entries, hasMore } = await store.listEntries(db, user.id, {
      stream,
      search: c.req.query('q') ?? null,
      limit: intFrom(c.req.query('n'), 20, 1, 100),
      before,
      afterMs,
      order,
      unreadOnly: xt.includes('/state/com.google/read'),
      readOnly: it.includes('/state/com.google/read') && !xt.includes('/state/com.google/read'),
    });

    const last = entries[entries.length - 1];
    return c.json({
      id: rawStreamId,
      updated: Math.floor(Date.now() / 1000),
      items: entries.map(itemJson),
      ...(hasMore && last ? { continuation: encodeContinuation(last) } : {}),
    });
  }

  app.get('/reader/api/0/stream/contents', contents);
  app.get('/reader/api/0/stream/contents/*', contents);

  app.get('/reader/api/0/stream/items/contents', async (c) => {
    const ids = collectParams(c, 'i');
    const entries = await store.getEntriesByItemIds(c.get('db'), c.get('user').id, ids);
    return c.json({ items: entries.map(itemJson) });
  });

  app.get('/reader/api/0/stream/items/ids', async (c) => {
    const rawStreamId = c.req.query('s') ?? READING_LIST;
    const stream = parseStreamId(rawStreamId);
    if (!stream) return c.json({ error: 'Unknown stream' }, 400);
    const xt = (c.req.queries('xt') ?? []).join(',');
    const { entries } = await store.listEntries(c.get('db'), c.get('user').id, {
      stream,
      limit: intFrom(c.req.query('n'), 100, 1, 200),
      unreadOnly: xt.includes('/state/com.google/read'),
    });
    return c.json({
      itemRefs: entries.map((entry) => ({
        id: entry.item_id,
        timestampUsec: String(Math.floor(entry.published_ms / 1000) * 1_000_000),
        directStreamIds: [feedStreamId(entry.feed_url)],
        timestamp: Math.floor(entry.published_ms / 1000),
      })),
    });
  });

  app.post('/reader/api/0/edit-tag', async (c) => {
    const user = c.get('user');
    if (!(await readTokenIsValid(c, user))) return c.text('Invalid token', 401);
    const ids = collectParams(c, 'i');
    if (ids.length === 0) return c.text('OK');

    let read: boolean | null = null;
    let starred: boolean | null = null;
    for (const tag of collectTags(c, 'a')) {
      if (tag === READ) read = true;
      if (tag === KEPT_UNREAD) read = false;
      if (tag === STARRED) starred = true;
    }
    for (const tag of collectTags(c, 'r')) {
      if (tag === READ) read = false;
      if (tag === STARRED) starred = false;
    }
    await store.setEntryStateByItemIds(c.get('db'), user.id, ids, read, starred);
    return c.text('OK');
  });

  app.post('/reader/api/0/mark-all-as-read', async (c) => {
    const user = c.get('user');
    if (!(await readTokenIsValid(c, user))) return c.text('Invalid token', 401);
    const stream = parseStreamId(c.req.query('s') ?? READING_LIST);
    if (!stream) return c.json({ error: 'Unknown stream' }, 400);
    const rawTs = Number.parseInt(c.req.query('ts') ?? '', 10);
    const maxMs = Number.isFinite(rawTs) && rawTs > 0 ? Math.floor(rawTs / 1000) : Date.now();
    await store.markAllRead(c.get('db'), user.id, stream, c.req.query('q') ?? null, maxMs);
    return c.text('OK');
  });

  app.post('/reader/api/0/subscription/edit', async (c) => {
    const db = c.get('db');
    const cfg = c.get('cfg');
    const user = c.get('user');
    if (!(await readTokenIsValid(c, user))) return c.text('Invalid token', 401);

    const ac = (c.req.query('ac') ?? '').toLowerCase();
    const raw = c.req.query('s') ?? '';
    if (!raw) return c.json({ error: 'Missing feed id' }, 400);
    const ref = raw.startsWith('feed/') ? raw.slice('feed/'.length) : raw;
    const titleParam = c.req.query('t');
    const folders = collectLabels(c, 'a');
    const removeFolders = collectLabels(c, 'r');

    if (ac === 'subscribe') {
      try {
        await subscribeToUrl(db, cfg, user.id, ref, {
          title: titleParam ?? null,
          folder: folders[0] ?? null,
          fetchImpl,
        });
        return c.text('OK');
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : 'Subscribe failed' },
          400,
        );
      }
    }

    const sub = await store.getSubscription(db, user.id, ref);
    if (!sub) return c.text('OK');

    if (ac === 'unsubscribe') {
      await store.removeSubscription(db, user.id, sub.feed_id);
      return c.text('OK');
    }

    const patch: { title?: string | null; folder?: string | null } = {};
    if (titleParam !== undefined) patch.title = titleParam.trim() || null;
    if (folders.length > 0) patch.folder = folders[0];
    if (removeFolders.length > 0) patch.folder = null;
    await store.updateSubscription(db, user.id, sub.feed_id, patch);
    return c.text('OK');
  });

  async function quickadd(c: Context<AppEnv>) {
    const db = c.get('db');
    const cfg = c.get('cfg');
    const user = c.get('user');
    let url = c.req.query('quickadd') ?? '';
    if (!url) {
      try {
        const body = await c.req.parseBody();
        const value = body.quickadd ?? body.url;
        if (typeof value === 'string') url = value;
      } catch {
        /* no body */
      }
    }
    if (!url) return c.json({ numResults: 0, query: '' }, 200);
    const existing = await store.getSubscription(db, user.id, url);
    if (existing) {
      return c.json({
        numResults: 1,
        query: url,
        streamId: feedStreamId(existing.url),
        streamName: existing.title || existing.url,
      });
    }
    try {
      const result = await subscribeToUrl(db, cfg, user.id, url, { fetchImpl });
      return c.json({
        numResults: 1,
        query: url,
        streamId: feedStreamId(result.url),
        streamName: result.title,
      });
    } catch {
      return c.json({ numResults: 0, query: url }, 200);
    }
  }

  app.get('/reader/api/0/subscription/quickadd', quickadd);
  app.post('/reader/api/0/subscription/quickadd', quickadd);

  app.post('/reader/api/0/rename-tag', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const raw = c.req.query('i') ?? c.req.query('s') ?? '';
    const destination = c.req.query('dest') ?? c.req.query('t') ?? '';
    const from = labelFromTag(raw);
    const to = labelFromTag(destination);
    if (from && to) await store.renameFolder(db, user.id, from, to);
    return c.text('OK');
  });

  return app;
}
