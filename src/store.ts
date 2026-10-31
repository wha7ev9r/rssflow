/** All SQL used by the reader. Plain PostgreSQL, no ORM. */

import type { AppConfig } from './config';
import type { Db } from './db';
import type { Stream } from './stream';

export interface SubscriptionRow {
  feed_id: number;
  title: string | null;
  folder: string | null;
  url: string;
  site_url: string | null;
  feed_title: string | null;
  icon_url: string | null;
  last_fetch_ms: number | null;
  error_count: number;
  last_error: string | null;
  unread: number;
}

export interface EntryRow {
  id: number;
  item_id: string;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  content: string | null;
  enclosure_url: string | null;
  enclosure_type: string | null;
  published_ms: number;
  fetched_ms: number;
  feed_id: number;
  feed_url: string;
  feed_title: string;
  feed_site_url: string | null;
  feed_icon_url: string | null;
  folder: string | null;
  read: boolean;
  starred: boolean;
}

export interface PreparedItem {
  guid: string;
  itemId: string;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  content: string | null;
  enclosureUrl: string | null;
  enclosureType: string | null;
  publishedMs: number;
}

export interface FeedDueRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
}

const ENTRY_SELECT = `
  select e.id::int as id,
         e.item_id,
         e.url,
         e.title,
         e.author,
         e.summary,
         e.content,
         e.enclosure_url,
         e.enclosure_type,
         (extract(epoch from e.published_at) * 1000)::float8 as published_ms,
         (extract(epoch from e.fetched_at) * 1000)::float8 as fetched_ms,
         f.id::int as feed_id,
         f.url as feed_url,
         coalesce(nullif(s.title, ''), nullif(f.title, ''), f.url) as feed_title,
         f.site_url as feed_site_url,
         f.icon_url as feed_icon_url,
         s.folder,
         coalesce(st.read, false) as read,
         coalesce(st.starred, false) as starred
  from entries e
  join feeds f on f.id = e.feed_id
  join subscriptions s on s.feed_id = e.feed_id and s.user_id = $1
  left join entry_states st on st.entry_id = e.id and st.user_id = $1
`;

type Param = (value: unknown) => string;

function streamClauses(stream: Stream, p: Param): string[] {
  switch (stream.kind) {
    case 'unread':
      return ['coalesce(st.read, false) = false'];
    case 'read':
      return ['st.read = true'];
    case 'starred':
      return ['st.starred = true'];
    case 'feed': {
      const ref = p(stream.ref);
      return [`(f.url = ${ref} or f.id::text = ${ref})`];
    }
    case 'label':
      return [`s.folder = ${p(stream.label)}`];
    default:
      return [];
  }
}

function searchClauses(search: string | null | undefined, p: Param): string[] {
  const term = (search ?? '').trim();
  if (!term) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const value = p(pattern);
  return [`(e.title ilike ${value} or e.summary ilike ${value} or e.content ilike ${value})`];
}

export interface ListEntriesOptions {
  stream: Stream;
  search?: string | null;
  limit?: number;
  before?: { ms: number; id: number } | null;
  afterMs?: number | null;
  order?: 'asc' | 'desc';
  /** Extra state filters used by Google Reader's xt/it parameters. */
  unreadOnly?: boolean;
  readOnly?: boolean;
}

export async function listEntries(
  db: Db,
  userId: number,
  options: ListEntriesOptions,
): Promise<{ entries: EntryRow[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const params: unknown[] = [userId];
  const p: Param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = [...streamClauses(options.stream, p), ...searchClauses(options.search, p)];
  if (options.unreadOnly) clauses.push('coalesce(st.read, false) = false');
  if (options.readOnly) clauses.push('st.read = true');
  if (options.before) {
    const ms = p(options.before.ms);
    const id = p(options.before.id);
    const op = order === 'asc' ? '>' : '<';
    clauses.push(`(e.published_at, e.id) ${op} (to_timestamp(${ms} / 1000.0), ${id}::bigint)`);
  }
  if (options.afterMs != null) {
    clauses.push(`e.published_at >= to_timestamp(${p(options.afterMs)} / 1000.0)`);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  const rows = await db.query<EntryRow>(
    `${ENTRY_SELECT} ${where} order by e.published_at ${order}, e.id ${order} limit ${limit + 1}`,
    params,
  );
  const hasMore = rows.length > limit;
  return { entries: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export function normalizeItemId(raw: string): string {
  const value = raw.trim();
  return value.startsWith('tag:google.com,2005:reader/item/')
    ? value.slice('tag:google.com,2005:reader/item/'.length)
    : value;
}

export async function getEntryByItemId(
  db: Db,
  userId: number,
  rawItemId: string,
): Promise<EntryRow | null> {
  return db.one<EntryRow>(`${ENTRY_SELECT} where e.item_id = $2 limit 1`, [
    userId,
    normalizeItemId(rawItemId),
  ]);
}

export async function getEntriesByItemIds(
  db: Db,
  userId: number,
  rawItemIds: string[],
): Promise<EntryRow[]> {
  if (rawItemIds.length === 0) return [];
  const ids = rawItemIds.map(normalizeItemId);
  return db.query<EntryRow>(
    `${ENTRY_SELECT} where e.item_id = any($2::text[]) order by e.published_at desc, e.id desc`,
    [userId, ids],
  );
}

export async function setEntryStateByItemIds(
  db: Db,
  userId: number,
  rawItemIds: string[],
  read: boolean | null,
  starred: boolean | null,
): Promise<number> {
  if (rawItemIds.length === 0 || (read == null && starred == null)) return 0;
  const ids = rawItemIds.map(normalizeItemId).filter(Boolean);
  if (ids.length === 0) return 0;
  return db.execute(
    `insert into entry_states (user_id, entry_id, read, starred)
     select $1, e.id, coalesce($3::boolean, false), coalesce($4::boolean, false)
     from entries e
     join subscriptions s on s.feed_id = e.feed_id and s.user_id = $1
     where e.item_id = any($2::text[])
     on conflict (user_id, entry_id) do update
       set read = case when $3::boolean is null then entry_states.read else $3::boolean end,
           starred = case when $4::boolean is null then entry_states.starred else $4::boolean end,
           updated_at = now()`,
    [userId, ids, read, starred],
  );
}

export async function markAllRead(
  db: Db,
  userId: number,
  stream: Stream,
  search: string | null,
  maxPublishedMs: number,
): Promise<number> {
  const params: unknown[] = [userId];
  const p: Param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = [...streamClauses(stream, p), ...searchClauses(search, p)];
  clauses.push(`e.published_at <= to_timestamp(${p(maxPublishedMs)} / 1000.0)`);
  return db.execute(
    `insert into entry_states (user_id, entry_id, read)
     select $1, e.id, true
     from entries e
     join subscriptions s on s.feed_id = e.feed_id and s.user_id = $1
     join feeds f on f.id = e.feed_id
     left join entry_states st on st.entry_id = e.id and st.user_id = $1
     where ${clauses.join(' and ')}
       and not exists (
         select 1 from entry_states x
         where x.user_id = $1 and x.entry_id = e.id and x.read
       )
     on conflict (user_id, entry_id) do update set read = true, updated_at = now()`,
    params,
  );
}

export async function listSubscriptions(db: Db, userId: number): Promise<SubscriptionRow[]> {
  return db.query<SubscriptionRow>(
    `select s.feed_id::int as feed_id,
            s.title,
            s.folder,
            f.url,
            f.site_url,
            f.title as feed_title,
            f.icon_url,
            (extract(epoch from f.last_fetch_at) * 1000)::float8 as last_fetch_ms,
            f.error_count,
            f.last_error,
            (select count(*)::int
             from entries e
             where e.feed_id = f.id
               and not exists (
                 select 1 from entry_states st
                 where st.user_id = $1 and st.entry_id = e.id and st.read
               )) as unread
     from subscriptions s
     join feeds f on f.id = s.feed_id
     where s.user_id = $1
     order by s.folder nulls first, lower(coalesce(nullif(s.title, ''), nullif(f.title, ''), f.url))`,
    [userId],
  );
}

export async function starredCount(db: Db, userId: number): Promise<number> {
  return (await db.value<number>(
    'select count(*)::int from entry_states where user_id = $1 and starred',
    [userId],
  )) ?? 0;
}

export function totalUnread(subscriptions: SubscriptionRow[]): number {
  return subscriptions.reduce((sum, sub) => sum + sub.unread, 0);
}

export function folderUnread(subscriptions: SubscriptionRow[]): Map<string, number> {
  const folders = new Map<string, number>();
  for (const sub of subscriptions) {
    if (!sub.folder) continue;
    folders.set(sub.folder, (folders.get(sub.folder) ?? 0) + sub.unread);
  }
  return folders;
}

export async function listFeedsDue(db: Db, limit: number): Promise<FeedDueRow[]> {
  return db.query<FeedDueRow>(
    `select f.id::int as id, f.url, f.etag, f.last_modified
     from feeds f
     where f.next_fetch_at <= now()
       and exists (select 1 from subscriptions s where s.feed_id = f.id)
     order by f.next_fetch_at asc
     limit $1`,
    [limit],
  );
}

export async function countFeedsDue(db: Db): Promise<number> {
  return (await db.value<number>(
    `select count(*)::int from feeds f
     where f.next_fetch_at <= now()
       and exists (select 1 from subscriptions s where s.feed_id = f.id)`,
  )) ?? 0;
}

export async function claimFeeds(db: Db, ids: number[], leaseSeconds = 300): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(
    `update feeds set next_fetch_at = now() + make_interval(secs => $2)
     where id = any($1::bigint[])`,
    [ids.map(String), leaseSeconds],
  );
}

export async function getFeedById(db: Db, feedId: number): Promise<FeedDueRow | null> {
  return db.one<FeedDueRow>(
    'select id::int as id, url, etag, last_modified from feeds where id = $1',
    [feedId],
  );
}

export async function upsertFeed(
  db: Db,
  url: string,
  meta: { title?: string | null; siteUrl?: string | null; description?: string | null; iconUrl?: string | null },
): Promise<number> {
  const row = await db.one<{ id: number }>(
    `insert into feeds (url, title, site_url, description, icon_url, next_fetch_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (url) do update set
       title = coalesce(feeds.title, excluded.title),
       site_url = coalesce(feeds.site_url, excluded.site_url),
       description = coalesce(feeds.description, excluded.description),
       icon_url = coalesce(feeds.icon_url, excluded.icon_url)
     returning id::int as id`,
    [url, meta.title ?? null, meta.siteUrl ?? null, meta.description ?? null, meta.iconUrl ?? null],
  );
  if (!row) throw new Error('Could not store the feed');
  return row.id;
}

export async function subscribe(
  db: Db,
  userId: number,
  feedId: number,
  title: string | null,
  folder: string | null,
): Promise<void> {
  await db.execute(
    `insert into subscriptions (user_id, feed_id, title, folder)
     values ($1, $2, $3, $4)
     on conflict (user_id, feed_id) do update set
       title = coalesce(excluded.title, subscriptions.title),
       folder = coalesce(excluded.folder, subscriptions.folder)`,
    [userId, feedId, title, folder],
  );
}

export async function updateSubscription(
  db: Db,
  userId: number,
  feedId: number,
  patch: { title?: string | null; folder?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [userId, feedId];
  if ('title' in patch) {
    params.push(patch.title ?? null);
    sets.push(`title = $${params.length}`);
  }
  if ('folder' in patch) {
    params.push(patch.folder ?? null);
    sets.push(`folder = $${params.length}`);
  }
  if (sets.length === 0) return;
  await db.execute(
    `update subscriptions set ${sets.join(', ')} where user_id = $1 and feed_id = $2`,
    params,
  );
}

export async function getSubscription(
  db: Db,
  userId: number,
  feedRef: string,
): Promise<{ feed_id: number; url: string; title: string | null; folder: string | null } | null> {
  return db.one<{ feed_id: number; url: string; title: string | null; folder: string | null }>(
    `select s.feed_id::int as feed_id, f.url, s.title, s.folder
     from subscriptions s
     join feeds f on f.id = s.feed_id
     where s.user_id = $1 and (f.url = $2 or f.id::text = $2)
     limit 1`,
    [userId, feedRef],
  );
}

export async function removeSubscription(db: Db, userId: number, feedId: number): Promise<void> {
  await db.execute('delete from subscriptions where user_id = $1 and feed_id = $2', [userId, feedId]);
  await db.execute(
    'delete from feeds f where f.id = $1 and not exists (select 1 from subscriptions s where s.feed_id = f.id)',
    [feedId],
  );
}

export async function renameFolder(
  db: Db,
  userId: number,
  from: string,
  to: string | null,
): Promise<void> {
  await db.execute('update subscriptions set folder = $3 where user_id = $1 and folder = $2', [
    userId,
    from,
    to,
  ]);
}

export async function scheduleFeed(db: Db, feedId: number): Promise<void> {
  await db.execute('update feeds set next_fetch_at = now() where id = $1', [feedId]);
}

export async function scheduleAll(db: Db, userId: number): Promise<number> {
  return db.execute(
    `update feeds set next_fetch_at = now()
     where exists (select 1 from subscriptions s where s.feed_id = feeds.id and s.user_id = $1)`,
    [userId],
  );
}

export async function insertEntries(
  db: Db,
  feedId: number,
  items: PreparedItem[],
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < items.length; start += 25) {
    const chunk = items.slice(start, start + 25);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const item of chunk) {
      const base = params.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, to_timestamp($${base + 11} / 1000.0))`,
      );
      params.push(
        feedId,
        item.guid,
        item.itemId,
        item.url,
        item.title,
        item.author,
        item.summary,
        item.content,
        item.enclosureUrl,
        item.enclosureType,
        item.publishedMs,
      );
    }
    const rows = await db.query<{ id: number }>(
      `insert into entries (feed_id, guid, item_id, url, title, author, summary, content, enclosure_url, enclosure_type, published_at)
       values ${values.join(', ')}
       on conflict do nothing
       returning id`,
      params,
    );
    inserted += rows.length;
  }
  return inserted;
}

export async function updateFeedMeta(
  db: Db,
  feedId: number,
  meta: {
    title: string | null;
    siteUrl: string | null;
    description: string | null;
    iconUrl: string | null;
    etag: string | null;
    lastModified: string | null;
  },
): Promise<void> {
  await db.execute(
    `update feeds set
       title = coalesce($2, title),
       site_url = coalesce($3, site_url),
       description = coalesce($4, description),
       icon_url = coalesce($5, icon_url),
       etag = $6,
       last_modified = $7
     where id = $1`,
    [feedId, meta.title, meta.siteUrl, meta.description, meta.iconUrl, meta.etag, meta.lastModified],
  );
}

export async function markFeedSuccess(
  db: Db,
  feedId: number,
  httpStatus: number,
  nextSeconds: number,
): Promise<void> {
  await db.execute(
    `update feeds set
       last_fetch_at = now(),
       next_fetch_at = now() + make_interval(secs => $2),
       last_status = $3,
       error_count = 0,
       last_error = null
     where id = $1`,
    [feedId, nextSeconds, httpStatus],
  );
}

export async function markFeedError(
  db: Db,
  feedId: number,
  httpStatus: number,
  message: string,
  baseSeconds: number,
): Promise<void> {
  await db.execute(
    `update feeds set
       last_fetch_at = now(),
       last_status = $2,
       last_error = $3,
       error_count = error_count + 1,
       next_fetch_at = now() + make_interval(
         secs => case
           when error_count >= 9 then 86400
           else least(86400, $4::float8 * power(2, least(error_count, 5)))
         end
       )
     where id = $1`,
    [feedId, httpStatus, message.slice(0, 500), baseSeconds],
  );
}

export async function settingsCounts(
  db: Db,
  userId: number,
): Promise<{ feeds: number; entries: number; read: number; starred: number }> {
  const row = await db.one<{ feeds: number; entries: number; read: number; starred: number }>(
    `select
       (select count(*)::int from subscriptions where user_id = $1) as feeds,
       (select count(*)::int from entries e
          join subscriptions s on s.feed_id = e.feed_id and s.user_id = $1) as entries,
       (select count(*)::int from entry_states where user_id = $1 and read) as read,
       (select count(*)::int from entry_states where user_id = $1 and starred) as starred`,
    [userId],
  );
  return row ?? { feeds: 0, entries: 0, read: 0, starred: 0 };
}

export async function cleanup(
  db: Db,
  cfg: AppConfig,
): Promise<{ expired: number; trimmed: number }> {
  const expired = await db.execute(
    `delete from entries e
     using entry_states st
     where st.entry_id = e.id
       and st.read = true
       and st.starred = false
       and e.published_at < now() - make_interval(days => $1)`,
    [cfg.retentionDays],
  );
  const trimmed = await db.execute(
    `delete from entries
     where id in (
       select id from (
         select e2.id,
                row_number() over (partition by e2.feed_id order by e2.published_at desc, e2.id desc) as rn
         from entries e2
         where not exists (
           select 1 from entry_states st where st.entry_id = e2.id and st.starred
         )
       ) ranked
       where ranked.rn > $1
     )`,
    [cfg.maxEntriesPerFeed],
  );
  await db.execute(
    'delete from feeds f where not exists (select 1 from subscriptions s where s.feed_id = f.id)',
  );
  return { expired, trimmed };
}
