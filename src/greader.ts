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
    id: `${ITEM_PREFIX}${entry.item_id}`,
    crawlTimeMsec: String(Math.floor(entry.fetched_ms)),
    timestampUsec: String(Math.floor(entry.fetched_ms * 1000)),
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

async function requestParams(c: Context<AppEnv>): Promise<URLSearchParams> {
  const params = new URL(c.req.url).searchParams;
  if (c.req.method === 'POST') {
    const body = await c.req.parseBody({ all: true });
    for (const [name, value] of Object.entries(body)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'string') params.append(name, item);
      }
    }
  }
  return params;
}

/** Protocol lists use repeated parameters; commas and spaces are data. */
function collectParams(params: URLSearchParams, name: string): string[] {
  return params.getAll(name).map((value) => value.trim()).filter(Boolean);
}

function collectTags(params: URLSearchParams, name: string): string[] {
  return collectParams(params, name);
}

const ITEM_PREFIX = 'tag:google.com,2005:reader/item/';

/** Reader's ID list uses decimal uint64; full items use prefixed hexadecimal. */
async function collectItemIds(c: Context<AppEnv>, params: URLSearchParams): Promise<string[]> {
  const ids: Array<{ id: string; legacy?: string }> = [];
  for (const raw of collectParams(params, 'i')) {
    if (raw.startsWith(ITEM_PREFIX)) {
      const hex = raw.slice(ITEM_PREFIX.length);
      if (/^[0-9a-f]{16}$/i.test(hex)) ids.push({ id: hex.toLowerCase() });
    } else if (/^-?\d{1,20}$/.test(raw)) {
      const id = BigInt(raw);
      if (id < -(1n << 63n) || id >= (1n << 64n)) continue;
      ids.push({
        id: BigInt.asUintN(64, id).toString(16).padStart(16, '0'),
        ...(/^\d{16}$/.test(raw) ? { legacy: raw } : {}),
      });
    } else if (/^[0-9a-f]{16}$/i.test(raw)) {
      ids.push({ id: raw.toLowerCase() });
    }
  }
  const ambiguous = ids.filter((item) => item.legacy !== undefined);
  if (ambiguous.length === 0) return ids.map((item) => item.id);
  const rows = await c.get('db').query<{ item_id: string }>(
    `select e.item_id from entries e
     join subscriptions s on s.feed_id = e.feed_id and s.user_id = $1
     where e.item_id = any($2::text[])`,
    [c.get('user').id, ambiguous.flatMap((item) => [item.id, item.legacy!])],
  );
  const existing = new Set(rows.map((row) => row.item_id));
  // Prefer the standard decimal interpretation. Fall back only if its target
  // does not exist, so an ambiguous ID can never change two different items.
  return ids.map((item) =>
    !existing.has(item.id) && item.legacy && existing.has(item.legacy) ? item.legacy : item.id,
  );
}

function labelFromTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const marker = '/label/';
  const index = trimmed.indexOf(marker);
  if (index >= 0) return trimmed.slice(index + marker.length);
  if (trimmed.includes('/state/')) return null;
  return trimmed;
}

function collectLabels(params: URLSearchParams, name: string): string[] {
  return collectTags(params, name)
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

function listOptions(
  params: URLSearchParams,
  defaultLimit: number,
  maxLimit: number,
): Omit<store.ListEntriesOptions, 'stream'> {
  const excludedRead = collectTags(params, 'xt').some((tag) => parseStreamId(tag)?.kind === 'read');
  const includedRead = collectTags(params, 'it').some((tag) => parseStreamId(tag)?.kind === 'read');
  const timestampMs = (name: string): number | null => {
    const seconds = Number(params.get(name));
    return Number.isFinite(seconds) && seconds > 0 && seconds <= 8_640_000_000_000
      ? seconds * 1000
      : null;
  };
  return {
    search: params.get('q'),
    limit: intFrom(params.get('n'), defaultLimit, 1, maxLimit),
    before: decodeContinuation(params.get('c') ?? undefined),
    // ot is the start time, nt is the stop time, both in Unix seconds.
    afterMs: timestampMs('ot'),
    beforeMs: timestampMs('nt'),
    timeField: 'fetched',
    order: params.get('r') === 'o' ? 'asc' : 'desc',
    unreadOnly: excludedRead,
    readOnly: includedRead && !excludedRead,
  };
}

function streamIdFromRequest(c: Context<AppEnv>): string {
  const queryStream = c.req.query('s');
  if (queryStream) return queryStream;
  const marker = '/stream/contents/';
  const path = c.req.path;
  const index = path.indexOf(marker);
  if (index < 0) return '';
  return safeDecode(path.slice(index + marker.length));
}

async function validateWrite(
  c: Context<AppEnv>,
  user: User,
  params: URLSearchParams,
): Promise<Response | null> {
  const origin = c.req.header('origin');
  if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site') {
    return c.text('Cross-origin request forbidden', 403);
  }
  const provided = params.getAll('T');
  if (provided.length > 0) {
    const expected = await actionToken(c.get('cfg'), user);
    return provided.every((token) => timingSafeEqual(token, expected))
      ? null
      : c.text('Invalid token', 401);
  }
  // Only validated explicit credentials may omit T. A bogus Authorization
  // header must not turn fallback cookie/query authentication into header auth.
  const headerUser = await authenticate(c.get('db'), c.get('cfg'), {
    header: (name) => c.req.header(name),
    query: () => undefined,
    cookie: () => undefined,
  });
  return headerUser?.id === user.id ? null : c.text('Action token required', 401);
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

    const params = await requestParams(c);
    const { entries, hasMore } = await store.listEntries(db, user.id, {
      stream,
      ...listOptions(params, 20, 100),
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

  async function itemContents(c: Context<AppEnv>) {
    const ids = await collectItemIds(c, await requestParams(c));
    const entries = await store.getEntriesByItemIds(c.get('db'), c.get('user').id, ids);
    return c.json({ items: entries.map(itemJson) });
  }

  app.get('/reader/api/0/stream/items/contents', itemContents);
  app.post('/reader/api/0/stream/items/contents', itemContents);

  app.get('/reader/api/0/stream/items/ids', async (c) => {
    const params = await requestParams(c);
    const rawStreamId = params.get('s') ?? READING_LIST;
    const stream = parseStreamId(rawStreamId);
    if (!stream) return c.json({ error: 'Unknown stream' }, 400);
    const { entries, hasMore } = await store.listEntries(c.get('db'), c.get('user').id, {
      stream,
      ...listOptions(params, 100, 200),
    });
    const last = entries[entries.length - 1];
    return c.json({
      itemRefs: entries.map((entry) => ({
        id: BigInt(`0x${entry.item_id}`).toString(),
        timestampUsec: String(Math.floor(entry.fetched_ms * 1000)),
        directStreamIds: [feedStreamId(entry.feed_url)],
        timestamp: Math.floor(entry.fetched_ms / 1000),
      })),
      ...(hasMore && last ? { continuation: encodeContinuation(last) } : {}),
    });
  });

  app.post('/reader/api/0/edit-tag', async (c) => {
    const user = c.get('user');
    const params = await requestParams(c);
    const denied = await validateWrite(c, user, params);
    if (denied) return denied;
    const ids = await collectItemIds(c, params);
    if (ids.length === 0) return c.text('OK');

    let read: boolean | null = null;
    let starred: boolean | null = null;
    for (const tag of collectTags(params, 'a')) {
      const kind = parseStreamId(tag)?.kind;
      if (kind === 'read') read = true;
      if (kind === 'unread') read = false;
      if (kind === 'starred') starred = true;
    }
    for (const tag of collectTags(params, 'r')) {
      const kind = parseStreamId(tag)?.kind;
      if (kind === 'read') read = false;
      if (kind === 'starred') starred = false;
    }
    await store.setEntryStateByItemIds(c.get('db'), user.id, ids, read, starred);
    return c.text('OK');
  });

  app.post('/reader/api/0/mark-all-as-read', async (c) => {
    const user = c.get('user');
    const params = await requestParams(c);
    const denied = await validateWrite(c, user, params);
    if (denied) return denied;
    const stream = parseStreamId(params.get('s') ?? READING_LIST);
    if (!stream) return c.json({ error: 'Unknown stream' }, 400);
    const rawTs = Number.parseInt(params.get('ts') ?? '', 10);
    const maxMs = Number.isFinite(rawTs) && rawTs > 0 ? rawTs / 1000 : Date.now();
    await store.markAllRead(c.get('db'), user.id, stream, params.get('q'), maxMs, 'fetched');
    return c.text('OK');
  });

  app.post('/reader/api/0/subscription/edit', async (c) => {
    const db = c.get('db');
    const cfg = c.get('cfg');
    const user = c.get('user');
    const params = await requestParams(c);
    const denied = await validateWrite(c, user, params);
    if (denied) return denied;

    const ac = (params.get('ac') ?? '').toLowerCase();
    const raw = params.get('s') ?? '';
    if (!raw) return c.json({ error: 'Missing feed id' }, 400);
    const ref = raw.startsWith('feed/') ? raw.slice('feed/'.length) : raw;
    const titleParam = params.get('t');
    const folders = collectLabels(params, 'a');
    const removeFolders = collectLabels(params, 'r');

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
    if (titleParam !== null) patch.title = titleParam.trim() || null;
    if (sub.folder && removeFolders.includes(sub.folder)) patch.folder = null;
    if (folders.length > 0) patch.folder = folders[0];
    await store.updateSubscription(db, user.id, sub.feed_id, patch);
    return c.text('OK');
  });

  async function quickadd(c: Context<AppEnv>) {
    const db = c.get('db');
    const cfg = c.get('cfg');
    const user = c.get('user');
    const params = await requestParams(c);
    const denied = await validateWrite(c, user, params);
    if (denied) return denied;
    const url = params.get('quickadd') || params.get('url') || '';
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
    const params = await requestParams(c);
    const denied = await validateWrite(c, user, params);
    if (denied) return denied;
    const raw = params.get('i') ?? params.get('s') ?? '';
    const destination = params.get('dest') ?? params.get('t') ?? '';
    const from = labelFromTag(raw);
    const to = labelFromTag(destination);
    if (from && to) await store.renameFolder(db, user.id, from, to);
    return c.text('OK');
  });

  return app;
}
