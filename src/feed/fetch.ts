/** HTTP fetching for feeds, with conditional requests and feed autodiscovery. */

import { absoluteFeedUrl as absoluteUrl } from './url';

export interface FetchDocumentOptions {
  etag?: string | null;
  lastModified?: string | null;
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export type FetchDocumentResult =
  | {
      status: 'ok';
      httpStatus: number;
      text: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    }
  | { status: 'not-modified' }
  | { status: 'error'; error: string; httpStatus?: number };

const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';

function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
    charset =
      /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] ??
      /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      'utf-8';
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时';
    if (error.name === 'AbortError') return '请求被中止';
    return error.message;
  }
  return String(error);
}

export async function fetchDocument(
  url: string,
  options: FetchDocumentOptions,
  accept: string,
): Promise<FetchDocumentResult> {
  if (!absoluteUrl(url)) return { status: 'error', error: '订阅地址必须使用 http(s) 协议' };
  const fetcher = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? 1_500_000;
  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept,
  };
  if (options.etag) headers['if-none-match'] = options.etag;
  if (options.lastModified) headers['if-modified-since'] = options.lastModified;

  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { status: 'error', error: errorMessage(error) };
  }

  if (response.status === 304) return { status: 'not-modified' };
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return {
      status: 'error',
      httpStatus: response.status,
      error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    };
  }

  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return { status: 'error', httpStatus: response.status, error: '响应过大' };
  }

  // Stream with a hard cap: never buffer a multi-megabyte response.
  let buffer: Uint8Array;
  try {
    if (!response.body) {
      const raw = await response.arrayBuffer();
      if (raw.byteLength > maxBytes) {
        return { status: 'error', httpStatus: response.status, error: '响应过大' };
      }
      buffer = new Uint8Array(raw);
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { status: 'error', httpStatus: response.status, error: '响应过大' };
        }
        chunks.push(value);
      }
      buffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch (error) {
    return { status: 'error', httpStatus: response.status, error: errorMessage(error) };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = decodeBody(buffer, contentType);
  if (!text.trim()) {
    return { status: 'error', httpStatus: response.status, error: '响应内容为空' };
  }

  return {
    status: 'ok',
    httpStatus: response.status,
    text,
    contentType,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    finalUrl: response.url || url,
  };
}

export function fetchFeedDocument(
  url: string,
  options: FetchDocumentOptions,
): Promise<FetchDocumentResult> {
  return fetchDocument(url, options, FEED_ACCEPT);
}

export interface DiscoveredFeed {
  url: string;
  title: string | null;
  type: string | null;
}

function getAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Pure helper so callers that already downloaded a page can reuse it. */
export function discoverFeedsFromHtml(html: string, baseUrl: string): DiscoveredFeed[] {
  const found = new Map<string, DiscoveredFeed>();
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = (getAttribute(tag, 'rel') ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) continue;
    const type = (getAttribute(tag, 'type') ?? '').toLowerCase();
    const href = getAttribute(tag, 'href');
    if (!href) continue;
    const isFeedType = /(rss|atom|json)/.test(type);
    const isFeedHref = /(\.rss|\.xml|\.atom|\/feed|\/rss)(\?|$)/i.test(href);
    if (!isFeedType && !isFeedHref) continue;
    const url = absoluteUrl(decodeEntities(href), baseUrl);
    if (!url) continue;
    found.set(url, { url, title: getAttribute(tag, 'title'), type: type || null });
  }
  return [...found.values()];
}

export async function discoverFeeds(
  pageUrl: string,
  options: FetchDocumentOptions,
): Promise<DiscoveredFeed[]> {
  const result = await fetchDocument(
    pageUrl,
    { ...options, maxBytes: options.maxBytes ?? 1_000_000 },
    HTML_ACCEPT,
  );
  if (result.status !== 'ok') return [];
  return discoverFeedsFromHtml(result.text, result.finalUrl);
}
