import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ensureAdmin, issueSessionToken } from '../src/auth';
import { readConfig } from '../src/config';
import worker, { createApp } from '../src/index';
import { subscribeToUrl } from '../src/ingest';
import * as store from '../src/store';
import { makeTestDb, rssFeed, stubFetch, testEnv, type TestDb } from './helpers';

const cfg = readConfig(testEnv);
let ctx: TestDb;
let app: ReturnType<typeof createApp>;
let userId: number;
let cookie: string;

beforeEach(async () => {
  ctx = await makeTestDb();
  const user = await ensureAdmin(ctx.db, cfg);
  userId = user.id;
  cookie = `buffy_session=${await issueSessionToken(cfg, user)}`;
  app = createApp({ createDb: () => ({ db: ctx.db, close: async () => undefined }) });
});

afterEach(async () => ctx.close());

describe('web regressions', () => {
  test('Worker entry, login and health use the actual application', async () => {
    const setup = await worker.fetch(new Request('https://reader.example/login'), {});
    expect(setup.status).toBe(500);
    expect(await setup.text()).toContain('ADMIN_PASSWORD is not set.');
    const login = await app.request('/login', {}, testEnv);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('name="password"');
    const health = await app.request('/health', {}, testEnv);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const root = await app.request('/', {}, testEnv);
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toStartWith('/login?');
  });

  test('schedule-all requires authentication and works when signed in', async () => {
    const feedId = await store.upsertFeed(ctx.db, 'https://example.com/feed', {});
    await store.subscribe(ctx.db, userId, feedId, null, null);
    await ctx.db.execute("update feeds set next_fetch_at = now() + interval '1 day' where id = $1", [feedId]);
    const anonymous = await app.request('/refresh', { method: 'POST' }, testEnv);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toStartWith('/login?');
    expect(await ctx.db.value<boolean>('select next_fetch_at > now() from feeds where id = $1', [feedId])).toBe(true);
    const response = await app.request('/refresh', { method: 'POST', headers: { cookie } }, testEnv);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toStartWith('/feeds?');
    expect(await ctx.db.value<boolean>('select next_fetch_at <= now() from feeds where id = $1', [feedId])).toBe(true);
  });

  test('marking an open article unread does not immediately mark it read again', async () => {
    await subscribeToUrl(ctx.db, cfg, userId, 'https://example.com/feed', {
      fetchImpl: stubFetch(() => new Response(rssFeed([{ id: 'unread', title: 'Keep unread' }]), {
        headers: { 'content-type': 'application/rss+xml' },
      })),
    });
    const id = await ctx.db.value<string>('select item_id from entries limit 1');
    const opened = await app.request(`/item/${id}`, { headers: { cookie } }, testEnv);
    expect(opened.status).toBe(200);
    const response = await app.request(`/item/${id}/state`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', referer: `http://localhost/item/${id}` },
      body: 'read=false',
    }, testEnv);
    expect(response.status).toBe(302);
    const destination = response.headers.get('location')!;
    expect(new URL(destination, 'http://localhost').pathname).not.toBe(`/item/${id}`);
    await app.request(destination, { headers: { cookie } }, testEnv);
    expect(await ctx.db.value<boolean>('select read from entry_states where user_id = $1', [userId])).toBe(false);
  });

  test.each(['/\\attacker.example/path', '/\t/attacker.example/path', '//attacker.example/path'])(
    'login cannot redirect off-site through next=%s', async (next) => {
      const response = await app.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'test-password', next }),
      }, testEnv);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location')!, 'http://localhost').origin).toBe('http://localhost');
    },
  );

  test('login preserves a valid local return path', async () => {
    const response = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'test-password', next: '/?feed=1&q=hello' }),
    }, testEnv);
    expect(response.headers.get('location')).toBe('/?feed=1&q=hello');
  });

  test.each(['null', '[]', '"not an object"'])('state rejects non-object JSON %s', async (body) => {
    const response = await app.request('/api/state', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body,
    }, testEnv);
    expect(response.status).toBe(400);
  });

  test('state rejects text/plain JSON which can be posted by other sites', async () => {
    const response = await app.request('/api/state', {
      method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{"ids":["0000000000000001"],"read":true}',
    }, testEnv);
    expect(response.status).toBe(415);
  });

  test('browser writes reject cross-origin requests but allow same-origin requests', async () => {
    for (const path of ['/logout', '/refresh', '/mark-all-read']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }, testEnv);
      expect(response.status).toBe(403);
    }
    const response = await app.request('/refresh', {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    }, testEnv);
    expect(response.status).toBe(302);
  });

  test('rejects an oversized streamed body before parsing it', async () => {
    const chunk = new Uint8Array(1024 * 1024 + 1).fill(32);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.close(); },
    });
    const response = await app.request('/opml', {
      method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body,
    }, testEnv);
    expect(response.status).toBe(413);
  });

  test('too many OPML feeds cause no partial database imports', async () => {
    const xml = '<opml><body>' + Array.from({ length: 201 }, (_, i) =>
      `<outline xmlUrl="https://example.com/${i}" />`).join('') + '</body></opml>';
    const form = new FormData();
    form.append('opml', xml);
    const response = await app.request('/opml', { method: 'POST', headers: { cookie }, body: form }, testEnv);
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get('location')!)).toContain('每次最多导入');
    expect(await ctx.db.value<number>('select count(*)::int from subscriptions')).toBe(0);
  });

  test('private settings and API responses must not be cached', async () => {
    const response = await app.request('/settings', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const health = await app.request('/health', {}, testEnv);
    expect(health.headers.get('cache-control')).toContain('no-store');
  });
});
