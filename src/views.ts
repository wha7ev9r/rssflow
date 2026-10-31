/** Server-rendered HTML. No build step, no external assets. */

import type { AppConfig } from './config';
import type { EntryRow, SubscriptionRow } from './store';
import type { Stream } from './stream';
import { escapeHtml as esc, formatDateTime, preview, timeAgo } from './util';

import { ARTICLE_CSS, CSS } from './styles';

const ICONS = {
  rss: '<circle cx="6" cy="18" r="1.5" fill="currentColor" stroke="none"/><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/>',
  inbox: '<path d="M4 5h16v14H4zM4 12h5l2 3h2l2-3h5"/>',
  unread: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.5l-5.7 3 1.1-6.3L2.8 9.7l6.4-.9z"/>',
  feeds: '<path d="M12 4v16M4 12h16"/><rect x="3" y="3" width="18" height="18" rx="5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3" fill="var(--panel)"/><circle cx="16" cy="17" r="3" fill="var(--panel)"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
} as const;

function icon(name: keyof typeof ICONS): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const CLIENT_JS = `
(function(){
  var feedPanel = document.querySelector('.feed-panel');
  if(feedPanel){
    var mobile = window.matchMedia('(max-width:760px)');
    function updatePanel(){feedPanel.open = !mobile.matches;}
    updatePanel();
    mobile.addEventListener('change',updatePanel);
  }
  var rows = Array.prototype.slice.call(document.querySelectorAll('.article'));
  var cursor = -1;
  function announce(message){
    var status = document.getElementById('action-status');
    if(status){status.textContent = message;}
  }
  function post(body){
    return fetch('/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true})
      .then(function(response){if(!response.ok || response.redirected){throw new Error('state update failed');}return response.json();})
      .then(function(result){if(!result.ok){throw new Error('state update failed');}return result;});
  }
  function readState(row,read){
    if(!row){return;}
    row.classList.toggle('is-read',read);
    var label = row.querySelector('[data-read-status]');
    if(label){label.textContent = read ? '已读' : '未读';}
  }
  function markRead(id,row){
    var wasRead = !!(row && row.classList.contains('is-read'));
    readState(row,true);
    post({ids:[id],read:true}).catch(function(){
      readState(row,wasRead);
      announce('已读状态未保存，请检查网络后重试。');
    });
  }
  function starState(btn,row,starred){
    row.classList.toggle('is-starred',starred);
    btn.textContent = starred ? '★' : '☆';
    btn.setAttribute('title',starred ? '取消收藏' : '收藏');
    btn.setAttribute('aria-label',starred ? '取消收藏' : '收藏');
    btn.setAttribute('aria-pressed',String(starred));
  }
  function toggleStar(btn){
    if(btn.disabled){return;}
    var row = btn.closest('.article');
    var starred = !row.classList.contains('is-starred');
    btn.disabled = true;
    announce('');
    starState(btn,row,starred);
    post({ids:[btn.getAttribute('data-star')],starred:starred})
      .catch(function(){starState(btn,row,!starred);announce('收藏未保存，请检查网络后重试。');})
      .finally(function(){btn.disabled = false;});
  }
  document.addEventListener('click',function(e){
    var target = e.target;
    if(!target || !target.closest){return;}
    var link = target.closest('a[data-mark-read]');
    if(link){markRead(link.getAttribute('data-mark-read'),link.closest('.article'));}
    var star = target.closest('button[data-star]');
    if(star){e.preventDefault();toggleStar(star);}
  });
  function move(delta){
    if(!rows.length){return;}
    cursor = Math.max(0,Math.min(rows.length-1,cursor+delta));
    rows.forEach(function(row,index){row.classList.toggle('cursor',index===cursor);});
    rows[cursor].scrollIntoView({block:'nearest'});
  }
  document.addEventListener('keydown',function(e){
    if(e.metaKey || e.ctrlKey || e.altKey){return;}
    if(e.target && e.target.closest && e.target.closest('input, textarea, select, button, a, summary, [contenteditable]')){return;}
    if(!rows.length){return;}
    if(e.key==='j'){e.preventDefault();move(1);}
    else if(e.key==='k'){e.preventDefault();move(-1);}
    else if(e.key==='o' || e.key==='Enter'){
      if(cursor<0){return;}
      var link = rows[cursor].querySelector('a[data-mark-read]');
      if(link){markRead(link.getAttribute('data-mark-read'),rows[cursor]);window.location.href=link.href;}
    }else if(e.key==='s'){
      if(cursor<0){return;}
      var star = rows[cursor].querySelector('button[data-star]');
      if(star){toggleStar(star);}
    }else if(e.key==='m'){
      if(cursor<0){return;}
      var link = rows[cursor].querySelector('a[data-mark-read]');
      if(link){markRead(link.getAttribute('data-mark-read'),rows[cursor]);}
    }
  });
  var frames = Array.prototype.slice.call(document.querySelectorAll('iframe.article-frame'));
  frames.forEach(function(frame){
    function resize(){
      try{
        var doc = frame.contentDocument;
        if(doc && doc.body){
          frame.style.height = Math.max(320,Math.ceil(doc.body.getBoundingClientRect().height)+1)+'px';
        }
      }catch(err){}
    }
    function ready(){
      resize();
      try{frame.contentDocument.addEventListener('load',resize,true);}catch(err){}
    }
    frame.addEventListener('load',ready);
    window.addEventListener('resize',resize);
    ready();
  });
})();
`;

interface LayoutOptions {
  cfg: AppConfig;
  title: string;
  body: string;
  user?: { username: string } | null;
  subscriptions?: SubscriptionRow[];
  totalUnread?: number;
  starred?: number;
  activeNav?: 'all' | 'unread' | 'starred' | 'feeds' | 'settings' | null;
  activeFeedId?: number | null;
  activeFolder?: string | null;
  search?: string;
}

function badge(count: number | undefined): string {
  if (!count) return '';
  return `<span class="badge">${count > 999 ? '999+' : count}</span>`;
}

function navLink(
  href: string,
  label: string,
  count: number | undefined,
  active: boolean,
  symbol: keyof typeof ICONS,
): string {
  return `<a class="nav-item${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${badge(count)}</a>`;
}

function sidebar(options: LayoutOptions): string {
  const subscriptions = options.subscriptions ?? [];
  const groups = new Map<string, SubscriptionRow[]>();
  for (const sub of subscriptions) {
    const key = sub.folder ?? '';
    const list = groups.get(key) ?? [];
    list.push(sub);
    groups.set(key, list);
  }

  let feedsHtml = '';
  for (const [folder, subs] of groups) {
    if (folder) {
      const unread = subs.reduce((sum, sub) => sum + sub.unread, 0);
      feedsHtml += `<a class="folder-label${options.activeFolder === folder ? ' active' : ''}" href="/?folder=${encodeURIComponent(folder)}"${options.activeFolder === folder ? ' aria-current="page"' : ''}>${esc(folder)}${unread ? `<span class="badge">${unread}</span>` : ''}</a>`;
    }
    for (const sub of subs) {
      const title = sub.title || sub.feed_title || sub.url;
      const active = options.activeFeedId === sub.feed_id;
      feedsHtml += `<a class="feed-item${active ? ' active' : ''}" href="/?feed=${sub.feed_id}" title="${esc(title)}"${active ? ' aria-current="page"' : ''}>
        <span class="avatar">${esc((title || '?').slice(0, 1).toUpperCase())}</span>
        <span class="feed-name">${esc(title)}</span>
        ${badge(sub.unread)}
      </a>`;
    }
  }

  return `<aside class="sidebar" aria-label="阅读导航">
    <nav class="nav" aria-label="文章分类">
      ${navLink('/', '全部文章', options.totalUnread, options.activeNav === 'all', 'inbox')}
      ${navLink('/?stream=unread', '未读', options.totalUnread, options.activeNav === 'unread', 'unread')}
      ${navLink('/?stream=starred', '收藏', options.starred, options.activeNav === 'starred', 'star')}
      ${navLink('/feeds', '订阅管理', subscriptions.length, options.activeNav === 'feeds', 'feeds')}
      ${navLink('/settings', '设置', undefined, options.activeNav === 'settings', 'settings')}
    </nav>
    <details class="feed-panel" open>
      <summary class="side-head"><span>订阅源</span><span class="source-count">${subscriptions.length}</span>${icon('chevron')}</summary>
      <div class="feed-collection">
        ${feedsHtml || '<div class="folder-label">添加订阅后，就能在这里找到它们。</div>'}
        <div class="side-foot">
          <span>${esc(options.user?.username ?? '')}</span>
          <form method="post" action="/logout"><button class="link" type="submit">退出登录</button></form>
        </div>
      </div>
    </details>
    <div class="keyboard-hint" aria-label="键盘快捷键"><kbd>j</kbd><kbd>k</kbd><span>选择</span><kbd>o</kbd><span>打开</span><kbd>s</kbd><span>收藏</span></div>
  </aside>`;
}

function documentPage(options: LayoutOptions): string {
  const withSidebar = !!options.user;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(options.title)} · ${esc(options.cfg.siteName)}</title>
<style>${CSS}</style>
</head>
<body class="${withSidebar ? 'with-sidebar' : 'without-sidebar'}">
<a class="skip-link" href="#main-content">跳到正文</a>
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark">${icon('rss')}</span><span class="brand-name">${esc(options.cfg.siteName)}</span></a>
  ${withSidebar ? `<form class="search" method="get" action="/" role="search">${icon('search')}<input type="search" name="q" value="${esc(options.search ?? '')}" placeholder="搜索你的订阅文章" aria-label="搜索文章"></form>` : ''}
  ${withSidebar ? `<nav class="topnav" aria-label="管理导航"><a href="/feeds"${options.activeNav === 'feeds' ? ' aria-current="page"' : ''}>${icon('feeds')}订阅</a><a href="/settings"${options.activeNav === 'settings' ? ' aria-current="page"' : ''}>${icon('settings')}设置</a></nav>` : ''}
</header>
${withSidebar ? `<div class="shell">${sidebar(options)}<main id="main-content" tabindex="-1"><p id="action-status" class="notice action-status" role="status" aria-live="polite"></p>${options.body}</main></div>` : `<div id="main-content" tabindex="-1">${options.body}</div>`}
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

export function loginPage(
  cfg: AppConfig,
  state: { error?: string | null; next?: string | null },
): string {
  return documentPage({
    cfg,
    title: '登录',
    user: null,
    body: `<div class="auth-wrap">
  <form class="auth-card" method="post" action="/login">
    <div class="auth-symbol">${icon('rss')}</div>
    <h1>继续阅读</h1>
    <p class="muted">登录后查看你的订阅、未读与收藏。</p>
    ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
    <label>用户名<input type="text" name="username" autocomplete="username" required autofocus></label>
    <label>密码<input type="password" name="password" autocomplete="current-password" required></label>
    <input type="hidden" name="next" value="${esc(state.next ?? '/')}">
    <button class="btn primary" type="submit">登录</button>
  </form>
</div>`,
  });
}

export function errorPage(title: string, message: string, cfg?: AppConfig): string {
  const shell: AppConfig = cfg ?? {
    siteName: 'Buffy Reader',
    adminUsername: 'admin',
    adminPassword: '',
    authSecret: '',
    cronSecret: '',
    fetchIntervalMinutes: 15,
    maxFeedsPerRun: 2,
    maxItemsPerFetch: 40,
    retentionDays: 120,
    maxEntriesPerFeed: 500,
    userAgent: '',
  };
  return documentPage({
    cfg: shell,
    title,
    user: null,
    body: `<div class="auth-wrap"><div class="auth-card"><h1>${esc(title)}</h1><p class="muted">${esc(message)}</p><p><a class="btn" href="/">返回首页</a></p></div></div>`,
  });
}

export function setupPage(problems: string[], siteName = 'Buffy Reader'): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>配置 · ${esc(siteName)}</title><style>${CSS}</style></head>
<body><div class="setup">
<h1>还需要完成配置</h1>
<p class="muted">Worker 已部署，但以下设置缺失：</p>
<ul>${problems.map((problem) => `<li class="error">${esc(problem)}</li>`).join('')}</ul>
<div class="card"><h2>设置密钥</h2>
<pre class="code">wrangler secret put ADMIN_PASSWORD
wrangler secret put AUTH_SECRET
wrangler secret put CRON_SECRET</pre>
<p class="muted">本地开发请复制 <span class="code">.dev.vars.example</span> 为 <span class="code">.dev.vars</span>。</p></div>
<div class="card"><h2>连接数据库</h2>
<pre class="code">wrangler hyperdrive create buffy-reader \\
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DB" \\
  --caching-disabled</pre>
<p class="muted">把返回的 id 填入 <span class="code">wrangler.toml</span> 的 <span class="code">[[hyperdrive]]</span>，然后重新部署；或为本地开发设置 <span class="code">DATABASE_URL</span>。</p></div>
</div></body></html>`;
}

function streamHiddenFields(stream: Stream, search: string): string {
  const fields: string[] = [];
  if (stream.kind === 'unread') fields.push('<input type="hidden" name="stream" value="unread">');
  if (stream.kind === 'starred') fields.push('<input type="hidden" name="stream" value="starred">');
  if (stream.kind === 'feed') {
    fields.push(`<input type="hidden" name="feed" value="${esc(stream.ref)}">`);
  }
  if (stream.kind === 'label') {
    fields.push(`<input type="hidden" name="folder" value="${esc(stream.label)}">`);
  }
  if (search) fields.push(`<input type="hidden" name="q" value="${esc(search)}">`);
  return fields.join('');
}

function pageHref(stream: Stream, search: string, cursor: string | null): string {
  const params = new URLSearchParams();
  if (stream.kind === 'unread') params.set('stream', 'unread');
  if (stream.kind === 'starred') params.set('stream', 'starred');
  if (stream.kind === 'feed') params.set('feed', stream.ref);
  if (stream.kind === 'label') params.set('folder', stream.label);
  if (search) params.set('q', search);
  if (cursor) params.set('c', cursor);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

function isoDate(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function listEmptyState(stream: Stream, search: string, hasSubscriptions: boolean): string {
  const [title, message, href, action] = search
    ? ['没有找到相关文章', '试试更短的关键词，或回到全部文章继续阅读。', '/', '查看全部文章']
    : stream.kind === 'starred'
      ? ['把值得重读的文章留在这里', '点击文章旁的星标，就能随时回来再读。', '/', '去看看文章']
      : stream.kind === 'unread' && hasSubscriptions
        ? ['未读已清空', '新文章会在下一次抓取后出现在这里。也可以重读之前的内容。', '/', '查看全部文章']
        : hasSubscriptions
          ? ['这里还没有文章', '订阅已准备好，抓取完成后文章就会出现在这里。', '/feeds', '查看订阅状态']
          : ['从你喜欢的订阅开始', '添加一个博客、新闻网站或导入 OPML，把想读的内容放到一起。', '/feeds', '添加第一个订阅'];
  return `<div class="empty">${icon(stream.kind === 'starred' ? 'star' : 'inbox')}<h2>${title}</h2><p>${message}</p><a class="btn" href="${href}">${action}</a></div>`;
}

export function listPage(args: {
  cfg: AppConfig;
  user: { username: string };
  subscriptions: SubscriptionRow[];
  totalUnread: number;
  starred: number;
  stream: Stream;
  heading: string;
  subheading: string;
  entries: EntryRow[];
  hasMore: boolean;
  cursor: string | null;
  search: string;
}): string {
  const { stream } = args;
  const activeNav = stream.kind === 'unread' ? 'unread'
    : stream.kind === 'starred' ? 'starred' : stream.kind === 'all' ? 'all' : null;
  const activeFeedId = stream.kind === 'feed' ? Number(stream.ref) || null : null;
  const activeFolder = stream.kind === 'label' ? stream.label : null;

  const items = args.entries
    .map(
      (entry) => `<li class="article${entry.read ? ' is-read' : ''}${entry.starred ? ' is-starred' : ''}" data-id="${esc(entry.item_id)}">
  <div class="article-main">
    <div class="article-meta">
      <span data-read-status class="sr-only">${entry.read ? '已读' : '未读'}</span>
      <span class="article-source">${esc(entry.feed_title)}</span>
      <time datetime="${isoDate(entry.published_ms)}">${timeAgo(entry.published_ms)}</time>
      ${entry.folder ? `<span>${esc(entry.folder)}</span>` : ''}
      ${entry.enclosure_url ? '<span>附件</span>' : ''}
    </div>
    <a class="article-title" href="/item/${encodeURIComponent(entry.item_id)}" data-mark-read="${esc(entry.item_id)}">${esc(entry.title || '(无标题)')}</a>
    <p class="excerpt">${esc(preview(entry.summary || entry.content || '', 200))}</p>
  </div>
  <button class="star-btn" type="button" data-star="${esc(entry.item_id)}" title="${entry.starred ? '取消收藏' : '收藏'}" aria-label="${entry.starred ? '取消收藏' : '收藏'}" aria-pressed="${entry.starred}">${entry.starred ? '★' : '☆'}</button>
</li>`,
    )
    .join('\n');

  const body = `<div class="page-head">
  <h1>${esc(args.heading)}</h1>
  <form method="post" action="/mark-all-read" onsubmit="return confirm('把当前列表中的文章全部标为已读？')">
    ${streamHiddenFields(stream, args.search)}
    <button class="btn small" type="submit">${icon('check')}全部标为已读</button>
  </form>
</div>
<p class="subhead">${esc(args.subheading)}</p>
${args.entries.length > 0 ? `<ul class="articles">${items}</ul>` : listEmptyState(stream, args.search, args.subscriptions.length > 0)}
${args.hasMore ? `<div class="pager"><a class="btn" href="${pageHref(stream, args.search, args.cursor)}">下一页</a></div>` : ''}`;

  return documentPage({
    cfg: args.cfg,
    title: args.heading,
    body,
    user: args.user,
    subscriptions: args.subscriptions,
    totalUnread: args.totalUnread,
    starred: args.starred,
    activeNav,
    activeFeedId,
    activeFolder,
    search: args.search,
  });
}

function articleDocument(entry: EntryRow): string {
  const base =
    entry.url && /^https?:\/\//i.test(entry.url)
      ? `<base href="${esc(entry.url)}" target="_blank">`
      : '';
  const content = entry.content || entry.summary || '<p>（没有正文，请打开原文）</p>';
  const style = ARTICLE_CSS;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${base}<style>${style}</style></head><body>${content}</body></html>`;
}

export function itemPage(args: {
  cfg: AppConfig;
  user: { username: string };
  subscriptions: SubscriptionRow[];
  totalUnread: number;
  starred: number;
  entry: EntryRow;
}): string {
  const { entry } = args;
  const safeLink =
    entry.url && /^https?:\/\//i.test(entry.url)
      ? `<a class="btn primary" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>`
      : '';
  const body = `<a class="back" href="/">← 返回列表</a>
<article class="reader">
  <h1>${esc(entry.title || '(无标题)')}</h1>
  <div class="article-meta">
    <a href="/?feed=${entry.feed_id}">${esc(entry.feed_title)}</a>
    <span>· ${formatDateTime(entry.published_ms)}</span>
    ${entry.author ? `<span>· ${esc(entry.author)}</span>` : ''}
    ${entry.folder ? `<span>· ${esc(entry.folder)}</span>` : ''}
  </div>
  <div class="actions">
    <form method="post" action="/item/${encodeURIComponent(entry.item_id)}/state">
      <input type="hidden" name="read" value="${entry.read ? 'false' : 'true'}">
      <button class="btn" type="submit">${entry.read ? '标为未读' : '标为已读'}</button>
    </form>
    <form method="post" action="/item/${encodeURIComponent(entry.item_id)}/state">
      <input type="hidden" name="starred" value="${entry.starred ? 'false' : 'true'}">
      <button class="btn" type="submit">${entry.starred ? '★ 取消收藏' : '☆ 收藏'}</button>
    </form>
    ${safeLink}
  </div>
  <iframe class="article-frame" title="文章内容" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(articleDocument(entry))}"></iframe>
</article>`;
  return documentPage({
    cfg: args.cfg,
    title: entry.title || '文章',
    body,
    user: args.user,
    subscriptions: args.subscriptions,
    totalUnread: args.totalUnread,
    starred: args.starred,
    activeNav: null,
    activeFeedId: entry.feed_id,
  });
}

export function feedsPage(args: {
  cfg: AppConfig;
  user: { username: string };
  subscriptions: SubscriptionRow[];
  totalUnread: number;
  starred: number;
  folders: string[];
  flash: string | null;
}): string {
  const rows = args.subscriptions
    .map((sub) => {
      const title = sub.title || sub.feed_title || sub.url;
      return `<div class="feed-row">
  <div class="feed-row-head">
    <div>
      <div class="feed-row-title">${esc(title)}</div>
      <div class="feed-row-url"><a href="${esc(sub.url)}" target="_blank" rel="noopener noreferrer">${esc(sub.url)}</a></div>
    </div>
    <div class="feed-row-actions">
      <form method="post" action="/feeds/${sub.feed_id}/refresh"><button class="btn small" type="submit">立即抓取</button></form>
      <form method="post" action="/feeds/${sub.feed_id}/delete" onsubmit="return confirm('删除这个订阅及其文章？')"><button class="btn small danger" type="submit">删除</button></form>
    </div>
  </div>
  <form class="feed-edit" method="post" action="/feeds/${sub.feed_id}/update">
    <input type="text" name="title" value="${esc(sub.title ?? '')}" placeholder="${esc(sub.feed_title ?? '自定义标题')}" aria-label="自定义标题">
    <input type="text" name="folder" value="${esc(sub.folder ?? '')}" placeholder="文件夹" list="folder-list" aria-label="文件夹">
    <button class="btn small" type="submit">保存</button>
  </form>
  <div class="feed-row-meta">
    <span>${sub.unread} 篇未读</span>
    ${sub.last_fetch_ms ? `<span>上次抓取：${timeAgo(sub.last_fetch_ms)}</span>` : '<span>尚未抓取</span>'}
    ${sub.error_count > 0 ? `<span class="error">连续失败 ${sub.error_count} 次：${esc(sub.last_error ?? '')}</span>` : ''}
  </div>
</div>`;
    })
    .join('\n');

  const body = `<div class="page-head"><h1>订阅管理</h1><form method="post" action="/refresh"><button class="btn small" type="submit">安排全部刷新</button></form></div>
<p class="subhead">添加订阅后会在下一次 cron 抓取时更新；「立即抓取」只是把它排到队首。</p>
${args.flash ? `<div class="notice" role="status">${esc(args.flash)}</div>` : ''}
<div class="card">
  <h2>添加订阅</h2>
  <form class="form-row" method="post" action="/feeds/add">
    <input type="url" name="url" required placeholder="https://example.com/feed 或网站首页">
    <input type="text" name="folder" placeholder="文件夹（可选）" list="folder-list">
    <button class="btn primary" type="submit">添加</button>
  </form>
  <datalist id="folder-list">${args.folders.map((folder) => `<option value="${esc(folder)}"></option>`).join('')}</datalist>
</div>
<div class="card">
  <h2>已订阅（${args.subscriptions.length}）</h2>
  ${rows || '<p class="muted">还没有订阅。</p>'}
</div>
<div class="card">
  <h2>OPML</h2>
  <p class="muted">从其他 RSS 阅读器迁移，或备份当前订阅。</p>
  <form class="form-row" method="post" action="/opml" enctype="multipart/form-data">
    <input type="file" name="opml" accept=".opml,.xml,text/xml,application/xml" required>
    <button class="btn" type="submit">导入 OPML</button>
    <a class="btn" href="/opml">导出 OPML</a>
  </form>
</div>`;
  return documentPage({
    cfg: args.cfg,
    title: '订阅管理',
    body,
    user: args.user,
    subscriptions: args.subscriptions,
    totalUnread: args.totalUnread,
    starred: args.starred,
    activeNav: 'feeds',
  });
}

export function settingsPage(args: {
  cfg: AppConfig;
  user: { username: string };
  subscriptions: SubscriptionRow[];
  totalUnread: number;
  starred: number;
  counts: { feeds: number; entries: number; read: number; starred: number };
  origin: string;
  authToken: string;
  hasHyperdrive: boolean;
  hasDatabaseUrl: boolean;
  hasCronSecret: boolean;
}): string {
  const readerUrl = `${args.origin}/api/greader.php`;
  const cronHeader = 'Authorization: Bearer <CRON_SECRET>';
  const body = `<div class="page-head"><h1>设置</h1></div>
<div class="card">
  <h2>客户端接入（Google Reader API）</h2>
  <p class="muted">在 Reeder、Fiery Feeds、FeedMe 等客户端中选择 “FreshRSS” 或 “Google Reader”。</p>
  <dl class="kv">
    <dt>服务器</dt><dd><span class="code">${esc(readerUrl)}</span></dd>
    <dt>也可以用</dt><dd><span class="code">${esc(args.origin)}</span></dd>
    <dt>用户名</dt><dd><span class="code">${esc(args.cfg.adminUsername)}</span></dd>
    <dt>密码</dt><dd>环境变量 <span class="code">ADMIN_PASSWORD</span></dd>
    <dt>Auth token</dt><dd><span class="code">${esc(args.authToken)}</span></dd>
  </dl>
  <p class="muted" style="margin-top:12px">Auth token 等同于密码，可填入需要 token 的客户端；修改 <span class="code">AUTH_SECRET</span> 会让所有会话与 token 失效。</p>
</div>
<div class="card">
  <h2>定时抓取（cron-job.org）</h2>
  <p class="muted">Cloudflare 免费版每次请求只有 10ms CPU，所以刷新是按批进行的：每次 cron 只抓少量到期订阅，返回一个很小的 JSON。</p>
  <dl class="kv">
    <dt>刷新地址</dt><dd><span class="code">${esc(args.origin)}/api/cron/refresh</span></dd>
    <dt>清理地址</dt><dd><span class="code">${esc(args.origin)}/api/cron/refresh?cleanup=1</span></dd>
    <dt>请求头</dt><dd><span class="code">${esc(cronHeader.replace('<CRON_SECRET>', args.cfg.cronSecret || '<未设置>'))}</span></dd>
  </dl>
  <p class="muted" style="margin-top:12px">在 cron-job.org 新建任务：GET、每 1–5 分钟执行一次、添加自定义 Header，超时 30 秒。建议再建一个每日任务调用 <span class="code">?cleanup=1</span>。连续失败 25 次会被 cron-job.org 自动停用，记得开启失败邮件。</p>
  <p class="muted">也可以把密钥放在查询串里：<span class="code">${esc(args.origin)}/api/cron/refresh?token=...</span>（会出现在日志里，不如 Header 安全）。</p>
</div>
<div class="card">
  <h2>数据</h2>
  <dl class="kv">
    <dt>订阅</dt><dd>${args.counts.feeds}</dd>
    <dt>文章总数</dt><dd>${args.counts.entries}</dd>
    <dt>已读</dt><dd>${args.counts.read}</dd>
    <dt>收藏</dt><dd>${args.counts.starred}</dd>
    <dt>保留策略</dt><dd>已读且未收藏的文章保留 ${args.cfg.retentionDays} 天；每个订阅最多保留 ${args.cfg.maxEntriesPerFeed} 篇（收藏除外）</dd>
    <dt>每次抓取</dt><dd>最多 ${args.cfg.maxFeedsPerRun} 个订阅，每个 ${args.cfg.maxItemsPerFetch} 篇文章</dd>
    <dt>轮询间隔</dt><dd>约 ${args.cfg.fetchIntervalMinutes} 分钟</dd>
  </dl>
</div>
<div class="card">
  <h2>运行状态</h2>
  <dl class="kv">
    <dt>数据库</dt><dd>${args.hasHyperdrive ? 'Hyperdrive 已绑定' : args.hasDatabaseUrl ? '使用 DATABASE_URL（仅建议本地开发）' : '未配置'}</dd>
    <dt>定时密钥</dt><dd>${args.hasCronSecret ? 'CRON_SECRET 已设置' : '<span class="error">CRON_SECRET 未设置，cron 会被拒绝</span>'}</dd>
    <dt>登录密码</dt><dd>${args.cfg.adminPassword ? 'ADMIN_PASSWORD 已设置' : '<span class="error">ADMIN_PASSWORD 未设置</span>'}</dd>
    <dt>健康检查</dt><dd><a class="code" href="/health">/health</a></dd>
  </dl>
</div>
<div class="card">
  <h2>使用说明</h2>
  <p class="muted">列表快捷键：<span class="code">j</span>/<span class="code">k</span> 移动，<span class="code">o</span> 或回车打开，<span class="code">s</span> 收藏，<span class="code">m</span> 标为已读。文章 HTML 在沙箱 iframe 中渲染，脚本不会执行。</p>
  <p class="muted">未实现（与 FreshRSS 的差距）：多用户、插件、Fever API、WebSub 实时推送、分享、主题、正文全文抽取。</p>
</div>`;
  return documentPage({
    cfg: args.cfg,
    title: '设置',
    body,
    user: args.user,
    subscriptions: args.subscriptions,
    totalUnread: args.totalUnread,
    starred: args.starred,
    activeNav: 'settings',
  });
}
