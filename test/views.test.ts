import { describe, expect, test } from 'bun:test';
import { readConfig } from '../src/config';
import type { EntryRow, SubscriptionRow } from '../src/store';
import { ARTICLE_CSS, CSS } from '../src/styles';
import { itemPage, listPage, loginPage } from '../src/views';

const cfg = readConfig({ SITE_NAME: 'My Reader' });
const sub: SubscriptionRow = {
  feed_id: 1, title: null, folder: '设计 & 阅读', url: 'https://example.com/feed',
  site_url: 'https://example.com', feed_title: 'Example Feed', icon_url: null,
  last_fetch_ms: null, error_count: 0, last_error: null, unread: 1,
};
const entry: EntryRow = {
  id: 1, item_id: '0123456789abcdef', feed_id: 1, url: 'https://example.com/post',
  title: 'A thoughtful article', author: null, summary: '<p>A short summary</p>', content: '<p>正文</p>',
  enclosure_url: null, enclosure_type: null, published_ms: Date.UTC(2026, 9, 31),
  fetched_ms: Date.UTC(2026, 9, 31), feed_url: sub.url, feed_title: 'Example Feed',
  feed_site_url: sub.site_url, feed_icon_url: null, folder: sub.folder, read: false, starred: false,
};
const base: Parameters<typeof listPage>[0] = {
  cfg, user: { username: 'admin' }, subscriptions: [sub], totalUnread: 1, starred: 0,
  stream: { kind: 'all' }, heading: '全部文章', subheading: '1 个订阅',
  entries: [entry], hasMore: false, cursor: null, search: '',
};

describe('reader visual and accessibility contracts', () => {
  test('reading controls remain accessible and retain their API targets', () => {
    const html = listPage(base);
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="搜索文章"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-read-status class="sr-only">未读');
    expect(html).toContain('action="/mark-all-read"');
    expect(html).toContain('href="/item/0123456789abcdef"');
    expect(html).toContain('datetime="2026-10-31T00:00:00.000Z"');
    expect(html).toContain('<details class="feed-panel" open>');
  });

  test('only the relevant feed or folder is selected, not all articles', () => {
    const feed = listPage({ ...base, stream: { kind: 'feed', ref: '1' } });
    expect(feed).toContain('class="feed-item active"');
    expect(feed).not.toContain('class="nav-item active"');
    const folder = listPage({ ...base, stream: { kind: 'label', label: sub.folder! } });
    expect(folder).toContain('class="folder-label active"');
    expect(folder).not.toContain('class="nav-item active"');
  });

  test('empty states give contextual next actions', () => {
    expect(listPage({ ...base, entries: [], subscriptions: [] })).toContain('添加第一个订阅');
    expect(listPage({ ...base, entries: [], stream: { kind: 'unread' } })).toContain('未读已清空');
    expect(listPage({ ...base, entries: [], stream: { kind: 'starred' } })).toContain('把值得重读的文章留在这里');
    expect(listPage({ ...base, entries: [], search: 'missing' })).toContain('没有找到相关文章');
  });

  test('page titles, feed names and excerpts remain escaped', () => {
    const attack = '<img src=x onerror=alert(1)>';
    const html = listPage({ ...base, heading: attack, entries: [{ ...entry, title: attack, feed_title: attack }] });
    expect(html).not.toContain(attack);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('设计 &amp; 阅读');
  });

  test('login keeps password semantics and does not depend on JavaScript', () => {
    const html = loginPage(cfg, { next: '/?stream=unread', error: '密码错误' });
    expect(html).toContain('method="post" action="/login"');
    expect(html).toContain('type="text" name="username" autocomplete="username"');
    expect(html).toContain('type="password" name="password" autocomplete="current-password"');
    expect(html).toContain('role="alert">密码错误');
    expect(html).toContain('name="next" value="/?stream=unread"');
  });

  test('article typography never relaxes the content sandbox', () => {
    const html = itemPage({ ...base, entry });
    expect(html).toContain('sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain('allow-scripts');
    expect(html).toContain('srcdoc="');
    expect(ARTICLE_CSS).toContain('prefers-color-scheme:dark');
  });

  test('generated client script is valid and respects native keyboard controls', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(listPage(base))![1];
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('button, a, summary, [contenteditable]');
    expect(script).toContain('收藏未保存');
    expect(script).toContain("setAttribute('aria-pressed'");
  });

  test('styles support dark mode, visible focus, reduced motion and narrow screens', () => {
    expect(CSS).toContain('prefers-color-scheme:dark');
    expect(CSS).toContain('prefers-reduced-motion:reduce');
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toContain('@media(max-width:760px)');
    expect(CSS).not.toContain('@import');
    expect(listPage(base)).not.toContain('fonts.googleapis.com');
  });

  test('invalid timestamps do not crash the redesigned list', () => {
    expect(() => listPage({ ...base, entries: [{ ...entry, published_ms: NaN }] })).not.toThrow();
  });
});
