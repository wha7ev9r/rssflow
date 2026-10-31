import { describe, expect, test } from 'bun:test';
import { discoverFeedsFromHtml, fetchFeedDocument } from '../src/feed/fetch';
import { parseFeedDocument } from '../src/feed/parse';

const feedUrl = 'https://example.com/feed';

function atom(content: string): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title>
    <entry><id>entry-1</id><title>Example</title>${content}</entry></feed>`;
}

describe('feed regressions', () => {
  test('RSS description-only items have distinct stable fallback identifiers', () => {
    const common = 'same prefix '.repeat(250);
    const xml = `<rss version="2.0"><channel><title>Example</title><link>https://example.com/</link>
      <description>Feed</description><item><description>${common}first</description></item>
      <item><description>${common}second</description></item></channel></rss>`;
    const parsed = parseFeedDocument(xml, feedUrl);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.guid).not.toBe(parsed.items[1]?.guid);
    expect(parsed.items.map((item) => item.guid)).toEqual(
      parseFeedDocument(xml, feedUrl).items.map((item) => item.guid),
    );
    expect(parsed.items.every((item) => item.guid.length < 200)).toBe(true);
  });

  test('Atom omitted or explicit text type escapes text that resembles HTML', () => {
    for (const attribute of ['', ' type="text"']) {
      const parsed = parseFeedDocument(atom(
        `<content${attribute}>&lt;b&gt;literal&lt;/b&gt;</content>`,
      ), feedUrl);
      expect(parsed.items[0]?.content).toBe('<p>&lt;b&gt;literal&lt;/b&gt;</p>');
    }
    const html = parseFeedDocument(atom('<content type="html">&lt;b&gt;bold&lt;/b&gt;</content>'), feedUrl);
    expect(html.items[0]?.content).toBe('<b>bold</b>');
  });

  test('JSON Feed summary is always plain text, not inferred HTML', () => {
    const parsed = parseFeedDocument(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'Example',
      items: [{ id: '1', content_text: 'body', summary: '<b>literal</b>' }],
    }), feedUrl);
    expect(parsed.items[0]?.summary).toBe('<p>&lt;b&gt;literal&lt;/b&gt;</p>');
  });
  test('Atom XHTML preserves mixed text and interleaved element order', () => {
    const html = '<p>Before <b>bold</b> between <a href="/x">link</a> after.</p><div>Middle</div><p>Last</p>';
    const parsed = parseFeedDocument(atom(
      `<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${html}</div></content>`,
    ), feedUrl);
    expect(parsed.items[0]?.content).toBe(html);
  });

  test('Atom XHTML preserves escaped markup as text and handles namespace prefixes', () => {
    const parsed = parseFeedDocument(atom(
      '<summary type="xhtml"><h:div xmlns:h="http://www.w3.org/1999/xhtml"><h:p>Before <h:b>bold</h:b> &amp; &lt;script&gt; after</h:p></h:div></summary>',
    ), feedUrl);
    expect(parsed.items[0]?.summary).toBe('<p>Before <b>bold</b> &amp; &lt;script&gt; after</p>');
  });

  test('RSS fallback identifiers retain existing title/date identities', () => {
    const xml = '<rss><channel><title>Example</title><item><title>Old</title><description>Body</description></item>' +
      '<item><pubDate>2026-10-01</pubDate><description>Same</description></item>' +
      '<item><pubDate>2026-10-02</pubDate><description>Same</description></item></channel></rss>';
    expect(parseFeedDocument(xml, feedUrl).items.map((item) => item.guid).sort())
      .toEqual(['Old|', '|2026-10-01', '|2026-10-02']);
  });

  test('Atom XHTML keeps preformatted whitespace and emits HTML void elements once', () => {
    const parsed = parseFeedDocument(atom(
      '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><pre>  first\n  second  </pre><p>Before<br/>After<img src="/image.png"/></p></div></content>',
    ), feedUrl);
    expect(parsed.items[0]?.content).toBe('<pre>  first\n  second  </pre><p>Before<br>After<img src="/image.png"></p>');
  });

  test('JSON Feed metadata and attachments reject executable and local URLs', () => {
    const parsed = parseFeedDocument(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'Example',
      home_page_url: 'javascript:alert(1)', icon: 'file:///private/icon',
      items: [{ id: '1', url: 'javascript:alert(1)', content_text: 'safe',
        attachments: [{ url: 'data:text/html,bad', mime_type: 'text/html' }] }],
    }), feedUrl);
    expect(parsed.siteUrl).toBeNull();
    expect(parsed.iconUrl).toBeNull();
    expect(parsed.items[0]?.url).toBeNull();
    expect(parsed.items[0]?.enclosureUrl).toBeNull();
  });

  test('Atom URLs are restricted to HTTP(S), while relative links still resolve', () => {
    const parsed = parseFeedDocument(atom(
      '<link href="javascript:alert(1)"/><link rel="enclosure" href="file:///private/file"/>',
    ), feedUrl);
    expect(parsed.items[0]?.url).toBeNull();
    expect(parsed.items[0]?.enclosureUrl).toBeNull();
    expect(parseFeedDocument(atom('<link href="/article"/>'), feedUrl).items[0]?.url)
      .toBe('https://example.com/article');
  });

  test('autodiscovery discards non-HTTP URLs before choosing a feed', () => {
    const found = discoverFeedsFromHtml(
      '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">' +
      '<link rel="alternate" type="application/rss+xml" href="file:///private/feed">' +
      '<link rel="alternate" type="application/rss+xml" href="/rss">', feedUrl,
    );
    expect(found.map((feed) => feed.url)).toEqual(['https://example.com/rss']);
  });

  test('fetch refuses non-HTTP URLs without calling the network implementation', async () => {
    let calls = 0;
    const result = await fetchFeedDocument('file:///private/feed', {
      userAgent: 'test',
      fetchImpl: Object.assign(
        async () => { calls += 1; return new Response('body'); },
        { preconnect: fetch.preconnect },
      ),
    });
    expect(result.status).toBe('error');
    expect(calls).toBe(0);
  });

  test('conditional fetch forwards both validators and returns 304 without parsing a body', async () => {
    let headers: Headers | undefined;
    const result = await fetchFeedDocument(feedUrl, {
      userAgent: 'test', etag: '"version-1"', lastModified: 'Thu, 01 Oct 2026 00:00:00 GMT',
      fetchImpl: (async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      }) as typeof fetch,
    });
    expect(result.status).toBe('not-modified');
    expect(headers?.get('if-none-match')).toBe('"version-1"');
    expect(headers?.get('if-modified-since')).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
  });
});
