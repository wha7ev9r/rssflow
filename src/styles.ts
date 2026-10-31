/** Inline styles for the server-rendered reader; no external fonts or assets. */
export const CSS = `
:root{color-scheme:light dark;--bg:#f5f7f8;--panel:#fff;--sidebar:#edf2f3;--fg:#22333b;--muted:#586b73;--line:#dbe3e7;--accent:#28666e;--accent-soft:#e0edef;--accent-ink:#fff;--danger:#ae3c3c;--star:#986817;--radius:12px;--topbar:72px;--sidebar-width:248px;--ui:"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--reading:"Iowan Old Style","Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif}
@media(prefers-color-scheme:dark){:root{--bg:#19252b;--panel:#202e35;--sidebar:#1c2930;--fg:#e3ecef;--muted:#a1b4bd;--line:#36464e;--accent:#91c5cc;--accent-soft:#2c444d;--accent-ink:#17343b;--danger:#ffaaa3;--star:#e5bd72}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 var(--ui);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button,input,select{font:inherit}
button,a,input,summary,select{-webkit-tap-highlight-color:transparent}
button{color:inherit}
button:not(:disabled),summary{cursor:pointer}
button:disabled{cursor:wait;opacity:.65}
:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
::selection{background:var(--accent-soft);color:var(--fg)}
svg.icon{width:20px;height:20px;flex:none;vertical-align:middle}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip-link{position:fixed;top:12px;left:12px;z-index:100;padding:10px 18px;background:var(--accent);color:var(--accent-ink);border-radius:8px;transform:translateY(-150%)}
.skip-link:focus{transform:translateY(0)}
.topbar{height:var(--topbar);position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:24px;padding:0 28px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:11px;min-width:0;max-width:40%;font-size:17px;font-weight:700;letter-spacing:-.025em}
.brand-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand-mark{display:grid;place-items:center;flex:none;width:35px;height:35px;border-radius:10px;background:var(--accent);color:var(--accent-ink)}
.brand-mark .icon{width:21px;height:21px}
.search{position:relative;flex:1;max-width:400px;margin:0 auto}
.search>.icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;width:18px;height:18px}
.topbar .search input{width:100%;padding:10px 14px 10px 42px;border:1px solid transparent;border-radius:9px;background:var(--bg);color:var(--fg);font-size:13px;transition:border-color .16s,background .16s}
.topbar .search input:focus{border-color:var(--accent);background:var(--panel)}
.topnav{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none;font-size:13px;color:var(--muted)}
.topnav a{display:flex;align-items:center;gap:6px;padding:8px 11px;border-radius:8px;transition:color .16s,background .16s}
.topnav a:hover,.topnav a[aria-current=page]{color:var(--accent);background:var(--accent-soft)}
.topnav .icon{width:17px;height:17px}
.shell{display:flex;align-items:flex-start;min-height:calc(100dvh - var(--topbar))}
.sidebar{width:var(--sidebar-width);flex:none;position:sticky;top:var(--topbar);height:calc(100dvh - var(--topbar));overflow:auto;padding:28px 16px 20px;background:var(--sidebar);border-right:1px solid var(--line);scrollbar-width:thin}
.nav{display:flex;flex-direction:column;gap:5px;margin-bottom:26px}
.nav-item{display:flex;align-items:center;gap:11px;min-height:43px;padding:9px 13px;border-radius:8px;color:var(--muted);font-size:13px;transition:background .16s,color .16s}
.nav-item:hover{background:var(--panel);color:var(--fg)}
.nav-item.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.nav-item .icon{width:18px;height:18px}
.badge{margin-left:auto;flex:none;min-width:23px;padding:1px 6px;border-radius:6px;font-size:11px;line-height:1.65;font-weight:600;font-variant-numeric:tabular-nums;color:var(--muted);background:var(--panel);text-align:center}
.active>.badge{color:var(--accent);background:var(--panel)}
.feed-panel{border-top:1px solid var(--line)}
.side-head{list-style:none;display:flex;align-items:center;gap:7px;min-height:48px;padding:14px 12px 10px;color:var(--muted);font-size:12px;font-weight:600}
.side-head::-webkit-details-marker{display:none}
.side-head .icon{margin-left:auto;width:15px;height:15px;transform:rotate(-90deg);transition:transform .18s}
.feed-panel[open] .side-head .icon{transform:rotate(0deg)}
.source-count{font-variant-numeric:tabular-nums;font-weight:400}
.folder-label{display:flex;align-items:center;gap:6px;min-height:38px;padding:12px 12px 4px;color:var(--muted);font-size:11px;font-weight:600;overflow-wrap:anywhere}
.folder-label.active{color:var(--accent)}
.folder-label .badge{background:transparent;padding:0;font-size:10px}
.feed-item{display:flex;align-items:center;gap:9px;min-height:39px;padding:8px 12px;border-radius:8px;font-size:12px;transition:background .16s,color .16s}
.feed-item:hover{background:var(--panel)}
.feed-item.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.avatar{display:grid;place-items:center;flex:none;width:23px;height:23px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--muted);font-size:11px;font-weight:600}
.feed-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-foot{display:flex;align-items:center;gap:10px;margin:24px 10px 0;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.side-foot>span{overflow-wrap:anywhere;min-width:0}
.side-foot>form{margin-left:auto;flex:none}
.keyboard-hint{display:flex;align-items:center;gap:5px;padding:20px 10px 0;color:var(--muted);font-size:10px;flex-wrap:wrap}
kbd{display:inline-grid;place-items:center;min-width:20px;padding:0 4px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;background:var(--panel);font:11px/1.7 var(--ui)}
.keyboard-hint span{margin:0 6px 0 2px}
main{flex:1;min-width:0;width:100%;max-width:960px;margin:0 auto;padding:42px clamp(24px,4.5vw,64px) 88px;scroll-margin-top:calc(var(--topbar) + 16px)}
.page-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:0 0 8px}
.page-head h1{font-size:30px;line-height:1.35;font-weight:650;letter-spacing:-.035em;margin:0;overflow-wrap:anywhere}
.page-head>form{flex:none}
.subhead{max-width:68ch;margin:0 0 30px;color:var(--muted);font-size:12px;line-height:1.8}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:8px 15px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font-size:12px;font-weight:550;line-height:1.5;text-align:center;transition:background .16s,border-color .16s,color .16s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(.93)}
.btn.small{min-height:35px;padding:6px 11px;font-size:11px}
.btn.danger{color:var(--danger)}
.btn .icon{width:16px;height:16px}
.link{border:0;background:none;color:var(--muted);min-height:32px;padding:3px 0;font-size:12px;text-underline-offset:4px}
.link:hover{color:var(--accent);text-decoration:underline}
.articles{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.article{position:relative;display:flex;gap:14px;align-items:flex-start;padding:24px 0 24px 18px;border-bottom:1px solid var(--line);transition:background .18s;scroll-margin-top:calc(var(--topbar) + 18px)}
.article::before{content:"";position:absolute;left:0;top:30px;width:5px;height:5px;border-radius:50%;background:var(--accent);transition:opacity .18s}
.article.is-read::before{opacity:0}
.article.cursor{background:var(--accent-soft);box-shadow:12px 0 var(--accent-soft),-12px 0 var(--accent-soft);border-radius:6px}
.article-main{min-width:0;flex:1}
.article-title{display:block;margin:7px 0 9px;font-size:19px;line-height:1.5;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere;transition:color .16s}
.article-title:hover{color:var(--accent)}
.article.is-read .article-title{color:var(--muted);font-weight:450}
.article-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;color:var(--muted);font-size:11px;line-height:1.7}
.article-source{font-weight:600;color:var(--accent)}
.article.is-read .article-source{color:var(--muted)}
.article-meta time{white-space:nowrap;font-variant-numeric:tabular-nums}
.article-meta a:hover{text-decoration:underline;text-underline-offset:3px}
.excerpt{margin:0;max-width:72ch;color:var(--muted);font-size:13px;line-height:1.8;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.excerpt:empty{display:none}
.star-btn{flex:none;display:grid;place-items:center;width:38px;height:38px;margin-top:17px;border:1px solid transparent;border-radius:8px;background:none;color:var(--muted);font-size:22px;line-height:1;transition:color .16s,background .16s,transform .16s}
.star-btn:hover{background:var(--accent-soft);transform:scale(1.08)}
.is-starred .star-btn{color:var(--star)}
.empty{padding:64px 20px;text-align:center;border:1px dashed var(--line);border-radius:var(--radius)}
.empty>.icon{width:34px;height:34px;color:var(--accent);margin-bottom:12px}
.empty h2{margin:0 0 8px;font-size:19px;font-weight:600}
.empty p{max-width:42ch;margin:0 auto 22px;color:var(--muted);font-size:13px}
.pager{display:flex;justify-content:center;gap:14px;padding:30px 0;font-size:13px}
.card{padding:24px;margin:0 0 18px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
.card h2{margin:0 0 15px;font-size:15px;font-weight:650;letter-spacing:-.015em}
.card p{font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.card p:last-child{margin-bottom:0}
.action-status:empty{display:none}
.notice{padding:12px 16px;margin:0 0 20px;border-left:3px solid var(--accent);border-radius:0 8px 8px 0;background:var(--accent-soft);font-size:13px;overflow-wrap:anywhere}
.form-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
input[type=url],input[type=text],input[type=password],input[type=search],select{min-width:0;min-height:42px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px;transition:border-color .16s,background .16s}
input::placeholder{color:var(--muted);opacity:1}
input:focus,select:focus{border-color:var(--accent)}
.form-row input[type=url],.form-row input[type=text]{flex:1;min-width:160px}
input[type=file]{width:100%;min-width:0;max-width:100%;font-size:12px;color:var(--muted)}
input::file-selector-button{margin-right:12px;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit;cursor:pointer}
label{display:block;margin:0 0 5px;color:var(--muted);font-size:12px}
.muted{color:var(--muted)}
.error{color:var(--danger);overflow-wrap:anywhere}
.code{padding:2px 5px;border-radius:4px;background:var(--bg);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
pre.code{display:block;white-space:pre-wrap;line-height:1.8;margin:10px 0;padding:14px;border:1px solid var(--line);border-radius:8px}
.feed-row{padding:22px 0;border-bottom:1px solid var(--line)}
.feed-row:first-of-type{padding-top:5px}
.feed-row:last-child{padding-bottom:0;border-bottom:0}
.feed-row-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.feed-row-head>div:first-child{min-width:0}
.feed-row-title{font-size:15px;font-weight:600;overflow-wrap:anywhere}
.feed-row-url{margin-top:4px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}
.feed-row-url a:hover{color:var(--accent)}
.feed-row-actions{display:flex;gap:6px;flex:none}
.feed-edit{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.feed-edit input{flex:1;min-width:100px}
.feed-row-meta{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:12px;color:var(--muted);font-size:11px}
.reader{max-width:740px;margin:0 auto}
.reader h1{font:600 clamp(25px,3vw,34px)/1.5 var(--reading);letter-spacing:-.025em;margin:24px 0 18px;overflow-wrap:anywhere}
.reader .article-meta{font-size:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:26px 0;padding:17px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
iframe.article-frame{display:block;width:100%;min-height:320px;border:0;background:transparent;color-scheme:light dark}
.back{display:inline-flex;align-items:center;gap:7px;min-height:36px;color:var(--muted);font-size:12px}
.back:hover{color:var(--accent)}
.auth-wrap{min-height:calc(100dvh - var(--topbar));display:grid;place-items:center;padding:40px 20px}
.auth-card{width:100%;max-width:420px;padding:38px;background:var(--panel);border:1px solid var(--line);border-radius:16px}
.auth-symbol{display:grid;place-items:center;width:45px;height:45px;margin-bottom:25px;border-radius:12px;background:var(--accent-soft);color:var(--accent)}
.auth-symbol .icon{width:25px;height:25px}
.auth-card h1{font-size:26px;font-weight:650;line-height:1.4;letter-spacing:-.03em;margin:0 0 8px}
.auth-card>p{font-size:13px;margin:0 0 26px}
.auth-card label{margin:18px 0 0}
.auth-card input{width:100%;margin-top:7px;min-height:46px}
.auth-card .btn{width:100%;min-height:46px;margin-top:26px;font-size:13px}
.auth-card .error{padding:11px 14px;border:1px solid var(--danger);border-radius:8px}
.setup{max-width:720px;margin:48px auto;padding:0 24px}
.setup h1{font-size:28px}
.setup ul{line-height:1.9}
.kv{display:grid;grid-template-columns:115px minmax(0,1fr);gap:13px 20px;margin:20px 0 0;font-size:12px;line-height:1.8}
.kv dt{color:var(--muted)}
.kv dd{margin:0;overflow-wrap:anywhere}
@media(max-width:1100px){:root{--sidebar-width:218px}.sidebar{padding-left:10px;padding-right:10px}main{padding-left:30px;padding-right:30px}.topbar{gap:18px;padding:0 22px}.page-head h1{font-size:27px}}
@media(max-width:760px){
  :root{--topbar:124px}
  .topbar{height:var(--topbar);flex-wrap:wrap;align-content:center;gap:10px;padding:12px 18px}
  .brand{max-width:60%;font-size:15px;gap:9px}.brand-mark{width:31px;height:31px;border-radius:9px}
  .topnav{gap:2px;font-size:12px}.topnav a{padding:8px;min-height:44px}.topnav .icon{display:none}
  .search{flex-basis:100%;max-width:none;order:3}.topbar .search input{min-height:40px;padding-top:7px;padding-bottom:7px;padding-left:40px;font-size:16px}
  .shell{display:block}.sidebar{position:static;width:auto;height:auto;overflow:visible;border-right:0;border-bottom:1px solid var(--line);padding:12px 18px 0}
  .nav{flex-direction:row;gap:6px;margin-bottom:0}.nav-item{flex:1;justify-content:center;min-height:42px;gap:7px;padding:8px;font-size:12px;white-space:nowrap}.nav-item:nth-child(n+4){display:none}.nav-item .icon{width:16px;height:16px}.nav-item .badge{margin-left:0;background:transparent;min-width:0;padding:0;font-size:10px}
  .feed-panel{border-top:0}.side-head{min-height:42px;padding:10px 4px;font-size:11px}.source-count{margin-left:3px}.side-head .icon{margin-left:auto}.feed-collection{padding:0 0 16px}.feed-item{min-height:44px;font-size:13px}.folder-label{min-height:40px;font-size:12px}
  .side-foot{margin:18px 12px 0;font-size:13px}.side-foot .link{min-height:44px}.keyboard-hint{display:none}
  main{padding:26px 20px 56px}.page-head{gap:12px;align-items:flex-start}.page-head h1{font-size:25px;line-height:1.45}.page-head .btn.small{font-size:11px;padding:7px 9px;min-height:44px}.subhead{font-size:11px;margin-bottom:21px}
  .article{padding:20px 0 20px 14px;gap:6px}.article::before{top:27px;width:4px;height:4px}.article-title{font-size:17px;line-height:1.6;margin:6px 0 8px}.article-meta{font-size:11px;gap:5px 9px}.excerpt{font-size:13px;line-height:1.85}.star-btn{width:44px;height:44px;margin-top:12px}.article.cursor{box-shadow:6px 0 var(--accent-soft),-6px 0 var(--accent-soft)}
  input[type=url],input[type=text],input[type=password],input[type=search],select,.auth-card input{font-size:16px}
  .card{padding:19px;margin-bottom:14px}.card h2{font-size:14px}.card p{font-size:12px}.btn,.btn.small{min-height:44px}.feed-row-head{flex-direction:column;gap:12px}.feed-row-actions{width:100%}.feed-row-actions form{flex:1}.feed-row-actions .btn{width:100%}.feed-edit{gap:8px}.feed-edit input{flex-basis:100%;min-height:44px}.feed-edit .btn{margin-left:auto}.form-row input[type=url],.form-row input[type=text]{flex-basis:100%;min-height:44px}.form-row>.btn.primary{width:100%}
  .kv{grid-template-columns:82px minmax(0,1fr);gap:12px;font-size:11px}.reader h1{font-size:25px;line-height:1.6;margin:18px 0}.reader .article-meta{font-size:11px}.actions{gap:8px;margin:22px 0;padding:14px 0}.actions .btn{padding-left:11px;padding-right:11px;font-size:11px}.empty{padding:42px 20px}.empty h2{font-size:17px}.empty p{font-size:12px}.auth-card{padding:28px}.auth-wrap{min-height:calc(100dvh - 65px)}
  body.without-sidebar{--topbar:65px}.without-sidebar .topbar{flex-wrap:nowrap}.without-sidebar .brand{max-width:100%}
}
@supports(interpolate-size:allow-keywords){.feed-panel::details-content{height:0;overflow:hidden;interpolate-size:allow-keywords;transition:height .2s ease,content-visibility .2s allow-discrete}.feed-panel[open]::details-content{height:auto}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}.star-btn:hover{transform:none}.feed-panel::details-content{transition:none}}
`;

export const ARTICLE_CSS = `
:root{color-scheme:light dark}
html,body{margin:0;padding:0;background:transparent;color:#22333b;font:17px/1.95 "Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{padding:2px 0 28px;overflow-wrap:anywhere}
p{margin:0 0 1.25em}h1,h2,h3,h4{line-height:1.5;margin:1.6em 0 .7em;font-weight:600}h2{font-size:1.35em}h3{font-size:1.15em}
img,video{max-width:100%;height:auto;border-radius:6px}figure{margin:1.5em 0}figcaption{color:#586b73;font-size:.8em;text-align:center}
pre{overflow:auto;white-space:pre;background:#edf2f3;padding:18px;border-radius:8px;font-size:13px;line-height:1.75}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{margin:1.5em 0;padding:4px 0 4px 20px;border-left:3px solid #9cbcc3;color:#586b73}blockquote p:last-child{margin-bottom:0}
a{color:#28666e;text-underline-offset:4px}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}
table{max-width:100%;display:block;overflow:auto;border-collapse:collapse;font-size:.9em}td,th{border:1px solid #dbe3e7;padding:7px 12px;text-align:left}iframe{max-width:100%}audio{width:100%}hr{border:0;border-top:1px solid #dbe3e7;margin:2em 0}
@media(prefers-color-scheme:dark){html,body{color:#e3ecef}pre{background:#202e35}a{color:#91c5cc}blockquote,figcaption{color:#a1b4bd}td,th,hr{border-color:#36464e}}
@media(max-width:480px){html,body{font-size:16px;line-height:1.9}pre{padding:12px;font-size:12px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
