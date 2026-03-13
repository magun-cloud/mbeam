'use strict';

// Generates the `/_beam` inspector dashboard HTML.
// A real-time UI for humans and agents to observe what flows through a tunnel.

function renderInspector(subdomain, url) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mbeam · ${subdomain}</title>
<style>
:root{
  --bg:#080808;--surface:#0f0f0f;--card:#141414;--border:#1e1e1e;
  --accent:#6366f1;--accent-dim:#2e2f6e;
  --green:#22c55e;--green-dim:#14532d;
  --red:#ef4444;--red-dim:#450a0a;
  --yellow:#f59e0b;--blue:#38bdf8;--purple:#a78bfa;--orange:#fb923c;
  --text:#e5e5e5;--dim:#555;--dim2:#333;
  --mono:'SF Mono','Fira Code','Menlo',monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:14px;overflow:hidden}

/* ── Header ── */
header{
  height:48px;display:flex;align-items:center;gap:10px;padding:0 16px;
  border-bottom:1px solid var(--border);flex-shrink:0;
}
.logo{font-weight:700;font-size:15px;color:var(--accent);letter-spacing:-.03em;user-select:none}
.logo span{color:var(--dim)}
.url-chip{
  font-family:var(--mono);font-size:12px;padding:3px 10px;
  background:var(--card);border:1px solid var(--border);border-radius:5px;
  cursor:pointer;color:var(--text);transition:border-color .15s;
}
.url-chip:hover{border-color:var(--accent)}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;letter-spacing:.03em}
.badge-online{background:var(--green-dim);color:var(--green)}
.badge-offline{background:var(--red-dim);color:var(--red)}
.badge-unknown{background:var(--dim2);color:var(--dim)}
.fw-badge{font-size:11px;color:var(--dim);padding:2px 8px;background:var(--card);border:1px solid var(--border);border-radius:4px}
.spacer{flex:1}
.inspector-label{font-size:11px;color:var(--dim2)}

/* ── Layout ── */
.layout{display:grid;grid-template-columns:1fr 300px;height:calc(100vh - 48px);overflow:hidden}

/* ── Panel ── */
.panel{display:flex;flex-direction:column;overflow:hidden}
.panel-hdr{
  height:36px;display:flex;align-items:center;gap:8px;padding:0 14px;
  border-bottom:1px solid var(--border);font-size:11px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.07em;flex-shrink:0;
}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.8s ease infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}

/* ── Traffic log ── */
.log{flex:1;overflow-y:auto;overscroll-behavior:contain}
.log-row{
  display:grid;grid-template-columns:68px 52px 1fr 44px 56px;
  gap:8px;padding:5px 14px;border-bottom:1px solid #0d0d0d;
  align-items:center;cursor:default;transition:background .08s;
}
.log-row:hover{background:var(--card)}
.log-row.flash{animation:rowflash .5s ease}
@keyframes rowflash{0%{background:var(--accent-dim)}100%{background:transparent}}
.ts{color:var(--dim);font-family:var(--mono);font-size:11px}
.method{font-family:var(--mono);font-size:11px;font-weight:700}
.path-cell{font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-family:var(--mono);font-size:12px;font-weight:700;text-align:right}
.lat{font-family:var(--mono);font-size:11px;color:var(--dim);text-align:right}
.s2{color:var(--green)}.s3{color:var(--blue)}.s4{color:var(--yellow)}.s5{color:var(--red)}
.m-GET{color:var(--blue)}.m-POST{color:var(--purple)}.m-PUT{color:var(--orange)}
.m-DELETE{color:var(--red)}.m-PATCH{color:var(--green)}.m-OTHER{color:var(--dim)}
.empty-state{padding:32px 16px;text-align:center;color:var(--dim);font-size:13px}

/* ── Sidebar ── */
.sidebar{border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.stats-grid{display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid var(--border)}
.stat{padding:10px 12px;border-right:1px solid var(--border)}
.stat:last-child{border-right:none}
.stat-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.stat-val{font-family:var(--mono);font-size:18px;font-weight:700}
.route-list{flex:1;overflow-y:auto}
.route-item{
  display:flex;align-items:center;gap:6px;padding:6px 12px;
  border-bottom:1px solid #0d0d0d;
}
.route-item:hover{background:var(--card)}
.rmethod{font-family:var(--mono);font-size:10px;font-weight:700;width:42px;flex-shrink:0}
.rpath{font-family:var(--mono);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc}
.rcnt{font-size:10px;color:var(--dim);font-family:var(--mono)}
.rerr{font-size:10px;font-family:var(--mono)}
.rerr.hi{color:var(--red)}.rerr.md{color:var(--yellow)}.rerr.lo{color:var(--dim)}

/* ── Agent API docs tab ── */
.api-docs{overflow-y:auto;flex:1;padding:12px;font-size:12px;line-height:1.6;color:#aaa}
.api-docs code{
  display:block;background:var(--card);border:1px solid var(--border);
  padding:8px 10px;border-radius:4px;font-family:var(--mono);font-size:11px;
  color:#ccc;margin:6px 0 12px;word-break:break-all;
}
.api-docs h3{color:var(--text);font-size:12px;margin-bottom:4px;margin-top:12px}
.api-docs h3:first-child{margin-top:0}

/* ── Tab bar ── */
.tab-bar{display:flex;border-bottom:1px solid var(--border);flex-shrink:0}
.tab{
  padding:6px 14px;font-size:11px;cursor:pointer;color:var(--dim);
  border-bottom:2px solid transparent;margin-bottom:-1px;
}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab-panel{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab-panel.active{display:flex}

/* ── Toast ── */
.toast{
  position:fixed;bottom:16px;right:16px;background:var(--accent);
  color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;
  opacity:0;pointer-events:none;transition:opacity .2s;z-index:999;
}
.toast.show{opacity:1}

/* ── Offline banner ── */
.offline-banner{
  display:none;padding:7px 14px;background:var(--red-dim);
  border-bottom:1px solid #5a1a1a;font-size:12px;color:var(--red);
  text-align:center;flex-shrink:0;
}
.offline-banner.show{display:block}
</style>
</head>
<body>

<header>
  <div class="logo">✦ m<span>beam</span></div>
  <div class="url-chip" onclick="copyUrl()" title="Click to copy">${url}</div>
  <span class="badge badge-unknown" id="status-badge">CONNECTING</span>
  <span class="fw-badge" id="fw-badge" style="display:none"></span>
  <div class="spacer"></div>
  <span class="inspector-label">inspector · <a href="/_beam/api/stats" target="_blank" style="color:var(--dim);text-decoration:none">api</a></span>
</header>

<div class="offline-banner" id="offline-banner">
  Local server is offline — serving cached responses where available
</div>

<div class="layout">
  <!-- Traffic log -->
  <div class="panel">
    <div class="panel-hdr">
      <div class="live-dot"></div>
      Live Traffic
      <span style="margin-left:auto;color:var(--dim2)" id="req-count">0 requests</span>
    </div>
    <div class="log" id="log">
      <div class="empty-state">Waiting for requests…</div>
    </div>
  </div>

  <!-- Sidebar -->
  <div class="sidebar">
    <div class="stats-grid">
      <div class="stat">
        <div class="stat-label">Reqs</div>
        <div class="stat-val" id="stat-reqs">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Errors</div>
        <div class="stat-val s5" id="stat-errs">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Err%</div>
        <div class="stat-val" id="stat-rate">0%</div>
      </div>
    </div>

    <div class="tab-bar">
      <div class="tab active" onclick="switchTab('routes',this)">Routes</div>
      <div class="tab" onclick="switchTab('api',this)">Agent API</div>
    </div>

    <div class="tab-panel active" id="tab-routes">
      <div class="panel-hdr" style="font-size:10px">ROUTES DISCOVERED</div>
      <div class="route-list" id="routes">
        <div class="empty-state">No routes yet</div>
      </div>
    </div>

    <div class="tab-panel" id="tab-api">
      <div class="api-docs">
        <h3>Subscribe to live events (SSE)</h3>
        <code>curl -N "${url}/_beam/stream"</code>

        <h3>Full tunnel stats</h3>
        <code>curl "${url}/_beam/api/stats"</code>

        <h3>Recent traffic</h3>
        <code>curl "${url}/_beam/api/traffic"</code>

        <h3>Discovered routes</h3>
        <code>curl "${url}/_beam/api/routes"</code>

        <p style="margin-top:12px;color:var(--dim)">
          Events emitted: <strong style="color:#aaa">request</strong>,
          <strong style="color:#aaa">online</strong>,
          <strong style="color:#aaa">offline</strong>,
          <strong style="color:#aaa">app</strong>,
          <strong style="color:#aaa">state</strong>
        </p>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const SUBDOMAIN = '${subdomain}';
let totalReqs = 0, totalErrs = 0;
const routeMap = {};

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
}

// ── Copy URL ───────────────────────────────────────────────────────────────
function copyUrl() {
  navigator.clipboard.writeText('${url}').then(() => toast('URL copied!'));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Status colors ──────────────────────────────────────────────────────────
function statusClass(s) {
  if (s < 300) return 's2';
  if (s < 400) return 's3';
  if (s < 500) return 's4';
  return 's5';
}
const METHOD_COLORS = { GET:'m-GET', POST:'m-POST', PUT:'m-PUT', DELETE:'m-DELETE', PATCH:'m-PATCH' };

// ── Add a row to the traffic log ───────────────────────────────────────────
function addRow(entry) {
  const log = document.getElementById('log');
  const empty = log.querySelector('.empty-state');
  if (empty) empty.remove();

  totalReqs++;
  if (entry.status >= 400) totalErrs++;
  updateStats();

  const t = new Date(entry.ts || Date.now()).toLocaleTimeString('en', { hour12: false });
  const lat = entry.latency != null ? entry.latency + 'ms' : '—';
  const row = document.createElement('div');
  row.className = 'log-row flash';
  row.title = entry.path;
  row.innerHTML =
    '<span class="ts">'+t+'</span>' +
    '<span class="method '+(METHOD_COLORS[entry.method]||'m-OTHER')+'">'+entry.method+'</span>' +
    '<span class="path-cell">'+escHtml(entry.path)+'</span>' +
    '<span class="status '+statusClass(entry.status)+'">'+entry.status+'</span>' +
    '<span class="lat">'+lat+'</span>';

  log.insertBefore(row, log.firstChild);
  setTimeout(() => row.classList.remove('flash'), 500);
  while (log.children.length > 200) log.removeChild(log.lastChild);

  // Update route map
  const key = entry.method + ':' + (entry.normalizedPath || entry.path);
  if (!routeMap[key]) routeMap[key] = { method: entry.method, path: entry.normalizedPath || entry.path, count: 0, errors: 0 };
  routeMap[key].count++;
  if (entry.status >= 400) routeMap[key].errors++;
  renderRoutes();
}

function updateStats() {
  document.getElementById('stat-reqs').textContent = totalReqs;
  document.getElementById('stat-errs').textContent = totalErrs;
  const rate = totalReqs ? Math.round((totalErrs/totalReqs)*100) : 0;
  document.getElementById('stat-rate').textContent = rate+'%';
  document.getElementById('req-count').textContent = totalReqs + ' request' + (totalReqs!==1?'s':'');
}

function renderRoutes() {
  const el = document.getElementById('routes');
  const items = Object.values(routeMap).sort((a,b) => b.count - a.count).slice(0, 40);
  if (!items.length) { el.innerHTML = '<div class="empty-state">No routes yet</div>'; return; }
  const mc = METHOD_COLORS;
  el.innerHTML = items.map(r => {
    const ep = r.count ? Math.round((r.errors/r.count)*100) : 0;
    const errCls = ep > 50 ? 'hi' : ep > 10 ? 'md' : 'lo';
    return '<div class="route-item">' +
      '<span class="rmethod '+(mc[r.method]||'m-OTHER')+'">'+r.method+'</span>' +
      '<span class="rpath" title="'+escHtml(r.path)+'">'+escHtml(r.path)+'</span>' +
      '<span class="rcnt">×'+r.count+'</span>' +
      (ep > 0 ? '<span class="rerr '+errCls+'">'+ep+'%</span>' : '') +
      '</div>';
  }).join('');
}

function setOnline(online) {
  const badge = document.getElementById('status-badge');
  const banner = document.getElementById('offline-banner');
  if (online) {
    badge.textContent = 'ONLINE';
    badge.className = 'badge badge-online';
    banner.classList.remove('show');
  } else if (online === false) {
    badge.textContent = 'OFFLINE';
    badge.className = 'badge badge-offline';
    banner.classList.add('show');
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Load initial state ─────────────────────────────────────────────────────
fetch('/_beam/api/stats').then(r => r.json()).then(s => {
  setOnline(s.isOnline);
  if (s.appMeta && s.appMeta.framework) {
    const fw = document.getElementById('fw-badge');
    fw.textContent = s.appMeta.framework;
    fw.style.display = '';
  }
  if (s.recentTraffic) [...s.recentTraffic].reverse().forEach(addRow);
  if (s.routes) s.routes.forEach(r => {
    const key = r.method+':'+r.path;
    routeMap[key] = { method: r.method, path: r.path, count: r.count, errors: r.errors };
  });
  renderRoutes();
}).catch(() => {});

// ── SSE stream ─────────────────────────────────────────────────────────────
const es = new EventSource('/_beam/stream');
es.onmessage = (e) => {
  const { event, data } = JSON.parse(e.data);
  if (event === 'request') addRow(data);
  else if (event === 'online')  setOnline(true);
  else if (event === 'offline') setOnline(false);
  else if (event === 'state')   setOnline(data.isOnline);
  else if (event === 'app' && data.framework) {
    const fw = document.getElementById('fw-badge');
    fw.textContent = data.framework;
    fw.style.display = '';
  }
};
es.onerror = () => setOnline(false);
</script>
</body>
</html>`;
}

module.exports = { renderInspector };
