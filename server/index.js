'use strict';

const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const { TunnelBrain, normalizePath } = require('./brain');
const { renderInspector } = require('./inspector');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'magun.cloud';
const TUNNEL_PATH = '/tunnel';
const REQ_TIMEOUT = 30_000;
const BASE_PARTS  = BASE_DOMAIN.split('.').length;

// ── State ─────────────────────────────────────────────────────────────────────
// subdomain → { ws, brain, pendingRequests: Map<id, PendingReq> }
const tunnels = new Map();

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function generateSubdomain() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

// ── HTTP request handler ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const host     = (req.headers.host || '').split(':')[0];
  const parts    = host.split('.');
  const subdomain = parts[0];

  // ── Health / root ──────────────────────────────────────────────────────────
  if (parts.length < BASE_PARTS + 1 || subdomain === 'tunnel') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Magun Beam tunnel server\n');
    return;
  }

  const tunnel = tunnels.get(subdomain);

  // ── Inspector & Agent API — served even when tunnel is active ──────────────
  // Accessible at https://{subdomain}.magun.cloud/_beam[/...]
  if (tunnel && req.url.startsWith('/_beam')) {
    return handleBeam(req, res, subdomain, tunnel.brain);
  }

  // ── No tunnel found ────────────────────────────────────────────────────────
  if (!tunnel) {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>No tunnel – Magun Beam</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#080808;color:#e5e5e5}
.box{text-align:center}.code{font-size:5rem;font-weight:700;color:#6366f1}.msg{color:#555;margin-top:.5rem}
code{background:#111;padding:.2rem .5rem;border-radius:4px;font-size:.85rem}</style></head>
<body><div class="box">
<div class="code">404</div>
<div class="msg">No active tunnel for <strong>${subdomain}.${BASE_DOMAIN}</strong></div>
<div class="msg" style="margin-top:1rem">Start one: <code>mbeam &lt;port&gt;</code></div>
</div></body></html>`);
    return;
  }

  // ── Proxy to tunnel ────────────────────────────────────────────────────────
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body      = Buffer.concat(chunks).toString('base64');
    const requestId = randomUUID();
    const ts        = Date.now();

    const timer = setTimeout(() => {
      tunnel.pendingRequests.delete(requestId);
      if (!res.headersSent) {
        tunnel.brain.record({
          id: requestId, method: req.method, path: req.url,
          status: 504, latency: Date.now() - ts, ts, localError: false,
        });
        res.writeHead(504, { 'content-type': 'text/plain' });
        res.end('Gateway Timeout\n');
      }
    }, REQ_TIMEOUT);

    tunnel.pendingRequests.set(requestId, { res, timer, method: req.method, path: req.url, ts });

    tunnel.ws.send(JSON.stringify({
      type: 'request', id: requestId,
      method: req.method, path: req.url,
      headers: req.headers, body,
    }));

    log(`→ [${subdomain}] ${req.method} ${req.url}`);
  });

  req.on('error', () => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
});

// ── Inspector & Agent API handler ─────────────────────────────────────────────
function handleBeam(req, res, subdomain, brain) {
  const url = req.url;

  // ── SSE stream — live events for any subscriber (human or agent) ──────────
  // GET /_beam/stream
  if (url === '/_beam/stream' || url === '/_beam/stream/') {
    res.writeHead(200, {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache',
      'connection':    'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.flushHeaders();
    brain.subscribe(res);
    // Keepalive ping every 20s
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 20_000);
    res.on('close', () => clearInterval(ping));
    return;
  }

  // ── Agent API — JSON endpoints ─────────────────────────────────────────────
  if (url.startsWith('/_beam/api')) {
    const path = url.replace('/_beam/api', '') || '/';
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');

    if (path === '/stats' || path === '/stats/') {
      res.writeHead(200);
      res.end(JSON.stringify(brain.getStats(), null, 2));
      return;
    }
    if (path === '/traffic' || path === '/traffic/') {
      res.writeHead(200);
      res.end(JSON.stringify(brain.traffic.slice(0, 100), null, 2));
      return;
    }
    if (path === '/routes' || path === '/routes/') {
      res.writeHead(200);
      res.end(JSON.stringify([...brain.routes.values()], null, 2));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown API endpoint' }));
    return;
  }

  // ── Inspector UI ──────────────────────────────────────────────────────────
  if (url === '/_beam' || url === '/_beam/') {
    const publicUrl = `https://${subdomain}.${BASE_DOMAIN}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderInspector(subdomain, publicUrl));
    return;
  }

  res.writeHead(302, { location: '/_beam' });
  res.end();
}

// ── WebSocket server (tunnel connections from CLI) ────────────────────────────
const wss = new WebSocket.Server({ server, path: TUNNEL_PATH });

wss.on('connection', (ws, req) => {
  let subdomain = null;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── REGISTER ──────────────────────────────────────────────────────────────
    if (msg.type === 'register') {
      const requested = typeof msg.subdomain === 'string'
        ? msg.subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32)
        : null;

      subdomain = (requested && !tunnels.has(requested)) ? requested : generateSubdomain();

      const brain = new TunnelBrain(subdomain, BASE_DOMAIN);

      // Register any webhooks the CLI declared
      if (Array.isArray(msg.webhooks)) {
        msg.webhooks.filter(u => typeof u === 'string').forEach(u => brain.addWebhook(u));
      }

      tunnels.set(subdomain, { ws, brain, pendingRequests: new Map() });

      const publicUrl  = `https://${subdomain}.${BASE_DOMAIN}`;
      const inspector  = `${publicUrl}/_beam`;
      ws.send(JSON.stringify({ type: 'registered', subdomain, url: publicUrl, inspector }));
      log(`OPEN  [${subdomain}] ip=${clientIp}`);
      return;
    }

    // ── RESPONSE (local server replied) ───────────────────────────────────────
    if (msg.type === 'response' && subdomain) {
      const tunnel = tunnels.get(subdomain);
      if (!tunnel) return;

      const pending = tunnel.pendingRequests.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      tunnel.pendingRequests.delete(msg.id);

      const { res, method, path, ts } = pending;
      const latency = Date.now() - ts;
      const localError = !!msg.localError;

      // ── Smart fallback: serve cache when local server is unreachable ────────
      if (localError) {
        const cached = tunnel.brain.getFallback(path);
        if (cached && !res.headersSent) {
          const fallbackHeaders = Object.fromEntries(
            Object.entries(cached.headers).filter(
              ([k]) => !['connection', 'transfer-encoding'].includes(k.toLowerCase())
            )
          );
          fallbackHeaders['x-mbeam-fallback'] = 'cached';
          fallbackHeaders['x-mbeam-cached-at'] = new Date(cached.cachedAt).toISOString();
          res.writeHead(cached.status, fallbackHeaders);
          res.end(Buffer.from(cached.body, 'base64'));
          tunnel.brain.record({ id: msg.id, method, path, status: cached.status, latency, ts, localError: true });
          log(`← [${subdomain}] ${cached.status} (fallback cache)`);
          return;
        }
      }

      // ── Regular response ───────────────────────────────────────────────────
      if (!res.headersSent) {
        const headers = Object.fromEntries(
          Object.entries(msg.headers || {}).filter(
            ([k]) => !['connection', 'transfer-encoding', 'keep-alive'].includes(k.toLowerCase())
          )
        );
        res.writeHead(msg.status || 200, headers);
        res.end(msg.body ? Buffer.from(msg.body, 'base64') : undefined);
      }

      // Feed the brain
      tunnel.brain.record({
        id: msg.id, method, path,
        normalizedPath: normalizePath(path),
        status: msg.status || 200,
        latency, ts,
        resHeaders: msg.headers || {},
        localError,
        responseBodyB64: (method === 'GET' && msg.status < 300) ? msg.body : undefined,
      });

      log(`← [${subdomain}] ${msg.status}${localError ? ' (local error)' : ''} ${latency}ms`);
    }
  });

  ws.on('close', () => {
    if (!subdomain) return;
    const tunnel = tunnels.get(subdomain);
    if (tunnel) {
      for (const [, { res, timer }] of tunnel.pendingRequests) {
        clearTimeout(timer);
        if (!res.headersSent) { res.writeHead(502); res.end('Tunnel disconnected.'); }
      }
      tunnel.brain.setOnline(false);
    }
    tunnels.delete(subdomain);
    log(`CLOSE [${subdomain}]`);
  });

  ws.on('error', err => log(`ERROR [${subdomain || '?'}] ${err.message}`));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`Magun Beam  port=${PORT}  domain=${BASE_DOMAIN}`);
});

process.on('SIGTERM', () => {
  log('shutting down...');
  server.close(() => process.exit(0));
});
