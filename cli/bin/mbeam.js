#!/usr/bin/env node
'use strict';

const http = require('http');
const WebSocket = require('ws');

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  process.stdout.write(`
  mbeam – Magun Beam  (instant HTTPS tunnels + live inspector)

  Usage:
    mbeam <port>                       Expose localhost:<port>
    mbeam <port> --subdomain <name>    Request a custom subdomain
    mbeam <port> --webhook <url>       POST events to a webhook (repeatable)
    mbeam <port> --json                Machine-readable JSON output (for agents)
    mbeam <port> --server <url>        Custom tunnel server WebSocket URL

  Examples:
    mbeam 3000
    mbeam 8080 --subdomain myapp
    mbeam 5173 --webhook https://hooks.example.com/beam
    mbeam 3000 --json | jq .

  Environment:
    MBEAM_SERVER    Tunnel server WebSocket URL
    MBEAM_SUBDOMAIN Custom subdomain

  Events emitted to webhooks / JSON stream:
    registered   Tunnel is up  { url, inspector, subdomain }
    request      Traffic log   { method, path, status, latency }
    online        Local server came back online
    offline       Local server went offline
`);
  process.exit(0);
}

const portArg = args.find(a => /^\d+$/.test(a));
if (!portArg) {
  process.stderr.write('Error: please provide a port number.\n  Usage: mbeam <port>\n');
  process.exit(1);
}

const LOCAL_PORT = parseInt(portArg, 10);

// --subdomain
const subdomainIdx = args.indexOf('--subdomain');
const SUBDOMAIN = subdomainIdx !== -1
  ? args[subdomainIdx + 1]
  : process.env.MBEAM_SUBDOMAIN;

// --webhook (can appear multiple times)
const WEBHOOKS = [];
args.forEach((a, i) => { if (a === '--webhook' && args[i + 1]) WEBHOOKS.push(args[i + 1]); });

// --json
const JSON_MODE = args.includes('--json');

// --server
const serverIdx = args.indexOf('--server');
const SERVER_URL =
  (serverIdx !== -1 ? args[serverIdx + 1] : undefined) ||
  process.env.MBEAM_SERVER ||
  'wss://tunnel.magun.cloud/tunnel';

// ── Output helpers ────────────────────────────────────────────────────────────
function emit(obj) {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
  }
}

function statusColor(code) {
  if (code < 300) return `\x1b[32m${code}\x1b[0m`;
  if (code < 400) return `\x1b[36m${code}\x1b[0m`;
  if (code < 500) return `\x1b[33m${code}\x1b[0m`;
  return `\x1b[31m${code}\x1b[0m`;
}

function logReq(method, path, status, latency) {
  if (JSON_MODE) return;
  const t   = new Date().toLocaleTimeString('en', { hour12: false });
  const lat = latency != null ? `  ${latency}ms` : '';
  process.stdout.write(`  ${t}  ${method.padEnd(7)} ${statusColor(status)}  ${path}${lat}\n`);
}

// ── Local server online / offline tracking ────────────────────────────────────
let localOnline = null; // null = unknown

function setLocalOnline(online) {
  if (online === localOnline) return;
  localOnline = online;
  if (!JSON_MODE) {
    if (online) process.stdout.write('\x1b[32m[mbeam] Local server is back online\x1b[0m\n');
    else        process.stdout.write('\x1b[33m[mbeam] Local server appears offline — using cached fallback if available\x1b[0m\n');
  }
  emit({ type: online ? 'online' : 'offline' });
}

// ── Connect ───────────────────────────────────────────────────────────────────
let reconnectDelay = 1000;
let active = true;

function connect() {
  const ws = new WebSocket(SERVER_URL, { handshakeTimeout: 10_000 });

  ws.on('open', () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({
      type: 'register',
      port: LOCAL_PORT,
      ...(SUBDOMAIN   ? { subdomain: SUBDOMAIN }  : {}),
      ...(WEBHOOKS.length ? { webhooks: WEBHOOKS } : {}),
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'registered') {
      if (!JSON_MODE) printBanner(msg.url, msg.inspector, LOCAL_PORT);
      emit({ type: 'registered', url: msg.url, inspector: msg.inspector, subdomain: msg.subdomain, port: LOCAL_PORT });
      return;
    }

    if (msg.type === 'request') {
      forwardToLocal(ws, msg);
    }
  });

  ws.on('error', err => {
    if (!JSON_MODE) process.stderr.write(`\n[mbeam] Connection error: ${err.message}\n`);
    emit({ type: 'error', message: err.message });
  });

  ws.on('close', code => {
    if (!active) return;
    if (!JSON_MODE) process.stderr.write(`\n[mbeam] Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s…\n`);
    emit({ type: 'disconnected', code });
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
}

// ── Forward a request to the local server ────────────────────────────────────
function forwardToLocal(ws, msg) {
  const reqHeaders = { ...msg.headers, host: `localhost:${LOCAL_PORT}` };
  ['connection', 'transfer-encoding', 'keep-alive', 'upgrade'].forEach(h => delete reqHeaders[h]);
  const started = Date.now();

  const req = http.request({
    hostname: '127.0.0.1',
    port: LOCAL_PORT,
    path: msg.path || '/',
    method: msg.method || 'GET',
    headers: reqHeaders,
  }, (localRes) => {
    const chunks = [];
    localRes.on('data', c => chunks.push(c));
    localRes.on('end', () => {
      const body    = Buffer.concat(chunks).toString('base64');
      const latency = Date.now() - started;
      send(ws, msg.id, localRes.statusCode, localRes.headers, body, false);
      setLocalOnline(true);
      logReq(msg.method, msg.path, localRes.statusCode, latency);
      emit({ type: 'request', method: msg.method, path: msg.path, status: localRes.statusCode, latency });
    });
  });

  req.setTimeout(25_000, () => {
    req.destroy();
    send(ws, msg.id, 504, { 'content-type': 'text/plain' },
      Buffer.from('Local server timed out').toString('base64'), false);
  });

  req.on('error', err => {
    const latency = Date.now() - started;
    const body = Buffer.from(`Cannot reach localhost:${LOCAL_PORT} — ${err.message}`).toString('base64');
    // localError: true tells the server to attempt a cache fallback
    send(ws, msg.id, 502, { 'content-type': 'text/plain' }, body, true);
    setLocalOnline(false);
    logReq(msg.method, msg.path, 502, latency);
    emit({ type: 'request', method: msg.method, path: msg.path, status: 502, latency, localError: true });
  });

  if (msg.body) req.write(Buffer.from(msg.body, 'base64'));
  req.end();
}

function send(ws, id, status, headers, body, localError) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'response', id, status, headers, body, localError }));
}

// ── Banner ────────────────────────────────────────────────────────────────────
function printBanner(url, inspector, port) {
  const L = '─'.repeat(52);
  process.stdout.write(`
  ${L}
   ✦ Magun Beam — tunnel active
  ${L}
   Local      →  http://localhost:${port}
   Public     →  ${url}
   Inspector  →  ${inspector}
  ${L}
   Ctrl+C to stop
\n`);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  active = false;
  if (!JSON_MODE) process.stdout.write('\n[mbeam] Closing tunnel…\n');
  emit({ type: 'shutdown' });
  process.exit(0);
});

// ── Go ────────────────────────────────────────────────────────────────────────
if (!JSON_MODE) process.stderr.write(`[mbeam] Connecting to ${SERVER_URL}…\n`);
emit({ type: 'connecting', server: SERVER_URL });
connect();
