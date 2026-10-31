import { describe, expect, test } from 'bun:test';
import { parseFeedDocument } from '../src/feed/parse';
import { discoverFeedsFromHtml } from '../src/feed/fetch';
import { exportOpml, parseOpml } from '../src/opml';
import type { SubscriptionRow } from '../src/store';

describe('feed parsing', () => {
  test('RSS 2.0 with content:encoded, author, category and enclosure', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Example Feed</title>
  <link>https://example.com/</link>
  <description>A test feed</description>
  <item>
    <title>First &amp; Post</title>
    <link>https://example.com/posts/1</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Summary text</p>]]></description>
    <content:encoded><![CDATA[<p>Full <b>body</b></p>]]></content:encoded>
    <dc:creator>Alice</dc:creator>
    <category>Tech</category>
    <enclosure url="https://example.com/a.mp3" type="audio/mpeg" />
  </item>
</channel>
</rss>`;

    const feed = parseFeedDocument(xml, 'https://example.com/feed.xml');
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example Feed');
    expect(feed.siteUrl).toBe('https://example.com/');
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0]!;
    expect(item.title).toBe('First & Post');
    expect(item.guid).toBe('post-1');
    expect(item.author).toBe('Alice');
    expect(item.content).toContain('<b>body</b>');
    expect(item.summary).toContain('Summary text');
    expect(item.enclosureUrl).toBe('https://example.com/a.mp3');
    expect(item.categories).toEqual(['Tech']);
    expect(item.publishedMs).toBe(Date.parse('Tue, 06 Oct 2026 10:00:00 GMT'));
  });

  test('Atom xhtml content keeps links and resolves relative URLs', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <subtitle>sub</subtitle>
  <link rel="alternate" href="https://atom.example/"/>
  <entry>
    <id>tag:atom.example,2026:1</id>
    <title>Atom Post</title>
    <link rel="alternate" href="/posts/1"/>
    <link rel="enclosure" href="https://atom.example/a.mp3" type="audio/mpeg"/>
    <published>2026-10-01T12:00:00Z</published>
    <author><name>Bob</name></author>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <a href="/x">world</a></p></div></content>
  </entry>
</feed>`;

    const feed = parseFeedDocument(xml, 'https://atom.example/feed.xml');
    expect(feed.format).toBe('atom');
    expect(feed.title).toBe('Atom Feed');
    const item = feed.items[0]!;
    expect(item.url).toBe('https://atom.example/posts/1');
    expect(item.author).toBe('Bob');
    expect(item.enclosureUrl).toBe('https://atom.example/a.mp3');
    expect(item.content).toContain('<a href="/x">');
    expect(item.content).toContain('world</a>');
  });

  test('RDF / RSS 1.0 items at the root', () => {
    const xml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/">
    <title>RDF Feed</title>
    <link>https://rdf.example/</link>
    <description>rdf</description>
  </channel>
  <item rdf:about="https://rdf.example/1">
    <title>Old Post</title>
    <link>https://rdf.example/1</link>
    <dc:date>2020-01-01T00:00:00Z</dc:date>
    <description>RDF body</description>
  </item>
</rdf:RDF>`;

    const feed = parseFeedDocument(xml, 'https://rdf.example/feed.rdf');
    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('RDF Feed');
    expect(feed.items[0]?.title).toBe('Old Post');
    expect(feed.items[0]?.publishedMs).toBe(Date.parse('2020-01-01T00:00:00Z'));
  });

  test('JSON Feed', () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'JSON Feed',
      home_page_url: 'https://json.example/',
      items: [
        {
          id: '1',
          url: 'https://json.example/1',
          title: 'JSON Post',
          content_html: '<p>Hello</p>',
          date_published: '2026-09-01T00:00:00Z',
          authors: [{ name: 'Carol' }],
          attachments: [{ url: 'https://json.example/a.mp3', mime_type: 'audio/mpeg' }],
          tags: ['news'],
        },
      ],
    });
    const feed = parseFeedDocument(json, 'https://json.example/feed.json');
    expect(feed.format).toBe('json');
    const item = feed.items[0]!;
    expect(item.title).toBe('JSON Post');
    expect(item.author).toBe('Carol');
    expect(item.content).toBe('<p>Hello</p>');
    expect(item.enclosureUrl).toBe('https://json.example/a.mp3');
    expect(item.categories).toEqual(['news']);
  });

  test('rejects HTML pages with a helpful error', () => {
    expect(() =>
      parseFeedDocument('<!doctype html><html><head><title>Site</title></head></html>', 'https://site.example/'),
    ).toThrow(/HTML/);
  });

  test('discovers alternate feed links in HTML', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom.xml">
      <link rel="stylesheet" href="/style.css">
    </head></html>`;
    const found = discoverFeedsFromHtml(html, 'https://site.example/page');
    expect(found.map((entry) => entry.url)).toEqual([
      'https://site.example/feed.xml',
      'https://cdn.example/atom.xml',
    ]);
  });
});

describe('OPML', () => {
  test('exports folders and subscriptions', () => {
    const subscriptions: SubscriptionRow[] = [
      {
        feed_id: 1,
        title: null,
        folder: 'Tech',
        url: 'https://example.com/rss?a=1&b=2',
        site_url: 'https://example.com/',
        feed_title: 'Example',
        icon_url: null,
        last_fetch_ms: null,
        error_count: 0,
        last_error: null,
        unread: 2,
      },
    ];
    const xml = exportOpml('Test Reader', subscriptions);
    expect(xml).toContain('<outline text="Tech"');
    expect(xml).toContain('xmlUrl="https://example.com/rss?a=1&amp;b=2"');
  });

  test('imports nested outlines into folders', () => {
    const xml = `<?xml version="1.0"?>
<opml version="2.0"><body>
  <outline text="News">
    <outline text="Example" type="rss" xmlUrl="https://example.com/rss" />
  </outline>
  <outline text="Solo" type="rss" xmlUrl="https://solo.example/feed" />
</body></opml>`;
    const feeds = parseOpml(xml);
    expect(feeds).toHaveLength(2);
    expect(feeds[0]).toMatchObject({ url: 'https://example.com/rss', folder: 'News' });
    expect(feeds[1]).toMatchObject({ url: 'https://solo.example/feed', folder: null });
  });
});
