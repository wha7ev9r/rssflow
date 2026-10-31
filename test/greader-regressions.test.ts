import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { actionToken, ensureAdmin, issueAuthToken, issueSessionToken } from '../src/auth';
import { readConfig } from '../src/config';
import { createApp } from '../src/index';
import * as store from '../src/store';
import { READ, READING_LIST, STARRED, labelStreamId } from '../src/stream';
import { makeTestDb, rssFeed, stubFetch, testEnv, type TestDb } from './helpers';

const cfg = readConfig(testEnv);
const PREFIX = 'tag:google.com,2005:reader/item/';
let ctx: TestDb;
let app: ReturnType<typeof createApp>;
let user: { id: number; username: string };
let auth: string;
let feedId: number;

beforeEach(async () => {
  ctx = await makeTestDb();
  user = await ensureAdmin(ctx.db, cfg);
  auth = await issueAuthToken(cfg, user);
  app = createApp({
    createDb: () => ({ db: ctx.db, close: async () => undefined }),
    fetchImpl: stubFetch(() => new Response(rssFeed([{ id: 'new', title: 'New' }]))),
  });
  feedId = await store.upsertFeed(ctx.db, 'https://example.com/rss', { title: 'Feed' });
  await store.subscribe(ctx.db, user.id, feedId, null, 'Old');
});

afterEach(async () => { await ctx.close(); });

function request(path: string, init: RequestInit = {}) {
  return app.request(`/api/greader.php/reader/api/0/${path}`, {
    ...init,
    headers: { authorization: `GoogleLogin auth=${auth}`, ...init.headers },
  }, testEnv);
}

function post(path: string, fields: Array<[string, string]>) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function seed(hex: string, publishedMs = Date.UTC(2026, 9, 6)) {
  await store.insertEntries(ctx.db, feedId, [{
    guid: hex, itemId: hex, url: null, title: hex, author: null, summary: null,
    content: null, enclosureUrl: null, enclosureType: null, publishedMs,
  }]);
}

describe('Google Reader compatibility regressions', () => {
  test('form edit-tag preserves repeated IDs, tags and canonical commas', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    await seed('bbbbbbbbbbbbbbbb');
    const response = await post('edit-tag', [
      ['i', `${PREFIX}aaaaaaaaaaaaaaaa`], ['i', `${PREFIX}bbbbbbbbbbbbbbbb`],
      ['a', READ], ['a', STARRED],
    ]);
    expect(response.status).toBe(200);
    expect(await ctx.db.value<number>('select count(*)::int from entry_states where read and starred')).toBe(2);
  });

  test('GET item contents accepts canonical IDs without splitting the comma', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const response = await request(`stream/items/contents?${new URLSearchParams({ i: `${PREFIX}aaaaaaaaaaaaaaaa` })}`);
    const json = await response.json() as { items: Array<{ id: string }> };
    expect(json.items.map((item) => item.id)).toEqual([`${PREFIX}aaaaaaaaaaaaaaaa`]);
  });

  test('POST item contents accepts decimal IDs and returns canonical IDs', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const response = await post('stream/items/contents', [['i', BigInt('0xaaaaaaaaaaaaaaaa').toString()]]);
    expect(response.status).toBe(200);
    const json = await response.json() as { items: Array<{ id: string }> };
    expect(json.items.map((item) => item.id)).toEqual([`${PREFIX}aaaaaaaaaaaaaaaa`]);
  });

  test('ambiguous numeric legacy IDs fall back only when the standard decimal target is absent', async () => {
    const raw = '1234567890123456';
    const decimalHex = BigInt(raw).toString(16).padStart(16, '0');
    await seed(raw);
    await post('edit-tag', [['i', raw], ['a', READ]]);
    expect(await store.getEntryByItemId(ctx.db, user.id, raw)).toMatchObject({ read: true });
    await seed(decimalHex);
    await post('edit-tag', [['i', raw], ['a', STARRED]]);
    expect(await store.getEntryByItemId(ctx.db, user.id, decimalHex)).toMatchObject({ starred: true });
    expect(await store.getEntryByItemId(ctx.db, user.id, raw)).toMatchObject({ starred: false });
    const tooLong = await post('edit-tag', [['i', '9'.repeat(10000)], ['a', READ]]);
    expect(tooLong.status).toBe(200);
  });

  test('form mark-all-as-read is restricted to its requested folder', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const other = await store.upsertFeed(ctx.db, 'https://other.example/rss', {});
    await store.subscribe(ctx.db, user.id, other, null, 'Other');
    await ctx.db.execute("insert into entries (feed_id,guid,item_id,published_at) values ($1,'other','bbbbbbbbbbbbbbbb','2026-10-06')", [other]);
    const response = await post('mark-all-as-read', [['s', labelStreamId('Old')]]);
    expect(response.status).toBe(200);
    expect(await store.getEntryByItemId(ctx.db, user.id, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: true });
    expect(await store.getEntryByItemId(ctx.db, user.id, 'bbbbbbbbbbbbbbbb')).toMatchObject({ read: false });
  });

  test('folder move removes old before adding new, preserving commas and spaces', async () => {
    const response = await post('subscription/edit', [
      ['ac', 'edit'], ['s', 'feed/https://example.com/rss'],
      ['r', labelStreamId('Old')], ['a', labelStreamId('New, Folder')],
    ]);
    expect(response.status).toBe(200);
    expect(await store.getSubscription(ctx.db, user.id, String(feedId))).toMatchObject({ folder: 'New, Folder' });
  });

  test('removing an unrelated folder does not clear the current folder', async () => {
    const params = new URLSearchParams({ ac: 'edit', s: `feed/${feedId}`, r: labelStreamId('Unrelated') });
    const response = await request(`subscription/edit?${params}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await store.getSubscription(ctx.db, user.id, String(feedId))).toMatchObject({ folder: 'Old' });
  });

  test('item ID pagination is complete and uses lossless decimal identifiers', async () => {
    await seed('aaaaaaaaaaaaaaaa', Date.UTC(2026, 9, 8));
    await seed('bbbbbbbbbbbbbbbb', Date.UTC(2026, 9, 7));
    await seed('cccccccccccccccc', Date.UTC(2026, 9, 6));
    const first = await (await request(`stream/items/ids?${new URLSearchParams({ s: READING_LIST, n: '2' })}`)).json() as {
      itemRefs: Array<{ id: string }>; continuation?: string;
    };
    expect(first.itemRefs.map((item) => item.id)).toEqual([
      BigInt('0xaaaaaaaaaaaaaaaa').toString(), BigInt('0xbbbbbbbbbbbbbbbb').toString(),
    ]);
    expect(first.continuation).toBeTruthy();
    const second = await (await request(`stream/items/ids?${new URLSearchParams({ s: READING_LIST, n: '2', c: first.continuation! })}`)).json() as {
      itemRefs: Array<{ id: string }>; continuation?: string;
    };
    expect(second.itemRefs.map((item) => item.id)).toEqual([BigInt('0xcccccccccccccccc').toString()]);
    expect(second.continuation).toBeUndefined();
  });

  test('query and body values are merged without losing repeated IDs or tags', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    await seed('bbbbbbbbbbbbbbbb');
    const query = new URLSearchParams({ i: `${PREFIX}aaaaaaaaaaaaaaaa`, a: READ });
    const response = await post(`edit-tag?${query}`, [['i', `${PREFIX}bbbbbbbbbbbbbbbb`], ['a', STARRED]]);
    expect(response.status).toBe(200);
    expect(await ctx.db.value<number>('select count(*)::int from entry_states where read and starred')).toBe(2);
  });

  test('time bounds use crawl seconds and remain active on every page in either order', async () => {
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd'];
    for (const [index, id] of ids.entries()) {
      await seed(id, Date.UTC(2020, 0, 1));
      await ctx.db.execute('update entries set fetched_at = to_timestamp($2 / 1000.0) where item_id = $1', [id, Date.UTC(2026, 9, 5 + index)]);
    }
    for (const endpoint of ['stream/contents', 'stream/items/ids']) {
      for (const order of ['d', 'o']) {
        const params = new URLSearchParams({ s: READING_LIST, ot: String(Date.UTC(2026, 9, 6) / 1000), nt: String(Date.UTC(2026, 9, 7) / 1000), n: '1', r: order });
        const collected: string[] = [];
        for (let page = 0; page < 3; page++) {
          const json = await (await request(`${endpoint}?${params}`)).json() as {
            items?: Array<{ id: string }>; itemRefs?: Array<{ id: string }>; continuation?: string;
          };
          collected.push(...(json.items ?? json.itemRefs ?? []).map((item) => item.id));
          if (!json.continuation) break;
          params.set('c', json.continuation);
        }
        const wanted = order === 'o' ? ids.slice(1, 3) : ids.slice(1, 3).reverse();
        expect(collected).toEqual(wanted.map((id) => endpoint.endsWith('/ids') ? BigInt(`0x${id}`).toString() : `${PREFIX}${id}`));
      }
    }
  });

  test('mark-all timestamp excludes subsequently crawled backdated articles', async () => {
    await seed('aaaaaaaaaaaaaaaa', Date.UTC(2020, 0, 1));
    await seed('bbbbbbbbbbbbbbbb', Date.UTC(2020, 0, 1));
    const firstMs = Date.UTC(2026, 9, 6);
    await ctx.db.execute("update entries set fetched_at = to_timestamp($1 / 1000.0) where item_id = 'aaaaaaaaaaaaaaaa'", [firstMs]);
    await ctx.db.execute("update entries set fetched_at = to_timestamp($1 / 1000.0) where item_id = 'bbbbbbbbbbbbbbbb'", [firstMs + 86400000]);
    const json = await (await request(`stream/items/contents?${new URLSearchParams({ i: `${PREFIX}aaaaaaaaaaaaaaaa` })}`)).json() as { items: Array<{ timestampUsec: string }> };
    expect(json.items[0]!.timestampUsec).toBe(String(firstMs * 1000));
    await post('mark-all-as-read', [['s', READING_LIST], ['ts', json.items[0]!.timestampUsec]]);
    expect(await store.getEntryByItemId(ctx.db, user.id, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: true });
    expect(await store.getEntryByItemId(ctx.db, user.id, 'bbbbbbbbbbbbbbbb')).toMatchObject({ read: false });
  });

  test('literal percent escapes in folder names and feed URLs are not decoded twice', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    await store.updateSubscription(ctx.db, user.id, feedId, { folder: 'A%2FB' });
    const feedUrl = 'https://example.com/a%2Fb';
    await ctx.db.execute('update feeds set url = $2 where id = $1', [feedId, feedUrl]);
    for (const stream of [labelStreamId('A%2FB'), `feed/${feedUrl}`]) {
      const json = await (await request(`stream/contents?${new URLSearchParams({ s: stream })}`)).json() as { items: unknown[] };
      expect(json.items).toHaveLength(1);
    }
  });

  test('rejects bad form action tokens even with Authorization', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const response = await post('edit-tag', [['i', 'aaaaaaaaaaaaaaaa'], ['a', READ], ['T', 'wrong']]);
    expect(response.status).toBe(401);
    expect(await store.getEntryByItemId(ctx.db, user.id, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: false });
  });

  test('supports concrete user IDs in state tags', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    await post('edit-tag', [['i', `${PREFIX}aaaaaaaaaaaaaaaa`], ['a', `user/${user.id}/state/com.google/read`]]);
    expect(await store.getEntryByItemId(ctx.db, user.id, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: true });
  });
});

describe('Google Reader write authentication', () => {
  test('GET quickadd cannot use ambient cookies without an action token', async () => {
    const cookie = `buffy_session=${await issueSessionToken(cfg, user)}`;
    const response = await app.request('/api/greader.php/reader/api/0/subscription/quickadd?quickadd=https%3A%2F%2Fnew.example%2Frss', {
      headers: { cookie },
    }, testEnv);
    expect(response.status).toBe(401);
    expect(await store.listSubscriptions(ctx.db, user.id)).toHaveLength(1);
  });

  test('GET quickadd rejects cross-origin requests even with a valid token', async () => {
    const params = new URLSearchParams({ quickadd: 'https://new.example/rss', T: await actionToken(cfg, user) });
    const response = await app.request(`/api/greader.php/reader/api/0/subscription/quickadd?${params}`, {
      headers: { cookie: `buffy_session=${await issueSessionToken(cfg, user)}`, origin: 'https://evil.example' },
    }, testEnv);
    expect(response.status).toBe(403);
    expect(await store.listSubscriptions(ctx.db, user.id)).toHaveLength(1);
  });

  test('query authentication alone cannot write and an invalid header cannot bypass cookie checks', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const params = new URLSearchParams({ i: 'aaaaaaaaaaaaaaaa', a: READ, Auth: auth });
    const response = await app.request(`/api/greader.php/reader/api/0/edit-tag?${params}`, { method: 'POST' }, testEnv);
    expect(response.status).toBe(401);
    const cookieResponse = await app.request(`/api/greader.php/reader/api/0/edit-tag?i=aaaaaaaaaaaaaaaa&a=${encodeURIComponent(READ)}`, {
      method: 'POST', headers: { authorization: 'Bearer invalid', cookie: `buffy_session=${await issueSessionToken(cfg, user)}` },
    }, testEnv);
    expect(cookieResponse.status).toBe(401);
  });

  test('same-origin cookie writes with valid action tokens still work', async () => {
    await seed('aaaaaaaaaaaaaaaa');
    const response = await app.request('/api/greader.php/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { cookie: `buffy_session=${await issueSessionToken(cfg, user)}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ i: `${PREFIX}aaaaaaaaaaaaaaaa`, a: READ, T: await actionToken(cfg, user) }),
    }, testEnv);
    expect(response.status).toBe(200);
    expect(await store.getEntryByItemId(ctx.db, user.id, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: true });
  });
});
