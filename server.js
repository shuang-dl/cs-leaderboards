'use strict';

// Minimal zero-dependency server for the CS leaderboard page.
// Serves index.html and implements the /proxy-standalone route the page calls,
// injecting the Intercom API key server-side (so it never ships to the browser
// or the repo) and forwarding only to the allowlisted API host.
//
// All leaderboard aggregation (pagination, grouping by teammate, CSAT math)
// happens client-side in index.html — this server only proxies.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const INTERCOM_API_KEY = process.env.INTERCOM_API_KEY;

// The page's proxy calls are only allowed to reach this host.
const ALLOWED_HOST = 'api.intercom.io';

const PROXY_ROUTE = '/proxy-standalone';

// Optional password gate. If BASIC_AUTH_PASSWORD is set, the whole site (page +
// proxy) requires HTTP Basic Auth. Leave it unset to keep the deploy open.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || 'admin';
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

function isAuthed(req) {
  if (!BASIC_AUTH_PASSWORD) return true; // gate disabled
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASSWORD;
}

function isAllowedTarget(targetUrl) {
  try {
    const u = new URL(targetUrl);
    return u.protocol === 'https:' && u.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

function proxyToApi(targetUrl, req, res, body) {
  const u = new URL(targetUrl);
  const headers = {};
  const skip = ['host', 'connection', 'content-length', 'origin', 'referer', 'authorization', 'accept-encoding'];
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skip.includes(key.toLowerCase())) headers[key] = value;
  }
  headers['Authorization'] = `Bearer ${INTERCOM_API_KEY}`;
  headers['accept-encoding'] = 'identity'; // no upstream compression -> simpler framing
  if (body.length > 0) headers['content-length'] = Buffer.byteLength(body);

  const proxyReq = https.request(
    { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: req.method, headers },
    (proxyRes) => {
      // Buffer the upstream response and re-emit it with a clean, minimal header
      // set. Forwarding upstream hop-by-hop headers (transfer-encoding,
      // connection) verbatim corrupts response framing behind a reverse-proxy
      // gateway (e.g. DeployBay's nginx) and triggers 502 Bad Gateway. This
      // never reproduces locally because there is no gateway in front.
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const payload = Buffer.concat(chunks);
        const safe = { 'Content-Length': payload.length };
        if (proxyRes.headers['content-type']) safe['Content-Type'] = proxyRes.headers['content-type'];
        res.writeHead(proxyRes.statusCode, safe);
        res.end(payload);
      });
    }
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy request failed', message: err.message }));
    }
  });
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('Upstream request timed out')));
  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  if (!isAuthed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restricted"' });
    res.end('Authentication required');
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (parsed.pathname === PROXY_ROUTE) {
    if (!INTERCOM_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERCOM_API_KEY environment variable is not set' }));
      return;
    }
    const targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter', usage: `${PROXY_ROUTE}?url=<encoded-url>` }));
      return;
    }
    if (!isAllowedTarget(targetUrl)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden target', message: `Only https://${ALLOWED_HOST} is allowed` }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => proxyToApi(targetUrl, req, res, Buffer.concat(chunks)));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`cs-leaderboard listening on 0.0.0.0:${PORT}`);
  if (!INTERCOM_API_KEY) console.warn('WARNING: INTERCOM_API_KEY is not set — proxy requests will fail.');
  if (BASIC_AUTH_PASSWORD) console.log('Password gate ENABLED (Basic Auth).');
});
