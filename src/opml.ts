/** OPML 2.0 import/export. */

import { XMLParser } from 'fast-xml-parser';
import { escapeHtml } from './util';
import type { SubscriptionRow } from './store';

export interface OpmlFeed {
  url: string;
  title: string | null;
  folder: string | null;
}

function outline(url: string, title: string | null): string {
  return `<outline text="${escapeHtml(title ?? url)}" title="${escapeHtml(title ?? url)}" type="rss" xmlUrl="${escapeHtml(url)}" />`;
}

export function exportOpml(siteName: string, subscriptions: SubscriptionRow[]): string {
  const groups = new Map<string, SubscriptionRow[]>();
  for (const sub of subscriptions) {
    const key = sub.folder ?? '';
    const list = groups.get(key) ?? [];
    list.push(sub);
    groups.set(key, list);
  }

  const outlines: string[] = [];
  for (const [folder, subs] of groups) {
    const children = subs
      .map((sub) => outline(sub.url, sub.title || sub.feed_title))
      .join('\n      ');
    if (!folder) {
      outlines.push(...subs.map((sub) => outline(sub.url, sub.title || sub.feed_title)));
    } else {
      outlines.push(
        `<outline text="${escapeHtml(folder)}" title="${escapeHtml(folder)}">\n      ${children}\n    </outline>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeHtml(siteName)} subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
    ${outlines.join('\n    ')}
  </body>
</opml>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: Record<string, unknown>, name: string): string | null {
  const value = node[`@_${name}`] ?? node[`@_${name.toLowerCase()}`];
  return value == null ? null : String(value);
}

function walk(node: unknown, folder: string | null, output: OpmlFeed[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  for (const raw of asArray(record.outline)) {
    if (!raw || typeof raw !== 'object') continue;
    const outlineNode = raw as Record<string, unknown>;
    const title = attr(outlineNode, 'title') ?? attr(outlineNode, 'text');
    const xmlUrl = attr(outlineNode, 'xmlUrl') ?? attr(outlineNode, 'xmlurl');
    if (xmlUrl) {
      output.push({ url: xmlUrl, title: title ?? null, folder });
    }
    if (outlineNode.outline) {
      const nextFolder = xmlUrl ? folder : title ?? folder;
      walk(outlineNode, nextFolder, output);
    }
  }
}

export function parseOpml(text: string): OpmlFeed[] {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('OPML 解析失败');
  }
  const opml = (document.opml as Record<string, unknown> | undefined) ?? document;
  const body = (opml.body as Record<string, unknown> | undefined) ?? opml;
  const feeds: OpmlFeed[] = [];
  walk(body, null, feeds);
  const seen = new Set<string>();
  return feeds.filter((feed) => {
    if (!feed.url || seen.has(feed.url)) return false;
    seen.add(feed.url);
    return true;
  });
}
