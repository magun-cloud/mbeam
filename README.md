# mbeam — Magun Beam

**Instant HTTPS tunnels for your localhost. Built for AI agents.**

mbeam exposes any local port to a public HTTPS URL under your own domain — like ngrok, but self-hosted, open source, and designed from the ground up to work inside agentic workflows.

Every tunnel has a **brain**: it watches traffic, auto-detects your framework, caches responses for offline fallback, streams live events via SSE, and exposes a JSON API that other agents can subscribe to.

```
Local server (port 3000)  ←→  mbeam CLI  ←→  mbeam server  ←→  https://abc123.magun.cloud
                                                                   └── /_beam  (live inspector)
                                                                   └── /_beam/stream  (SSE)
                                                                   └── /_beam/api/stats  (JSON)
```

---

## Features

- **One command** — `mbeam 3000` gives you a live HTTPS URL in seconds
- **Your own domain** — subdomains on your domain, not someone else's
- **Agentic by design** — `--json` mode, `--webhook`, SSE event stream, JSON API
- **Live inspector** — real-time traffic log, route map, latency, error rates at `/_beam`
- **Framework detection** — automatically identifies Express, Next.js, FastAPI, Django, Flask, Gin, and more
- **Smart fallback** — serves cached responses when local server goes offline, zero config
- **Self-hosted** — runs on any Linux VPS, you own your data
- **Open source** — MIT license

---

## Table of Contents

- [How it works](#how-it-works)
- [VPS Setup (server)](#vps-setup-server)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Clone & install](#2-clone--install)
  - [3. DNS — wildcard subdomain](#3-dns--wildcard-subdomain)
  - [4. SSL — wildcard certificate](#4-ssl--wildcard-certificate)
  - [5. Nginx](#5-nginx)
  - [6. Run the server](#6-run-the-server)
- [Client (CLI) setup](#client-cli-setup)
- [CLI usage](#cli-usage)
- [Agentic features](#agentic-features)
  - [JSON mode](#json-mode)
  - [Webhooks](#webhooks)
  - [Live inspector](#live-inspector)
  - [Agent API](#agent-api)
  - [SSE event stream](#sse-event-stream)
  - [Cache fallback](#cache-fallback)
- [Environment variables](#environment-variables)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│  VPS (magun.cloud)                                              │
│                                                                 │
│  nginx (443) ──► mbeam server (3000)                           │
│                       │                                         │
│                       ├── WebSocket /tunnel  ◄── CLI client    │
│                       │        (persistent connection)          │
│                       │                                         │
│                       └── HTTP proxy  ◄── *.magun.cloud        │
│                                           incoming requests     │
└─────────────────────────────────────────────────────────────────┘

Flow:
  1. CLI connects to wss://tunnel.magun.cloud/tunnel
  2. Server assigns subdomain, e.g. a3f9c12b
  3. Public URL https://a3f9c12b.magun.cloud is live
  4. Incoming HTTP request → server → WebSocket → CLI → localhost:3000
  5. Response flows back the same way
  6. Brain records everything, inspector UI updates in real time
```

---

## VPS Setup (server)

### 1. Prerequisites

- A Linux VPS (Ubuntu 22.04 / Debian 12 recommended)
- A domain you control (e.g. `magun.cloud`)
- Root or sudo access
- Node.js 18+ installed

```bash
# Install Node.js 18 on Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager) and nginx
sudo npm install -g pm2
sudo apt install -y nginx certbot python3-certbot-dns-cloudflare
```

> **Tip:** If you use Cloudflare for DNS (recommended), the wildcard SSL setup below is much simpler. Any DNS provider that supports wildcard records will work.

---

### 2. Clone & install

```bash
git clone https://github.com/magun-cloud/mbeam.git
cd mbeam/server
npm install
```

---

### 3. DNS — wildcard subdomain

In your DNS provider, add **two records** pointing to your VPS IP:

| Type | Name            | Value         |
|------|-----------------|---------------|
| A    | `magun.cloud`   | `YOUR_VPS_IP` |
| A    | `*.magun.cloud` | `YOUR_VPS_IP` |

Wait a few minutes for DNS to propagate. Verify:

```bash
dig +short anything.magun.cloud
# Should return your VPS IP
```

---

### 4. SSL — wildcard certificate

You need a wildcard cert for `*.magun.cloud`. The easiest way is a DNS challenge via Certbot.

**With Cloudflare DNS:**

```bash
# Install the Cloudflare plugin
sudo apt install python3-certbot-dns-cloudflare

# Create Cloudflare API credentials file
sudo mkdir -p /etc/letsencrypt
sudo nano /etc/letsencrypt/cloudflare.ini
```

Add your Cloudflare API token (with `Zone:DNS:Edit` permission):

```ini
dns_cloudflare_api_token = YOUR_CLOUDFLARE_API_TOKEN
```

```bash
sudo chmod 600 /etc/letsencrypt/cloudflare.ini

# Request the wildcard cert
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "magun.cloud" \
  -d "*.magun.cloud" \
  --preferred-challenges dns-01
```

Your certs will be at:
- `/etc/letsencrypt/live/magun.cloud/fullchain.pem`
- `/etc/letsencrypt/live/magun.cloud/privkey.pem`

**With other DNS providers**, use the manual DNS challenge:

```bash
sudo certbot certonly \
  --manual \
  --preferred-challenges dns \
  -d "magun.cloud" \
  -d "*.magun.cloud"
```

Follow the prompts to add a `_acme-challenge` TXT record to your DNS.

---

### 5. Nginx

Copy the provided nginx config:

```bash
sudo cp nginx/magun-cloud.conf /etc/nginx/sites-available/magun-cloud
sudo ln -s /etc/nginx/sites-available/magun-cloud /etc/nginx/sites-enabled/
```

Edit the config if your domain or cert paths differ:

```bash
sudo nano /etc/nginx/sites-available/magun-cloud
```

The key parts are already configured:
- HTTP → HTTPS redirect
- `tunnel.magun.cloud` — WebSocket endpoint for CLI connections
- `*.magun.cloud` — wildcard proxy for tunnel traffic (passes full `Host` header to Node)

Test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

### 6. Run the server

**With PM2 (recommended for production):**

```bash
cd mbeam/server

# Start
pm2 start ecosystem.config.js

# Save so it starts on reboot
pm2 save
pm2 startup   # follow the printed command
```

**Manually (for testing):**

```bash
cd mbeam/server
PORT=3000 BASE_DOMAIN=magun.cloud node index.js
```

**Check it's running:**

```bash
curl https://magun.cloud
# → Magun Beam tunnel server
```

**PM2 useful commands:**

```bash
pm2 status              # check process status
pm2 logs mbeam-server   # live logs
pm2 restart mbeam-server
pm2 stop mbeam-server
```

---

## Client (CLI) setup

Install globally on any machine or VPS where you want to open tunnels:

```bash
npm install -g mbeam
```

Or run directly without installing:

```bash
npx mbeam 3000
```

Or clone the repo and link locally:

```bash
cd mbeam/cli
npm install
npm link   # makes `mbeam` available globally
```

---

## CLI usage

```
mbeam <port>                       Expose localhost:<port>
mbeam <port> --subdomain <name>    Request a custom subdomain
mbeam <port> --webhook <url>       POST events to a webhook (repeatable)
mbeam <port> --json                Machine-readable JSON output (for agents)
mbeam <port> --server <url>        Custom tunnel server URL
```

**Examples:**

```bash
# Expose a React dev server
mbeam 5173

# Expose with a memorable subdomain
mbeam 3000 --subdomain myapp

# Run in agent mode — outputs one JSON object per line
mbeam 3000 --json

# Multiple webhooks
mbeam 8080 --webhook https://hooks.slack.com/... --webhook https://myagent.example.com/events

# Point at your own server (if not using magun.cloud)
mbeam 3000 --server wss://tunnel.yourdomain.com/tunnel
```

**What you see when it starts:**

```
  ────────────────────────────────────────────────────
   ✦ Magun Beam — tunnel active
  ────────────────────────────────────────────────────
   Local      →  http://localhost:3000
   Public     →  https://a3f9c12b.magun.cloud
   Inspector  →  https://a3f9c12b.magun.cloud/_beam
  ────────────────────────────────────────────────────
   Ctrl+C to stop
```

---

## Agentic features

mbeam is built for the world where AI agents run on remote machines and need a way to expose their work for human review — or for other agents to observe.

### JSON mode

`--json` prints one JSON object per line to stdout. Every event is machine-parseable.

```bash
mbeam 3000 --json
```

```jsonl
{"type":"connecting","server":"wss://tunnel.magun.cloud/tunnel","ts":1710000000000}
{"type":"registered","url":"https://a3f9c12b.magun.cloud","inspector":"https://a3f9c12b.magun.cloud/_beam","subdomain":"a3f9c12b","port":3000,"ts":1710000000100}
{"type":"request","method":"GET","path":"/","status":200,"latency":23,"ts":1710000001000}
{"type":"offline","ts":1710000002000}
{"type":"online","ts":1710000005000}
```

An orchestrating agent can pipe this and act on events:

```bash
mbeam 3000 --json | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type')
  if [ "$type" = "registered" ]; then
    url=$(echo "$line" | jq -r '.url')
    echo "Tunnel ready at $url"
  fi
done
```

Or in Python:

```python
import subprocess, json

proc = subprocess.Popen(['mbeam', '3000', '--json'], stdout=subprocess.PIPE)
for line in proc.stdout:
    event = json.loads(line)
    if event['type'] == 'registered':
        print(f"Public URL: {event['url']}")
        print(f"Inspector:  {event['inspector']}")
```

---

### Webhooks

`--webhook <url>` fires a POST request to any URL when tunnel events occur.

```bash
mbeam 3000 --webhook https://your-agent.example.com/mbeam-events
```

Payload (JSON body):

```json
{
  "type": "error",
  "subdomain": "a3f9c12b",
  "ts": 1710000001000,
  "entry": {
    "method": "POST",
    "path": "/api/submit",
    "status": 500,
    "latency": 342
  }
}
```

Event types sent to webhooks: `error` (5xx), `offline`, `online`.

You can pass `--webhook` multiple times:

```bash
mbeam 3000 \
  --webhook https://hooks.slack.com/services/... \
  --webhook https://supervisor-agent.internal/events
```

---

### Live inspector

Every tunnel gets a real-time dashboard at `/_beam`:

```
https://a3f9c12b.magun.cloud/_beam
```

- Live traffic log (method, path, status, latency) via SSE
- Route map with per-route error rates and average latency
- Framework detection badge (Express / Next.js / FastAPI / etc)
- Online / offline indicator with cache fallback banner
- Agent API docs tab with ready-to-copy curl commands

No login required — the URL is the secret.

---

### Agent API

Any agent can observe a tunnel's state via HTTP:

```bash
# Full stats
curl https://a3f9c12b.magun.cloud/_beam/api/stats

# Recent 100 requests
curl https://a3f9c12b.magun.cloud/_beam/api/traffic

# Discovered route map
curl https://a3f9c12b.magun.cloud/_beam/api/routes
```

`/stats` response shape:

```json
{
  "subdomain": "a3f9c12b",
  "url": "https://a3f9c12b.magun.cloud",
  "inspector": "https://a3f9c12b.magun.cloud/_beam",
  "isOnline": true,
  "totalRequests": 142,
  "totalErrors": 3,
  "errorRate": 2,
  "appMeta": { "type": "node", "framework": "Express" },
  "cachedPaths": 5,
  "uptime": 3600000,
  "routes": [
    { "method": "GET",  "path": "/api/users", "count": 80, "errors": 0, "errorRate": 0, "avgLatency": 34 },
    { "method": "POST", "path": "/api/users", "count": 20, "errors": 1, "errorRate": 5, "avgLatency": 89 }
  ],
  "recentTraffic": [...]
}
```

---

### SSE event stream

Subscribe to live events from a tunnel — useful for a supervisor agent watching multiple tunnels:

```bash
curl -N https://a3f9c12b.magun.cloud/_beam/stream
```

```
data: {"event":"state","data":{...},"ts":1710000000000}

data: {"event":"request","data":{"method":"GET","path":"/","status":200,"latency":23},"ts":1710000001000}

data: {"event":"app","data":{"type":"node","framework":"Express"},"ts":1710000001500}

data: {"event":"offline","data":{},"ts":1710000005000}

data: {"event":"online","data":{},"ts":1710000008000}
```

Events:

| Event     | When                                              |
|-----------|---------------------------------------------------|
| `state`   | Immediately on connect — current snapshot         |
| `request` | Every completed request/response cycle            |
| `app`     | When framework is first detected                  |
| `online`  | Local server came back up after being offline     |
| `offline` | Local server stopped responding                   |

---

### Cache fallback

When the local server goes offline (connection refused), mbeam automatically serves the last cached `GET` response for that path instead of returning a 502.

The response includes:
```
x-mbeam-fallback: cached
x-mbeam-cached-at: 2024-03-13T12:00:00.000Z
```

This means a human reviewing an AI agent's work can still see the last rendered page even if the agent's dev server crashed. No manual intervention needed.

Cache is in-memory per tunnel session — it resets when the tunnel closes.

---

## Environment variables

**Server:**

| Variable      | Default       | Description                     |
|---------------|---------------|---------------------------------|
| `PORT`        | `3000`        | Port to listen on               |
| `BASE_DOMAIN` | `magun.cloud` | Root domain for tunnel URLs     |

**CLI:**

| Variable          | Description                                      |
|-------------------|--------------------------------------------------|
| `MBEAM_SERVER`    | WebSocket URL of the tunnel server               |
| `MBEAM_SUBDOMAIN` | Default subdomain to request                     |

---

## Architecture

```
mbeam/
├── server/
│   ├── index.js          # HTTP + WebSocket server, request routing
│   ├── brain.js          # TunnelBrain — observes traffic, SSE, webhooks, cache
│   ├── inspector.js      # /_beam inspector UI (single-file HTML)
│   ├── ecosystem.config.js  # PM2 config
│   └── package.json
├── cli/
│   ├── bin/mbeam.js      # CLI client
│   └── package.json
└── nginx/
    └── magun-cloud.conf  # Nginx config (wildcard SSL + proxy)
```

**Protocol — JSON over WebSocket:**

```
CLI → Server:   { type: "register", port: 3000, subdomain?: "myapp", webhooks?: [...] }
Server → CLI:   { type: "registered", subdomain: "a3f9c12b", url: "...", inspector: "..." }
Server → CLI:   { type: "request",  id: "uuid", method: "GET", path: "/", headers: {}, body: "base64" }
CLI → Server:   { type: "response", id: "uuid", status: 200, headers: {}, body: "base64", localError: false }
```

---

## Contributing

PRs welcome. Some ideas if you want to contribute:

- Auth tokens / secret-subdomain support
- WebSocket-through-tunnel (for HMR / hot reload)
- Request replay from inspector UI
- Traffic export as HAR file
- Configurable cache TTL
- Multi-region server support

---

## License

MIT — © [Magun](https://magun.cloud)
