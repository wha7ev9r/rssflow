import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ensureAdmin } from '../src/auth';
import { readConfig } from '../src/config';
import { createApp } from '../src/index';
import { refreshFeed, subscribeToUrl } from '../src/ingest';
import * as store from '../src/store';
import { makeTestDb, rssFeed, stubFetch, testEnv, cookieFrom, type TestDb } from './helpers';

let ctx: TestDb;
let app: ReturnType<typeof createApp>;
let fetchImpl: typeof fetch;
let userId: number;
const cfg = readConfig(testEnv);

beforeEach(async () => {
  ctx = await makeTestDb();
  fetchImpl = stubFetch(() => new Response('not found', { status: 404 }));
  app = createApp({
    createDb: () => ({ db: ctx.db, close: async () => undefined }),
    fetchImpl: ((input, init) => fetchImpl(input, init)) as typeof fetch,
  });
  const user = await ensureAdmin(ctx.db, cfg);
  userId = user.id;
});

afterEach(async () => {
  await ctx.close();
});

async function greaderLogin(): Promise<string> {
  const response = await app.request(
    '/api/greader.php/accounts/ClientLogin',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Email: 'admin', Passwd: 'test-password' }).toString(),
    },
    testEnv,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const match = /^Auth=(.+)$/m.exec(text);
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

async function greader(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return app.request(
    `/api/greader.php${path}`,
    {
      ...init,
      headers: {
        Authorization: `GoogleLogin auth=${token}`,
        ...(init.headers ?? {}),
      },
    },
    testEnv,
  );
}

describe('Google Reader API', () => {
  test('ClientLogin, subscribe, streams, unread counts and edit-tag', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([
        { id: 'a', title: 'Alpha', date: 'Tue, 06 Oct 2026 10:00:00 GMT' },
        { id: 'b', title: 'Beta', date: 'Mon, 05 Oct 2026 10:00:00 GMT' },
      ]), { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const token = await greaderLogin();

    const subscribe = await greader(
      '/reader/api/0/subscription/edit?ac=subscribe&s=' +
        encodeURIComponent('feed/https://example.com/rss'),
      token,
      { method: 'POST' },
    );
    expect(subscribe.status).toBe(200);
    expect(await subscribe.text()).toBe('OK');

    const list = await (await greader('/reader/api/0/subscription/list', token)).json() as {
      subscriptions: Array<{ id: string; title: string }>;
    };
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0]!.id).toBe('feed/https://example.com/rss');
    expect(list.subscriptions[0]!.title).toBe('Example Feed');

    const folderEdit = await greader(
      '/reader/api/0/subscription/edit?ac=edit&s=' +
        encodeURIComponent('feed/https://example.com/rss') +
        '&a=' +
        encodeURIComponent('user/-/label/Tech News'),
      token,
      { method: 'POST' },
    );
    expect(await folderEdit.text()).toBe('OK');
    const tagsWithFolder = await (await greader('/reader/api/0/tag/list', token)).json() as {
      tags: Array<{ id: string }>;
    };
    expect(tagsWithFolder.tags.map((tag) => tag.id)).toContain('user/-/label/Tech News');

    const counts = await (await greader('/reader/api/0/unread-count', token)).json() as {
      unreadcounts: Array<{ id: string; count: number }>;
    };
    const readingList = counts.unreadcounts.find(
      (entry) => entry.id === 'user/-/state/com.google/reading-list',
    );
    expect(readingList?.count).toBe(2);

    const contents = await (await greader(
      '/reader/api/0/stream/contents?n=10&s=' +
        encodeURIComponent('user/-/state/com.google/reading-list'),
      token,
    )).json() as { items: Array<{ id: string; title: string; timestampUsec: string; origin: { streamId: string } }> };
    expect(contents.items).toHaveLength(2);
    expect(contents.items[0]!.title).toBe('Alpha');
    expect(contents.items[0]!.id).toMatch(/^tag:google\.com,2005:reader\/item\/[0-9a-f]{16}$/);
    expect(contents.items[0]!.origin.streamId).toBe('feed/https://example.com/rss');
    expect(Number(contents.items[0]!.timestampUsec)).toBeGreaterThan(0);

    const itemId = contents.items[0]!.id;
    const edit = await greader(
      `/reader/api/0/edit-tag?i=${encodeURIComponent(itemId)}&a=${encodeURIComponent('user/-/state/com.google/read')}&a=${encodeURIComponent('user/-/state/com.google/starred')}`,
      token,
      { method: 'POST' },
    );
    expect(edit.status).toBe(200);

    const afterEdit = await (await greader('/reader/api/0/unread-count', token)).json() as {
      unreadcounts: Array<{ id: string; count: number }>;
    };
    expect(
      afterEdit.unreadcounts.find((entry) => entry.id === 'user/-/state/com.google/reading-list')
        ?.count,
    ).toBe(1);
    expect(
      afterEdit.unreadcounts.find((entry) => entry.id === 'user/-/state/com.google/starred'),
    ).toBeUndefined();

    const starred = await (await greader(
      '/reader/api/0/stream/contents?s=' + encodeURIComponent('user/-/state/com.google/starred'),
      token,
    )).json() as { items: Array<{ id: string; categories: string[] }> };
    expect(starred.items).toHaveLength(1);
    expect(starred.items[0]!.categories).toContain('user/-/state/com.google/starred');

    const markAll = await greader(
      `/reader/api/0/mark-all-as-read?s=${encodeURIComponent('user/-/state/com.google/reading-list')}&ts=${Date.now() * 1000}`,
      token,
      { method: 'POST' },
    );
    expect(await markAll.text()).toBe('OK');
    const unreadAfter = await (await greader(
      '/reader/api/0/stream/contents?s=' +
        encodeURIComponent('user/-/state/com.google/reading-list') +
        '&xt=' +
        encodeURIComponent('user/-/state/com.google/read'),
      token,
    )).json() as { items: unknown[] };
    expect(unreadAfter.items).toHaveLength(0);

    const items = await (await greader(
      `/reader/api/0/stream/items/contents?i=${encodeURIComponent(itemId)}`,
      token,
    )).json() as { items: Array<{ title: string }> };
    expect(items.items[0]!.title).toBe('Alpha');

    const tags = await (await greader('/reader/api/0/tag/list', token)).json() as {
      tags: Array<{ id: string }>;
    };
    expect(tags.tags.map((tag) => tag.id)).toContain(
      'user/-/state/com.google/starred',
    );
  });

  test('rejects bad credentials and bad action tokens', async () => {
    const bad = await app.request(
      '/api/greader.php/accounts/ClientLogin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Email: 'admin', Passwd: 'wrong' }).toString(),
      },
      testEnv,
    );
    expect(bad.status).toBe(403);

    const noAuth = await app.request('/api/greader.php/reader/api/0/user-info', {}, testEnv);
    expect(noAuth.status).toBe(401);

    const token = await greaderLogin();
    const badToken = await greader(
      '/reader/api/0/mark-all-as-read?s=' +
        encodeURIComponent('user/-/state/com.google/reading-list') +
        '&T=wrong',
      token,
      { method: 'POST' },
    );
    expect(badToken.status).toBe(401);
  });
});

describe('web UI and ingestion', () => {
  test('login, list, open article, toggle state, export OPML and import', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([{ id: 'post-1', title: 'Web Post' }]), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    );
    await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/rss', {
      folder: 'Tech',
      fetchImpl,
    });

    const login = await app.request(
      '/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: 'admin',
          password: 'test-password',
          next: '/',
        }).toString(),
      },
      testEnv,
    );
    expect(login.status).toBe(302);
    const cookie = cookieFrom(login);
    expect(cookie).toStartWith('buffy_session=');

    const home = await app.request('/', { headers: { cookie } }, testEnv);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Web Post');
    expect(html).toContain('Tech');
    const itemId = /item\/([0-9a-f]{16})/.exec(html)?.[1];
    expect(itemId).toBeTruthy();

    const item = await app.request(`/item/${itemId}`, { headers: { cookie } }, testEnv);
    expect(item.status).toBe(200);
    expect(await item.text()).toContain('Web Post');
    expect(await ctx.db.value<number>(
      `select count(*)::int from entry_states st
       join entries e on e.id = st.entry_id
       where st.user_id = $1 and e.item_id = $2 and st.read`,
      [userId, itemId],
    )).toBe(1);

    const state = await app.request(
      '/api/state',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [itemId], starred: true }),
      },
      testEnv,
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ ok: true });

    const opml = await app.request('/opml', { headers: { cookie } }, testEnv);
    expect(opml.status).toBe(200);
    expect(await opml.text()).toContain('https://example.com/rss');

    const importForm = new FormData();
    importForm.append(
      'opml',
      `<?xml version="1.0"?><opml version="2.0"><body>
        <outline text="Second" type="rss" xmlUrl="https://second.example/feed" />
      </body></opml>`,
    );
    const imported = await app.request(
      '/opml',
      { method: 'POST', headers: { cookie }, body: importForm },
      testEnv,
    );
    expect(imported.status).toBe(302);
    const subscriptions = await store.listSubscriptions(ctx.db, userId);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.some((sub) => sub.title === 'Second')).toBe(true);
  });

  test('adds a feed through the UI and renders an empty state otherwise', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([{ id: 'ui', title: 'UI Post' }]), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    );
    const login = await app.request(
      '/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'test-password' }).toString(),
      },
      testEnv,
    );
    const cookie = cookieFrom(login);

    const response = await app.request(
      '/feeds/add',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ url: 'https://example.com/rss', folder: '' }).toString(),
      },
      testEnv,
    );
    expect(response.status).toBe(302);

    const home = await app.request('/', { headers: { cookie } }, testEnv);
    expect(await home.text()).toContain('UI Post');
  });
});

describe('refresh pipeline', () => {
  test('deduplicates entries and handles 304 and errors', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }]), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    );
    const subscribed = await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/rss', {
      fetchImpl,
    });
    expect(await ctx.db.value<number>('select count(*)::int from entries')).toBe(2);

    const feed = await store.getFeedById(ctx.db, subscribed.feedId);
    expect(feed).not.toBeNull();
    const again = await refreshFeed(ctx.db, cfg, feed!, fetchImpl);
    expect(again.status).toBe('updated');
    expect(again.inserted).toBe(0);
    expect(await ctx.db.value<number>('select count(*)::int from entries')).toBe(2);

    fetchImpl = stubFetch(() => new Response(null, { status: 304 }));
    const notModified = await refreshFeed(ctx.db, cfg, feed!, fetchImpl);
    expect(notModified.status).toBe('not-modified');

    fetchImpl = stubFetch(() => new Response('boom', { status: 500 }));
    const failed = await refreshFeed(ctx.db, cfg, feed!, fetchImpl);
    expect(failed.status).toBe('error');
    const row = await ctx.db.one<{ error_count: number; last_error: string | null }>(
      'select error_count, last_error from feeds where id = $1',
      [subscribed.feedId],
    );
    expect(row?.error_count).toBe(1);
    expect(row?.last_error).toContain('500');
  });

  test('cron endpoint requires the secret and refreshes due feeds', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([{ id: 'cron', title: 'Cron Post' }]), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    );
    await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/rss', { fetchImpl });
    await store.scheduleAll(ctx.db, userId);

    const unauthorized = await app.request('/api/cron/refresh', {}, testEnv);
    expect(unauthorized.status).toBe(401);

    fetchImpl = stubFetch(() =>
      new Response(rssFeed([
        { id: 'cron', title: 'Cron Post' },
        { id: 'cron-2', title: 'Second Cron Post' },
      ]), { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const response = await app.request(
      '/api/cron/refresh',
      { headers: { authorization: 'Bearer test-cron-secret' } },
      testEnv,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      processed: number;
      inserted: number;
      remaining: number;
      results: unknown[];
    };
    expect(payload.processed).toBe(1);
    expect(payload.inserted).toBe(1);
    expect(payload.remaining).toBe(0);
    expect(payload.results).toHaveLength(1);
    expect(await ctx.db.value<number>('select count(*)::int from entries')).toBe(2);
  });

  test('cleanup deletes old read entries but keeps starred ones', async () => {
    fetchImpl = stubFetch(() =>
      new Response(rssFeed([{ id: 'old', title: 'Old' }]), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    );
    const subscribed = await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/rss', {
      fetchImpl,
    });
    const oldId = await ctx.db.value<number>(
      `insert into entries (feed_id, guid, item_id, title, published_at)
       values ($1, 'old-guid', 'aaaaaaaaaaaaaaaa', 'Old entry', now() - interval '400 days')
       returning id::int`,
      [subscribed.feedId],
    );
    const starredId = await ctx.db.value<number>(
      `insert into entries (feed_id, guid, item_id, title, published_at)
       values ($1, 'starred-guid', 'bbbbbbbbbbbbbbbb', 'Starred old entry', now() - interval '400 days')
       returning id::int`,
      [subscribed.feedId],
    );
    await ctx.db.execute(
      'insert into entry_states (user_id, entry_id, read, starred) values ($1, $2, true, false), ($1, $3, true, true)',
      [userId, oldId, starredId],
    );

    const result = await store.cleanup(ctx.db, cfg);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.db.value<number>(`select count(*)::int from entries where guid = 'old-guid'`),
    ).toBe(0);
    expect(
      await ctx.db.value<number>(`select count(*)::int from entries where guid = 'starred-guid'`),
    ).toBe(1);
  });
});

describe('health', () => {
  test('reports database connectivity', async () => {
    const response = await app.request('/health', {}, testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
