/** Feed parsing: RSS 0.9x/2.0, Atom, RDF (RSS 1.0) and JSON Feed. */

import { XMLParser } from 'fast-xml-parser';
import { absoluteUrl, escapeHtml } from '../util';

export type FeedFormat = 'rss' | 'atom' | 'rdf' | 'json';

export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  enclosureUrl: string | null;
  enclosureType: string | null;
  publishedMs: number;
  categories: string[];
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  items: ParsedItem[];
  format: FeedFormat;
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
});

type Node = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function first(value: unknown): unknown {
  return asArray(value)[0];
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attr(node: unknown, name: string): string | null {
  if (!isNode(node)) return null;
  const value = node[`@_${name}`];
  if (value == null) return null;
  return String(value).trim();
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** Serialize one element (and its children) back to HTML. */
function serializeElement(tag: string, node: unknown): string {
  if (Array.isArray(node)) return node.map((child) => serializeElement(tag, child)).join('');
  if (!isNode(node)) return `<${tag}>${serializeChildren(node)}</${tag}>`;

  const attributes = Object.entries(node)
    .filter(([key]) => key.startsWith('@_'))
    .map(([key, value]) => ` ${key.slice(2)}="${escapeAttr(String(value))}"`)
    .join('');

  let inner = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text') {
      inner += escapeText(String(value ?? ''));
      continue;
    }
    if (key.startsWith('@_')) continue;
    for (const child of asArray(value)) inner += serializeElement(key, child);
  }
  return `<${tag}${attributes}>${inner}</${tag}>`;
}

/** Serialize a parsed XML subtree back to HTML (used for Atom xhtml content). */
function serializeChildren(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return escapeText(node);
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(serializeChildren).join('');
  if (!isNode(node)) return '';

  let output = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text') {
      output += escapeText(String(value ?? ''));
      continue;
    }
    if (key.startsWith('@_')) continue;
    for (const child of asArray(value)) output += serializeElement(key, child);
  }
  return output;
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (isNode(value)) {
    if ('#text' in value) return textOf(value['#text']);
    return serializeChildren(value);
  }
  return '';
}

function cleanText(value: unknown): string {
  return textOf(value).replace(/\s+/g, ' ').trim();
}

function parseDate(value: unknown): number | null {
  const raw = cleanText(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  // Feeds occasionally publish dates years in the future; keep the list sane.
  const now = Date.now();
  return parsed > now + 60 * 60 * 1000 ? now : parsed;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

function textToHtml(value: string): string {
  const escaped = escapeHtml(value.trim());
  return `<p>${escaped.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function atomHtmlContent(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') {
    return node.trim() ? (looksLikeHtml(node) ? node : textToHtml(node)) : null;
  }
  if (!isNode(node)) return null;

  const type = (attr(node, 'type') ?? '').toLowerCase();
  if (type === 'xhtml' || node.div != null) {
    const inner = node.div ?? node;
    const html = serializeChildren(inner).trim();
    return html || null;
  }
  const raw = textOf(node);
  if (!raw.trim()) return null;
  if (type === 'text' || (type === '' && !looksLikeHtml(raw))) return textToHtml(raw);
  return raw;
}

function categoriesOf(node: Node): string[] {
  return asArray(node.category)
    .map((entry) => attr(entry, 'term') ?? cleanText(entry))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function rssEnclosure(node: Node, baseUrl: string): { url: string | null; type: string | null } {
  const candidates: unknown[] = [
    ...asArray(node.enclosure),
    ...asArray(node.content),
    ...asArray(isNode(node.group) ? node.group.content : null),
  ];
  for (const candidate of candidates) {
    if (!isNode(candidate)) continue;
    const href = attr(candidate, 'url') ?? attr(candidate, 'href');
    const resolved = absoluteUrl(href, baseUrl);
    if (resolved) return { url: resolved, type: attr(candidate, 'type') };
  }
  return { url: null, type: null };
}

function atomEnclosure(node: Node, baseUrl: string): { url: string | null; type: string | null } {
  for (const link of asArray(node.link)) {
    if (!isNode(link)) continue;
    if ((attr(link, 'rel') ?? '').toLowerCase() !== 'enclosure') continue;
    const resolved = absoluteUrl(attr(link, 'href'), baseUrl);
    if (resolved) return { url: resolved, type: attr(link, 'type') };
  }
  return { url: null, type: null };
}

function atomLinks(node: Node): { alternate: string | null; site: string | null } {
  let alternate: string | null = null;
  let site: string | null = null;
  for (const link of asArray(node.link)) {
    if (!isNode(link)) continue;
    const rel = (attr(link, 'rel') ?? 'alternate').toLowerCase();
    const href = attr(link, 'href');
    if (!href) continue;
    if (rel === 'alternate') {
      alternate ??= href;
    } else if (rel === 'self' && !site) {
      site = null;
    }
  }
  return { alternate, site };
}

function finishItems(items: ParsedItem[], now: number): ParsedItem[] {
  const seen = new Set<string>();
  const result: ParsedItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!item.guid) continue;
    if (seen.has(item.guid)) continue;
    seen.add(item.guid);
    result.push({
      ...item,
      publishedMs: item.publishedMs || now - index * 1000,
    });
  }
  result.sort((a, b) => b.publishedMs - a.publishedMs);
  return result;
}

function parseRss(doc: Node, feedUrl: string, baseUrl: string): ParsedFeed {
  const rdfRoot = isNode(doc.RDF) ? doc.RDF : isNode(doc.rdf) ? doc.rdf : null;
  const rssRoot = isNode(doc.rss) ? doc.rss : rdfRoot ?? doc;
  const channel = (first(rssRoot.channel) ?? first(doc.channel) ?? {}) as Node;
  const rawItems = rdfRoot ? asArray(rdfRoot.item) : asArray(channel.item);

  if (rawItems.length === 0 && !channel.title && !channel.link) {
    throw new FeedParseError('XML 中没有找到 RSS/Atom 内容');
  }

  const image = isNode(channel.image) ? channel.image : null;
  const iconUrl =
    absoluteUrl(isNode(channel.image) ? textOf(channel.image.url) : null, baseUrl) ??
    absoluteUrl(isNode(image) ? textOf(image.url) : null, baseUrl);
  const siteUrl =
    absoluteUrl(cleanText(channel.link), baseUrl) ??
    absoluteUrl(attr(channel.link, 'href'), baseUrl) ??
    absoluteUrl(attr(channel.atomLink, 'href'), baseUrl);
  const now = Date.now();

  const items: ParsedItem[] = [];
  for (const raw of rawItems) {
    if (!isNode(raw)) continue;
    const title = cleanText(raw.title);
    const link =
      absoluteUrl(cleanText(raw.link), baseUrl) ??
      absoluteUrl(attr(raw.link, 'href'), baseUrl) ??
      absoluteUrl(cleanText(raw.guid), baseUrl);
    const description = textOf(raw.description).trim();
    const possibleContent = typeof raw.content === 'string' ? raw.content.trim() : '';
    const content = textOf(raw.encoded).trim() || possibleContent || description;
    const guid =
      cleanText(raw.guid) ||
      cleanText(raw.id) ||
      link ||
      `${title}|${cleanText(raw.pubDate) || cleanText(raw.date)}`;
    if (!guid) continue;
    const enclosure = rssEnclosure(raw, baseUrl);
    items.push({
      guid: guid.slice(0, 2048),
      url: link,
      title: title || '(无标题)',
      author: cleanText(raw.author) || cleanText(raw.creator) || null,
      summary: description || null,
      content: content || null,
      enclosureUrl: enclosure.url,
      enclosureType: enclosure.type,
      publishedMs:
        parseDate(raw.pubDate) ??
        parseDate(raw.published) ??
        parseDate(raw.date) ??
        parseDate(raw.updated) ??
        parseDate(raw.issued) ??
        0,
      categories: categoriesOf(raw),
    });
  }

  return {
    title: cleanText(channel.title) || hostnameOf(feedUrl),
    siteUrl: siteUrl ?? null,
    description: cleanText(channel.description) || null,
    iconUrl: iconUrl ?? null,
    items: finishItems(items, now),
    format: rdfRoot || isNode(doc.RDF) ? 'rdf' : 'rss',
  };
}

function parseAtom(doc: Node, feedUrl: string, baseUrl: string): ParsedFeed {
  const feed = doc.feed as Node;
  const links = atomLinks(feed);
  const now = Date.now();
  const items: ParsedItem[] = [];

  for (const raw of asArray(feed.entry)) {
    if (!isNode(raw)) continue;
    const entryLinks = atomLinks(raw);
    const link = absoluteUrl(entryLinks.alternate, baseUrl);
    const title = cleanText(raw.title) || '(无标题)';
    const authorNode = isNode(raw.author) ? raw.author : null;
    const guid =
      cleanText(raw.id) ||
      link ||
      `${title}|${cleanText(raw.published) || cleanText(raw.updated)}`;
    if (!guid) continue;
    const enclosure = atomEnclosure(raw, baseUrl);
    const summaryHtml = atomHtmlContent(raw.summary);
    const contentHtml = atomHtmlContent(raw.content);
    items.push({
      guid: guid.slice(0, 2048),
      url: link,
      title,
      author:
        (authorNode ? cleanText(authorNode.name) || cleanText(authorNode) : '') ||
        cleanText(raw.author) ||
        null,
      summary: summaryHtml,
      content: contentHtml ?? summaryHtml,
      enclosureUrl: enclosure.url,
      enclosureType: enclosure.type,
      publishedMs:
        parseDate(raw.published) ?? parseDate(raw.updated) ?? parseDate(raw.issued) ?? 0,
      categories: categoriesOf(raw),
    });
  }

  return {
    title: cleanText(feed.title) || hostnameOf(feedUrl),
    siteUrl: absoluteUrl(links.alternate, baseUrl),
    description: cleanText(feed.subtitle) || null,
    iconUrl:
      absoluteUrl(cleanText(feed.icon), baseUrl) ?? absoluteUrl(cleanText(feed.logo), baseUrl),
    items: finishItems(items, now),
    format: 'atom',
  };
}

function parseJsonFeed(payload: unknown, feedUrl: string, baseUrl: string): ParsedFeed {
  if (!isNode(payload) || !Array.isArray(payload.items)) {
    throw new FeedParseError('JSON Feed 缺少 items 数组');
  }
  const feed = payload as Node;
  const items: ParsedItem[] = [];
  const now = Date.now();

  for (const raw of asArray(feed.items)) {
    if (!isNode(raw)) continue;
    const title = cleanText(raw.title) || '(无标题)';
    const url =
      absoluteUrl(cleanText(raw.url), baseUrl) ?? absoluteUrl(cleanText(raw.external_url), baseUrl);
    const contentHtml =
      typeof raw.content_html === 'string'
        ? raw.content_html
        : typeof raw.content_text === 'string'
          ? textToHtml(raw.content_text)
          : null;
    const summary =
      typeof raw.summary === 'string' && raw.summary.trim()
        ? looksLikeHtml(raw.summary)
          ? raw.summary
          : textToHtml(raw.summary)
        : null;
    const attachment = first(raw.attachments);
    const authors = isNode(raw.author) ? [raw.author] : asArray(raw.authors);
    const author = isNode(authors[0]) ? cleanText(authors[0].name) : cleanText(authors[0]);
    const guid =
      cleanText(raw.id) || url || `${title}|${cleanText(raw.date_published)}`;
    if (!guid) continue;
    items.push({
      guid: guid.slice(0, 2048),
      url,
      title,
      author: author || null,
      summary,
      content: contentHtml ?? summary,
      enclosureUrl: isNode(attachment) ? absoluteUrl(cleanText(attachment.url), baseUrl) : null,
      enclosureType: isNode(attachment) ? cleanText(attachment.mime_type) || null : null,
      publishedMs: parseDate(raw.date_published) ?? parseDate(raw.date_modified) ?? 0,
      categories: asArray(raw.tags).map(cleanText).filter(Boolean).slice(0, 20),
    });
  }

  return {
    title: cleanText(feed.title) || hostnameOf(feedUrl),
    siteUrl: absoluteUrl(cleanText(feed.home_page_url), baseUrl),
    description: cleanText(feed.description) || null,
    iconUrl:
      absoluteUrl(cleanText(feed.icon), baseUrl) ?? absoluteUrl(cleanText(feed.favicon), baseUrl),
    items: finishItems(items, now),
    format: 'json',
  };
}

/**
 * Parse a feed document. `feedUrl` is the canonical subscription URL, while
 * `baseUrl` is where the document was actually served (after redirects) and is
 * used to resolve relative links.
 */
export function parseFeedDocument(text: string, feedUrl: string, baseUrl?: string): ParsedFeed {
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new FeedParseError('响应内容为空');
  if (/^<!doctype\s+html/i.test(content) || /^<html[\s>]/i.test(content)) {
    throw new FeedParseError('这是一个 HTML 页面，不是 Feed');
  }

  if (content.startsWith('{') || content.startsWith('[')) {
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch {
      throw new FeedParseError('JSON 解析失败');
    }
    return parseJsonFeed(payload, feedUrl, baseUrl ?? feedUrl);
  }

  let document: Node;
  try {
    document = parser.parse(content) as Node;
  } catch (error) {
    throw new FeedParseError(`XML 解析失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  if (!isNode(document)) throw new FeedParseError('XML 结构无法识别');

  if (isNode(document.feed)) return parseAtom(document, feedUrl, baseUrl ?? feedUrl);
  return parseRss(document, feedUrl, baseUrl ?? feedUrl);
}
