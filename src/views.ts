/** Server-rendered HTML. No build step, no external assets. */

import type { AppConfig } from './config';
import type { EntryRow, SubscriptionRow } from './store';
import type { Stream } from './stream';
import { escapeHtml as esc, formatDateTime, preview, timeAgo } from './util';

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--fg:#1c1c1a;--muted:#6f6f69;--line:#e5e5df;--accent:#1f6feb;--accent-soft:#e9f0fd;--danger:#b42318;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1a;--fg:#ecece7;--muted:#9a9a92;--line:#2f2f2b;--accent:#7aa7ff;--accent-soft:#1d2a44;--danger:#ff8a80}}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
a{color:inherit;text-decoration:none}
button{font:inherit}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:10px 18px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:16px;white-space:nowrap}
.search{flex:1;max-width:420px;margin-left:auto}
.search input{width:100%;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.topnav{display:flex;gap:14px;font-size:14px;color:var(--muted);white-space:nowrap}
.topnav a:hover{color:var(--fg)}
.shell{display:flex;align-items:flex-start;min-height:calc(100vh - 57px)}
.sidebar{width:252px;flex:none;position:sticky;top:57px;height:calc(100vh - 57px);overflow:auto;padding:14px 10px;border-right:1px solid var(--line)}
.nav{display:flex;flex-direction:column;gap:2px;margin-bottom:18px}
.nav-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:14px}
.nav-item:hover{background:var(--accent-soft)}
.nav-item.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.badge{margin-left:auto;background:var(--accent);color:#fff;border-radius:999px;font-size:11px;line-height:1;padding:4px 7px;font-weight:600}
.side-head{display:flex;justify-content:space-between;align-items:center;padding:0 10px 6px;font-size:12px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
.side-head a{text-transform:none;letter-spacing:0}
.folder-label{padding:8px 10px 3px;font-size:12.5px;color:var(--muted);display:flex;gap:6px;align-items:center}
.feed-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:14px;color:var(--fg)}
.feed-item:hover{background:var(--accent-soft)}
.feed-item.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.avatar{width:17px;height:17px;flex:none;border-radius:4px;background:var(--line);color:var(--muted);font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:700}
.feed-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-foot{margin-top:20px;padding:10px;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
main{flex:1;min-width:0;width:100%;max-width:880px;margin:0 auto;padding:22px 22px 70px}
.page-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 6px}
.page-head h1{font-size:21px;margin:0;letter-spacing:-.01em}
.subhead{color:var(--muted);font-size:13px;margin:0 0 18px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);cursor:pointer;font-size:13.5px}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.small{padding:4px 9px;font-size:12.5px}
.btn.danger{color:var(--danger)}
.link{border:0;background:none;color:var(--muted);cursor:pointer;padding:0;font-size:13px}
.link:hover{color:var(--fg)}
.article{display:flex;gap:12px;align-items:flex-start;padding:15px 2px;border-bottom:1px solid var(--line)}
.article.cursor{background:var(--accent-soft);border-radius:8px;margin:0 -10px;padding:15px 12px;border-bottom-color:transparent}
.article-main{min-width:0;flex:1}
.article-title{font-weight:600;font-size:16px;line-height:1.35;display:block}
.article-title:hover{color:var(--accent)}
.article.is-read .article-title,.article.is-read .excerpt{opacity:.55}
.article-meta{display:flex;flex-wrap:wrap;gap:7px;color:var(--muted);font-size:12.5px;margin:4px 0 5px}
.excerpt{margin:0;color:var(--muted);font-size:13.5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.star-btn{border:0;background:none;color:var(--muted);font-size:21px;line-height:1;cursor:pointer;padding:2px 4px}
.is-starred .star-btn{color:#d9a400}
.empty{color:var(--muted);padding:40px 4px;text-align:center}
.pager{display:flex;justify-content:center;gap:14px;padding:26px 0;font-size:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:0 0 16px}
.card h2{font-size:15px;margin:0 0 12px}
.card p:last-child{margin-bottom:0}
.form-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=url],input[type=text],input[type=password],input[type=search],select{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:13.5px;min-width:0}
.form-row input[type=url],.form-row input[type=text]{flex:1;min-width:200px}
label{display:block;font-size:13px;color:var(--muted);margin:0 0 4px}
.muted{color:var(--muted)}
.error{color:var(--danger)}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:rgba(127,127,127,.13);padding:2px 6px;border-radius:5px;word-break:break-all}
pre.code{display:block;padding:12px;border-radius:8px;white-space:pre-wrap;line-height:1.5;margin:8px 0}
.feed-row{border-bottom:1px solid var(--line);padding:14px 0}
.feed-row:last-child{border-bottom:0}
.feed-row-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.feed-row-title{font-weight:600;font-size:15px}
.feed-row-url{color:var(--muted);font-size:12.5px;word-break:break-all}
.feed-row-url a:hover{color:var(--accent)}
.feed-row-actions{display:flex;gap:6px;flex:none}
.feed-edit{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.feed-edit input{flex:1;min-width:120px}
.feed-row-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted);font-size:12px;margin-top:8px}
.reader h1{font-size:24px;line-height:1.3;margin:8px 0 6px;letter-spacing:-.01em}
.reader .article-meta{font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
iframe.article-frame{width:100%;min-height:320px;border:0;background:transparent;display:block}
.back{font-size:13.5px;color:var(--muted)}
.back:hover{color:var(--fg)}
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.auth-card{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.auth-card h1{font-size:20px;margin:0 0 4px}
.auth-card label{margin:14px 0 0}
.auth-card input{width:100%;margin-top:5px}
.auth-card .btn{width:100%;margin-top:20px;padding:10px}
.setup{max-width:720px;margin:40px auto;padding:0 20px}
.setup ul{line-height:1.9}
.kv{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;font-size:13.5px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;word-break:break-all}
@media (max-width:760px){
  .topbar{flex-wrap:wrap;gap:8px}
  .brand{font-size:15px}
  .search{order:3;flex-basis:100%;max-width:none}
  .topnav{font-size:13px;margin-left:auto}
  .shell{display:block}
  .sidebar{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 12px}
  .nav{flex-direction:row;overflow:auto;margin-bottom:10px}
  .nav-item{white-space:nowrap;padding:6px 10px}
  .badge{margin-left:4px}
  main{padding:16px 14px 60px}
  .reader h1{font-size:20px}
  .feed-row-head{flex-direction:column}
}
`;

const CLIENT_JS = `
(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.article'));
  var cursor = -1;
  function post(body){
    return fetch('/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true});
  }
  function markRead(id,row){
    if(row){row.classList.add('is-read');}
    var payload = JSON.stringify({ids:[id],read:true});
    if(navigator.sendBeacon){
      try{ if(navigator.sendBeacon('/api/state',new Blob([payload],{type:'application/json'}))){return;} }catch(err){}
    }
    post({ids:[id],read:true});
  }
  function toggleStar(btn){
    var row = btn.closest('.article');
    var starred = !row.classList.contains('is-starred');
    row.classList.toggle('is-starred',starred);
    btn.textContent = starred ? '★' : '☆';
    btn.setAttribute('title',starred ? '取消收藏' : '收藏');
    post({ids:[btn.getAttribute('data-star')],starred:starred});
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
    if(e.target && e.target.closest && e.target.closest('input, textarea, select')){return;}
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
        if(doc && doc.documentElement){
          frame.style.height = Math.max(240,doc.documentElement.scrollHeight+32)+'px';
        }
      }catch(err){}
    }
    frame.addEventListener('load',resize);
    window.addEventListener('resize',resize);
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
): string {
  return `<a class="nav-item${active ? ' active' : ''}" href="${href}"><span>${label}</span>${badge(count)}</a>`;
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
      feedsHtml += `<a class="folder-label" href="/?folder=${encodeURIComponent(folder)}">${esc(folder)}${unread ? `<span class="badge">${unread}</span>` : ''}</a>`;
    }
    for (const sub of subs) {
      const title = sub.title || sub.feed_title || sub.url;
      const active = options.activeFeedId === sub.feed_id;
      feedsHtml += `<a class="feed-item${active ? ' active' : ''}" href="/?feed=${sub.feed_id}" title="${esc(title)}">
        <span class="avatar">${esc((title || '?').slice(0, 1).toUpperCase())}</span>
        <span class="feed-name">${esc(title)}</span>
        ${badge(sub.unread)}
      </a>`;
    }
  }

  return `<aside class="sidebar">
    <nav class="nav">
      ${navLink('/', '全部文章', options.totalUnread, options.activeNav === 'all')}
      ${navLink('/?stream=unread', '未读', options.totalUnread, options.activeNav === 'unread')}
      ${navLink('/?stream=starred', '收藏', options.starred, options.activeNav === 'starred')}
      ${navLink('/feeds', '订阅管理', subscriptions.length, options.activeNav === 'feeds')}
      ${navLink('/settings', '设置', undefined, options.activeNav === 'settings')}
    </nav>
    <div class="side-head"><span>订阅源</span><a href="/feeds">管理</a></div>
    ${feedsHtml || '<div class="folder-label">还没有订阅</div>'}
    <div class="side-foot">
      <span>${esc(options.user?.username ?? '')}</span>
      <form method="post" action="/logout"><button class="link" type="submit">退出</button></form>
    </div>
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
<body>
<header class="topbar">
  <a class="brand" href="/">${esc(options.cfg.siteName)}</a>
  ${withSidebar ? `<form class="search" method="get" action="/" role="search"><input type="search" name="q" value="${esc(options.search ?? '')}" placeholder="搜索文章" aria-label="搜索文章"></form>` : ''}
  <nav class="topnav">
    ${withSidebar ? '<a href="/feeds">订阅</a><a href="/settings">设置</a>' : ''}
  </nav>
</header>
${withSidebar ? `<div class="shell">${sidebar(options)}<main>${options.body}</main></div>` : options.body}
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
    <h1>${esc(cfg.siteName)}</h1>
    <p class="muted">登录后阅读你的订阅</p>
    ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
    <label>用户名<input name="username" autocomplete="username" required autofocus></label>
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
  const activeNav =
    stream.kind === 'unread' ? 'unread' : stream.kind === 'starred' ? 'starred' : 'all';
  const activeFeedId = stream.kind === 'feed' ? Number(stream.ref) || null : null;
  const activeFolder = stream.kind === 'label' ? stream.label : null;

  const items = args.entries
    .map(
      (entry) => `<li class="article${entry.read ? ' is-read' : ''}${entry.starred ? ' is-starred' : ''}" data-id="${esc(entry.item_id)}">
  <div class="article-main">
    <a class="article-title" href="/item/${encodeURIComponent(entry.item_id)}" data-mark-read="${esc(entry.item_id)}">${esc(entry.title || '(无标题)')}</a>
    <div class="article-meta">
      <span>${esc(entry.feed_title)}</span>
      ${entry.folder ? `<span>· ${esc(entry.folder)}</span>` : ''}
      <span>· ${timeAgo(entry.published_ms)}</span>
      ${entry.enclosure_url ? '<span>· 附件</span>' : ''}
    </div>
    <p class="excerpt">${esc(preview(entry.summary || entry.content || '', 200))}</p>
  </div>
  <button class="star-btn" type="button" data-star="${esc(entry.item_id)}" title="${entry.starred ? '取消收藏' : '收藏'}" aria-label="${entry.starred ? '取消收藏' : '收藏'}">${entry.starred ? '★' : '☆'}</button>
</li>`,
    )
    .join('\n');

  const body = `<div class="page-head">
  <h1>${esc(args.heading)}</h1>
  <form method="post" action="/mark-all-read" onsubmit="return confirm('把当前列表中的文章全部标为已读？')">
    ${streamHiddenFields(stream, args.search)}
    <button class="btn small" type="submit">全部标为已读</button>
  </form>
</div>
<p class="subhead">${esc(args.subheading)}</p>
${args.entries.length > 0 ? `<ul class="articles" style="list-style:none;margin:0;padding:0">${items}</ul>` : '<div class="empty">这里还没有文章。订阅之后，抓取会在后台进行。</div>'}
${args.hasMore ? `<div class="pager"><a class="btn" href="${pageHref(stream, args.search, args.cursor)}">下一页 →</a></div>` : ''}`;

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
  const style = `:root{color-scheme:light dark}html,body{margin:0;padding:0;background:transparent;color:inherit;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}body{padding:4px 2px 24px;overflow-wrap:break-word}img,video{max-width:100%;height:auto}pre{overflow:auto;background:rgba(127,127,127,.14);padding:12px;border-radius:8px;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}blockquote{margin:0;padding-left:14px;border-left:3px solid rgba(127,127,127,.4);opacity:.9}a{color:#2563eb}table{max-width:100%;display:block;overflow:auto;border-collapse:collapse}td,th{border:1px solid rgba(127,127,127,.35);padding:4px 8px}figure{margin:0}iframe{max-width:100%}audio{width:100%}`;
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
${args.flash ? `<div class="card"><p>${esc(args.flash)}</p></div>` : ''}
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
