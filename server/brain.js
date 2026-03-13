'use strict';

// ── TunnelBrain ───────────────────────────────────────────────────────────────
// The cognitive layer of every tunnel. It observes traffic, detects the app
// type, caches responses for fallback, streams live events to SSE subscribers,
// and fires webhooks when interesting things happen.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const http = require('http');

class TunnelBrain {
  constructor(subdomain, baseDomain) {
    this.subdomain = subdomain;
    this.baseDomain = baseDomain;
    this.createdAt = Date.now();

    this.traffic = [];          // ring buffer, newest first, max 200
    this.MAX_TRAFFIC = 200;

    this.routes = new Map();    // `METHOD:/normalized/path` → RouteStats
    this.cache = new Map();     // path → CachedResponse (for GET fallback)

    this.sseSubscribers = new Set();

    this.webhooks = [];
    this.appMeta = { type: null, framework: null };

    this.isOnline = null;       // null = not yet determined
    this.offlineSince = null;
    this.totalRequests = 0;
    this.totalErrors = 0;
  }

  // ── Record a completed request/response cycle ──────────────────────────────
  record({ id, method, path, status, latency, resHeaders, ts, localError, responseBodyB64 }) {
    this.totalRequests++;
    if (status >= 400) this.totalErrors++;

    const normalized = normalizePath(path);
    const entry = { id, method, path, normalizedPath: normalized, status, latency, ts, resHeaders: resHeaders || {} };
    this.traffic.unshift(entry);
    if (this.traffic.length > this.MAX_TRAFFIC) this.traffic.pop();

    // Route stats
    const key = `${method}:${normalized}`;
    if (!this.routes.has(key)) {
      this.routes.set(key, { method, path: normalized, count: 0, errors: 0, latencies: [], lastSeen: 0 });
    }
    const route = this.routes.get(key);
    route.count++;
    route.lastSeen = ts;
    if (status >= 400) route.errors++;
    if (latency != null) {
      route.latencies.push(latency);
      if (route.latencies.length > 50) route.latencies.shift();
    }

    // Cache successful GETs for offline fallback
    if (method === 'GET' && status >= 200 && status < 300 && responseBodyB64) {
      this.cache.set(path, { status, headers: resHeaders || {}, body: responseBodyB64, cachedAt: ts });
    }

    this._detectApp(resHeaders || {});
    this._emit('request', entry);

    if (status >= 500) this._fireWebhooks({ type: 'error', entry });

    // Track online state from local connectivity
    if (localError) {
      this.setOnline(false);
    } else if (this.isOnline !== true) {
      this.setOnline(true);
    }
  }

  // ── Fallback: return cached response for a path (offline self-heal) ────────
  getFallback(path) {
    return this.cache.get(path) || null;
  }

  // ── Online / offline transitions ───────────────────────────────────────────
  setOnline(online) {
    if (online === this.isOnline) return;
    this.isOnline = online;
    if (online) {
      this.offlineSince = null;
      this._emit('online', {});
      this._fireWebhooks({ type: 'online' });
    } else {
      this.offlineSince = Date.now();
      this._emit('offline', {});
      this._fireWebhooks({ type: 'offline' });
    }
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────
  addWebhook(url) { this.webhooks.push(url); }

  // ── SSE ────────────────────────────────────────────────────────────────────
  subscribe(res) {
    this.sseSubscribers.add(res);
    res.on('close', () => this.sseSubscribers.delete(res));
    // Send current state immediately on connect
    this._write(res, 'state', this.getSummary());
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  getSummary() {
    return {
      subdomain: this.subdomain,
      url: `https://${this.subdomain}.${this.baseDomain}`,
      inspector: `https://${this.subdomain}.${this.baseDomain}/_beam`,
      isOnline: this.isOnline,
      offlineSince: this.offlineSince,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      errorRate: this.totalRequests ? Math.round((this.totalErrors / this.totalRequests) * 100) : 0,
      appMeta: this.appMeta,
      cachedPaths: this.cache.size,
      uptime: Date.now() - this.createdAt,
    };
  }

  getStats() {
    const routes = [...this.routes.values()].map(r => ({
      method: r.method,
      path: r.path,
      count: r.count,
      errors: r.errors,
      errorRate: r.count ? Math.round((r.errors / r.count) * 100) : 0,
      avgLatency: r.latencies.length
        ? Math.round(r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length)
        : null,
      lastSeen: r.lastSeen,
    })).sort((a, b) => b.count - a.count);

    return { ...this.getSummary(), routes, recentTraffic: this.traffic.slice(0, 50) };
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  _detectApp(headers) {
    if (this.appMeta.framework) return;
    const powered = (headers['x-powered-by'] || '').toLowerCase();
    const server  = (headers['server'] || '').toLowerCase();

    let found = null;
    if (powered.includes('express'))                         found = { type: 'node',   framework: 'Express' };
    else if (powered.includes('next.js') || headers['x-nextjs-cache'] != null)
                                                             found = { type: 'node',   framework: 'Next.js' };
    else if (headers['x-remix-response'] != null)           found = { type: 'node',   framework: 'Remix' };
    else if (server.includes('vite'))                       found = { type: 'vite',   framework: 'Vite' };
    else if (powered.includes('fastapi') || server.includes('uvicorn'))
                                                             found = { type: 'python', framework: 'FastAPI' };
    else if (powered.includes('django'))                    found = { type: 'python', framework: 'Django' };
    else if (server.includes('werkzeug'))                   found = { type: 'python', framework: 'Flask' };
    else if (server.includes('gin-gonic'))                  found = { type: 'go',     framework: 'Gin' };
    else if (headers['x-aspnet-version'] != null)           found = { type: 'dotnet', framework: 'ASP.NET' };

    if (found) {
      this.appMeta = found;
      this._emit('app', found);
    }
  }

  _emit(event, data) {
    if (this.sseSubscribers.size === 0) return;
    for (const sub of this.sseSubscribers) {
      this._write(sub, event, data);
    }
  }

  _write(res, event, data) {
    try {
      res.write(`data: ${JSON.stringify({ event, data, ts: Date.now() })}\n\n`);
    } catch {
      this.sseSubscribers.delete(res);
    }
  }

  _fireWebhooks(payload) {
    if (!this.webhooks.length) return;
    const body = JSON.stringify({ ...payload, subdomain: this.subdomain, ts: Date.now() });
    for (const url of this.webhooks) {
      try {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'mbeam/0.1 (agentic-tunnel)',
          },
        });
        req.on('error', () => {});
        req.write(body);
        req.end();
      } catch {}
    }
  }
}

// ── Path normalizer ──────────────────────────────────────────────────────────
// /users/123/posts/456 → /users/:n/posts/:n
// /files/abc123def456  → /files/:id
function normalizePath(path) {
  return (path || '/').split('?')[0]
    .replace(/\/[0-9a-f-]{8,}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}

module.exports = { TunnelBrain, normalizePath };
