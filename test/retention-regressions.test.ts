import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ensureAdmin } from '../src/auth';
import { readConfig } from '../src/config';
import { refreshFeed, subscribeToUrl } from '../src/ingest';
import * as store from '../src/store';
import { makeTestDb, rssFeed, stubFetch, testEnv, type TestDb } from './helpers';

const cfg = readConfig(testEnv);
let ctx: TestDb;
let userId: number;
let feedId: number;

beforeEach(async () => {
  ctx = await makeTestDb();
  userId = (await ensureAdmin(ctx.db, cfg)).id;
  feedId = await store.upsertFeed(ctx.db, 'https://example.com/rss', {});
  await store.subscribe(ctx.db, userId, feedId, null, null);
});
afterEach(async () => { await ctx.close(); });

function item(guid: string, id: string, publishedMs = Date.UTC(2020, 0, 1)): store.PreparedItem {
  return {
    guid, itemId: id, url: null, title: guid, author: null, summary: null,
    content: null, enclosureUrl: null, enclosureType: null, publishedMs,
  };
}

describe('persistent article identity', () => {
  test('expired read articles do not return as unread after a real feed refresh', async () => {
    const fetchImpl = stubFetch(() => new Response(rssFeed([{ id: 'old', title: 'Old', date: 'Wed, 01 Jan 2020 00:00:00 GMT' }])));
    await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/rss', { fetchImpl });
    const id = await ctx.db.value<string>('select item_id from entries limit 1');
    await store.setEntryStateByItemIds(ctx.db, userId, [id!], true, null);
    expect((await store.cleanup(ctx.db, cfg)).expired).toBe(1);
    const feed = await store.getFeedById(ctx.db, feedId);
    expect((await refreshFeed(ctx.db, cfg, feed!, fetchImpl)).inserted).toBe(0);
    expect(await ctx.db.value<number>('select count(*)::int from entries')).toBe(0);
  });

  test('trimmed articles stay removed while new GUIDs still enter and stars remain', async () => {
    const items = [item('old', 'aaaaaaaaaaaaaaaa'), item('star', 'bbbbbbbbbbbbbbbb'), item('new', 'cccccccccccccccc', Date.UTC(2026, 9, 6))];
    await store.insertEntries(ctx.db, feedId, items);
    await store.setEntryStateByItemIds(ctx.db, userId, ['bbbbbbbbbbbbbbbb'], true, true);
    expect((await store.cleanup(ctx.db, { ...cfg, maxEntriesPerFeed: 1 })).trimmed).toBe(1);
    expect(await store.insertEntries(ctx.db, feedId, [...items, item('brand-new', 'dddddddddddddddd')])).toBe(1);
    expect(await store.getEntryByItemId(ctx.db, userId, 'aaaaaaaaaaaaaaaa')).toBeNull();
    expect(await store.getEntryByItemId(ctx.db, userId, 'bbbbbbbbbbbbbbbb')).toMatchObject({ starred: true, read: true });
    expect(await store.getEntryByItemId(ctx.db, userId, 'dddddddddddddddd')).toMatchObject({ read: false });
  });

  test('never-seen old unread articles are not discarded by the retention cutoff', async () => {
    expect(await store.insertEntries(ctx.db, feedId, [item('old-unread', 'aaaaaaaaaaaaaaaa')])).toBe(1);
    await store.cleanup(ctx.db, cfg);
    expect(await store.getEntryByItemId(ctx.db, userId, 'aaaaaaaaaaaaaaaa')).toMatchObject({ read: false });
  });

  test('duplicate GUIDs within and across batches are registered once', async () => {
    const items = Array.from({ length: 27 }, (_, index) => item(`guid-${index}`, index.toString(16).padStart(16, '0')));
    items.splice(1, 0, item('guid-0', 'ffffffffffffffff'));
    items.push(item('guid-0', 'eeeeeeeeeeeeeeee'));
    expect(await store.insertEntries(ctx.db, feedId, items)).toBe(27);
    expect(await store.insertEntries(ctx.db, feedId, items)).toBe(0);
    expect(await ctx.db.value<number>('select count(*)::int from entry_seen')).toBe(27);
    expect(await store.getEntryByItemId(ctx.db, userId, '0000000000000000')).not.toBeNull();
    expect(await store.getEntryByItemId(ctx.db, userId, 'ffffffffffffffff')).toBeNull();
  });

  test('constraint failure rolls back identity registration so corrected data can retry', async () => {
    const invalid = item('retry', null as unknown as string);
    await expect(store.insertEntries(ctx.db, feedId, [invalid])).rejects.toThrow();
    expect(await ctx.db.value<number>('select count(*)::int from entry_seen')).toBe(0);
    expect(await store.insertEntries(ctx.db, feedId, [item('retry', 'aaaaaaaaaaaaaaaa')])).toBe(1);
    await expect(store.insertEntries(ctx.db, feedId, [item('collision', 'aaaaaaaaaaaaaaaa')])).rejects.toThrow();
    expect(await ctx.db.value<number>("select count(*)::int from entry_seen where guid = 'collision'")).toBe(0);
    expect(await store.insertEntries(ctx.db, feedId, [item('collision', 'bbbbbbbbbbbbbbbb')])).toBe(1);
  });

  test('schema backfill is repeatable and protects entries from an older version', async () => {
    await ctx.db.execute("insert into entries (feed_id,guid,item_id,published_at) values ($1,'legacy','aaaaaaaaaaaaaaaa','2020-01-01')", [feedId]);
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    await ctx.lite.exec(schema);
    await ctx.lite.exec(schema);
    expect(await ctx.db.value<number>('select count(*)::int from entry_seen')).toBe(1);
    await store.setEntryStateByItemIds(ctx.db, userId, ['aaaaaaaaaaaaaaaa'], true, null);
    await store.cleanup(ctx.db, cfg);
    expect(await store.insertEntries(ctx.db, feedId, [item('legacy', 'aaaaaaaaaaaaaaaa')])).toBe(0);
  });

  test('unsubscribing cascades identities and a new subscription may import again', async () => {
    const original = item('returning', 'aaaaaaaaaaaaaaaa');
    await store.insertEntries(ctx.db, feedId, [original]);
    await store.removeSubscription(ctx.db, userId, feedId);
    expect(await ctx.db.value<number>('select count(*)::int from entry_seen')).toBe(0);
    feedId = await store.upsertFeed(ctx.db, 'https://example.com/rss', {});
    await store.subscribe(ctx.db, userId, feedId, null, null);
    expect(await store.insertEntries(ctx.db, feedId, [original])).toBe(1);
  });
});
