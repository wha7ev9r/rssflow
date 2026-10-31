/** Feed refresh pipeline and subscription creation. */

import type { AppConfig } from './config';
import type { Db } from './db';
import { discoverFeedsFromHtml, fetchFeedDocument } from './feed/fetch';
import { parseFeedDocument, type ParsedFeed } from './feed/parse';
import * as store from './store';
import { sha256Hex } from './util';

export interface FeedRef {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
}

export interface RefreshOutcome {
  feedId: number;
  status: 'updated' | 'not-modified' | 'error';
  inserted: number;
  error?: string;
}

export interface RefreshReport {
  processed: number;
  inserted: number;
  errors: number;
  remaining: number;
  results: RefreshOutcome[];
}

export interface SubscribeOutcome {
  feedId: number;
  url: string;
  title: string;
  created: boolean;
  warning: string | null;
}

export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function nextFetchSeconds(cfg: AppConfig): number {
  const jitter = Math.floor(Math.random() * 90);
  return cfg.fetchIntervalMinutes * 60 + jitter;
}

async function prepareItems(
  feedUrl: string,
  parsed: ParsedFeed,
  cfg: AppConfig,
): Promise<store.PreparedItem[]> {
  const prepared: store.PreparedItem[] = [];
  for (const item of parsed.items) {
    if (prepared.length >= cfg.maxItemsPerFetch) break;
    const itemId = (await sha256Hex(`${feedUrl}\n${item.guid}`)).slice(0, 16);
    prepared.push({
      guid: item.guid,
      itemId,
      url: item.url,
      title: item.title,
      author: item.author,
      summary: item.summary,
      content: item.content,
      enclosureUrl: item.enclosureUrl,
      enclosureType: item.enclosureType,
      publishedMs: item.publishedMs,
    });
  }
  return prepared;
}

async function persistParsedFeed(
  db: Db,
  cfg: AppConfig,
  feedId: number,
  feedUrl: string,
  parsed: ParsedFeed,
  meta: { etag: string | null; lastModified: string | null; httpStatus: number },
): Promise<number> {
  const items = await prepareItems(feedUrl, parsed, cfg);
  const inserted = await store.insertEntries(db, feedId, items);
  await store.updateFeedMeta(db, feedId, {
    title: parsed.title || null,
    siteUrl: parsed.siteUrl,
    description: parsed.description,
    iconUrl: parsed.iconUrl,
    etag: meta.etag,
    lastModified: meta.lastModified,
  });
  await store.markFeedSuccess(db, feedId, meta.httpStatus, nextFetchSeconds(cfg));
  return inserted;
}

export async function refreshFeed(
  db: Db,
  cfg: AppConfig,
  feed: FeedRef,
  fetchImpl?: typeof fetch,
): Promise<RefreshOutcome> {
  const document = await fetchFeedDocument(feed.url, {
    etag: feed.etag,
    lastModified: feed.last_modified,
    userAgent: cfg.userAgent,
    timeoutMs: 12_000,
    fetchImpl,
  });

  if (document.status === 'not-modified') {
    await store.markFeedSuccess(db, feed.id, 304, nextFetchSeconds(cfg));
    return { feedId: feed.id, status: 'not-modified', inserted: 0 };
  }

  if (document.status === 'error') {
    await store.markFeedError(
      db,
      feed.id,
      document.httpStatus ?? 0,
      document.error,
      cfg.fetchIntervalMinutes * 60,
    );
    return { feedId: feed.id, status: 'error', inserted: 0, error: document.error };
  }

  let parsed: ParsedFeed;
  try {
    parsed = parseFeedDocument(document.text, feed.url, document.finalUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.markFeedError(db, feed.id, document.httpStatus, message, cfg.fetchIntervalMinutes * 60);
    return { feedId: feed.id, status: 'error', inserted: 0, error: message };
  }

  const inserted = await persistParsedFeed(db, cfg, feed.id, feed.url, parsed, {
    etag: document.etag,
    lastModified: document.lastModified,
    httpStatus: document.httpStatus,
  });
  return { feedId: feed.id, status: 'updated', inserted };
}

/**
 * Add a subscription. Tries the URL as a feed first; if it is an HTML page,
 * autodiscovers a feed link and subscribes to that instead.
 */
export async function subscribeToUrl(
  db: Db,
  cfg: AppConfig,
  userId: number,
  rawUrl: string,
  options: { folder?: string | null; title?: string | null; refresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SubscribeOutcome> {
  const normalized = normalizeFeedUrl(rawUrl);
  if (!normalized) throw new Error('订阅地址无效，请输入 http(s) 链接');

  const folder = options.folder?.trim() || null;
  const customTitle = options.title?.trim() || null;
  let feedUrl = normalized;
  let parsed: ParsedFeed | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  let httpStatus = 200;
  let warning: string | null = null;

  const document = await fetchFeedDocument(normalized, {
    userAgent: cfg.userAgent,
    timeoutMs: 12_000,
    fetchImpl: options.fetchImpl,
  });

  if (document.status === 'ok') {
    etag = document.etag;
    lastModified = document.lastModified;
    httpStatus = document.httpStatus;
    try {
      parsed = parseFeedDocument(document.text, normalized, document.finalUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const discovered = discoverFeedsFromHtml(document.text, document.finalUrl);
      if (discovered.length > 0) {
        feedUrl = discovered[0].url;
        const second = await fetchFeedDocument(feedUrl, {
          userAgent: cfg.userAgent,
          timeoutMs: 12_000,
          fetchImpl: options.fetchImpl,
        });
        if (second.status === 'ok') {
          etag = second.etag;
          lastModified = second.lastModified;
          httpStatus = second.httpStatus;
          try {
            parsed = parseFeedDocument(second.text, feedUrl, second.finalUrl);
          } catch {
            warning = '已找到 Feed 地址，但暂时无法解析，稍后会自动重试';
          }
        } else {
          warning = '已找到 Feed 地址，但抓取失败，稍后会自动重试';
        }
      } else {
        warning = `已添加，但暂时无法解析：${message}`;
      }
    }
  } else if (document.status === 'error') {
    warning = `已添加，首次抓取失败：${document.error}`;
  } else {
    warning = '已添加，稍后会自动抓取';
  }

  const existing = await store.getSubscription(db, userId, feedUrl);
  const feedId = await store.upsertFeed(db, feedUrl, {
    title: parsed?.title ?? null,
    siteUrl: parsed?.siteUrl ?? null,
    description: parsed?.description ?? null,
    iconUrl: parsed?.iconUrl ?? null,
  });
  await store.subscribe(db, userId, feedId, customTitle, folder);

  if (parsed && options.refresh !== false) {
    await persistParsedFeed(db, cfg, feedId, feedUrl, parsed, { etag, lastModified, httpStatus });
  } else if (!parsed) {
    await store.scheduleFeed(db, feedId);
  }

  return {
    feedId,
    url: feedUrl,
    title: customTitle ?? parsed?.title ?? new URL(feedUrl).hostname,
    created: !existing,
    warning,
  };
}

export async function runRefresh(
  db: Db,
  cfg: AppConfig,
  options: { limit?: number; feedId?: number; fetchImpl?: typeof fetch; deadlineMs?: number } = {},
): Promise<RefreshReport> {
  const started = Date.now();
  const deadline = options.deadlineMs ?? 20_000;
  const limit = Math.max(1, Math.min(20, options.limit ?? cfg.maxFeedsPerRun));

  let feeds: FeedRef[];
  if (options.feedId) {
    const feed = await store.getFeedById(db, options.feedId);
    feeds = feed ? [feed] : [];
  } else {
    feeds = await store.listFeedsDue(db, limit);
  }

  if (feeds.length > 0) await store.claimFeeds(db, feeds.map((feed) => feed.id));

  const results: RefreshOutcome[] = [];
  for (const [index, feed] of feeds.entries()) {
    if (Date.now() - started > deadline) {
      await store.claimFeeds(db, feeds.slice(index).map((item) => item.id), 2);
      break;
    }
    try {
      results.push(await refreshFeed(db, cfg, feed, options.fetchImpl));
    } catch (error) {
      results.push({
        feedId: feed.id,
        status: 'error',
        inserted: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = await store.countFeedsDue(db);
  return {
    processed: results.length,
    inserted: results.reduce((sum, result) => sum + result.inserted, 0),
    errors: results.filter((result) => result.status === 'error').length,
    remaining,
    results,
  };
}
