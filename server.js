'use strict';

// Minimal-dependency server for the CS leaderboard page (plain http/https, no
// Express — only npm dependency is `pg`).
//
// Three routes:
//   GET  /proxy-standalone?url=...   generic Intercom proxy for the browser's own
//                                    calls (admins/teams, for names + team filter)
//   GET  /sync-conversations         SSE stream: server fetches closed conversations
//                                    from Intercom and upserts them into Postgres,
//                                    emitting progress events as it goes (avoids
//                                    gateway timeouts on wide date ranges)
//   GET  /leaderboard-data           reads the leaderboard straight out of
//                                    Postgres (aggregated via SQL)
//   POST /clear-database             truncates all synced conversation data
//
// The API key never ships to the browser or the repo; the proxy route forwards
// only to the allowlisted Intercom host.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 8080;
const INTERCOM_API_KEY = process.env.INTERCOM_API_KEY;

// The page's proxy calls are only allowed to reach this host.
const ALLOWED_HOST = 'api.intercom.io';

const PROXY_ROUTE = '/proxy-standalone';
const SYNC_ROUTE = '/sync-conversations';
const LEADERBOARD_DATA_ROUTE = '/leaderboard-data';
const CLEAR_DATABASE_ROUTE = '/clear-database';

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateToUnix(str, endOfDay) {
  return Math.floor(new Date(`${str}T${endOfDay ? '23:59:59' : '00:00:00'}Z`).getTime() / 1000);
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function fetchClosedConversationsPage(startUnix, endUnix, startingAfter, attempt = 1) {
  const body = {
    query: {
      operator: 'AND',
      value: [
        { field: 'state', operator: '=', value: 'closed' },
        { field: 'statistics.last_close_at', operator: '>', value: startUnix },
        { field: 'statistics.last_close_at', operator: '<', value: endUnix },
      ],
    },
    pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
  };

  try {
    const res = await fetch('https://api.intercom.io/conversations/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INTERCOM_API_KEY}`,
        'Content-Type': 'application/json',
        'Intercom-Version': '2.11',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      throw new Error(`Intercom conversations/search failed: ${res.status} ${await res.text()}`);
    }

    const page = await res.json();
    return {
      conversations: page.conversations || [],
      nextStartingAfter: page.pages && page.pages.next ? page.pages.next.starting_after : null,
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || /timeout/i.test(err.message);
    if (isTimeout && attempt < 3) {
      return fetchClosedConversationsPage(startUnix, endUnix, startingAfter, attempt + 1);
    }
    throw err;
  }
}

// Time from first human/team assignment (leaving the bot inbox) to the first
// admin reply, rather than from conversation start — excludes bot/Fin triage time.
function computeFrtSeconds(stats) {
  if (stats.first_assignment_at == null || stats.first_admin_reply_at == null) return null;
  const delta = stats.first_admin_reply_at - stats.first_assignment_at;
  return delta >= 0 ? delta : null;
}

function toRow(convo) {
  const stats = convo.statistics;
  const closedByAdminId = stats && stats.last_closed_by_id;
  const lastCloseAtUnix = stats && stats.last_close_at;
  if (!closedByAdminId || !lastCloseAtUnix) return null;

  const rating = convo.conversation_rating;
  return {
    conversationId: String(convo.id),
    closedByAdminId: String(closedByAdminId),
    teamId: convo.team_assignee_id ? String(convo.team_assignee_id) : null,
    lastCloseAtUnix,
    csatRequested: Boolean(rating),
    csatReceived: Boolean(rating && rating.rating != null),
    csatRating: rating && rating.rating != null ? rating.rating : null,
    frtSeconds: computeFrtSeconds(stats),
    // TTC: time to the last close — paired with last_closed_by_id above, so it
    // matches who/what we're attributing to.
    ttcSeconds: stats.time_to_last_close != null ? stats.time_to_last_close : null,
  };
}

// Streams progress via SSE instead of one big blocking response: syncing a wide
// date range means many sequential Intercom pages + DB writes, which can easily
// exceed a gateway's idle/read timeout on a plain request-response call (this
// surfaced as a 504 in practice). A continuously-active streamed connection
// avoids that, and gives the user real progress instead of a silent wait.
function openSseStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleSync(req, res) {
  if (!INTERCOM_API_KEY) {
    return sendJSON(res, 500, { error: 'INTERCOM_API_KEY environment variable is not set' });
  }
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const start = parsed.searchParams.get('start');
  const end = parsed.searchParams.get('end');

  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
    return sendJSON(res, 400, { error: 'start and end are required as YYYY-MM-DD' });
  }

  const startUnix = dateToUnix(start, false);
  const endUnix = dateToUnix(end, true);
  if (startUnix >= endUnix) {
    return sendJSON(res, 400, { error: 'Invalid date range' });
  }

  const send = openSseStream(res);
  let fetched = 0;
  let synced = 0;
  let skipped = 0;

  try {
    let startingAfter = null;
    do {
      const page = await fetchClosedConversationsPage(startUnix, endUnix, startingAfter);
      const rows = page.conversations.map(toRow).filter(Boolean);
      skipped += page.conversations.length - rows.length;
      fetched += page.conversations.length;
      if (rows.length) synced += await db.upsertConversations(rows);
      startingAfter = page.nextStartingAfter;
      send('progress', { fetched, synced, skipped });
    } while (startingAfter);

    send('done', { start, end, fetched, synced, skipped });
  } catch (err) {
    console.error('Sync failed:', err);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
}

async function handleLeaderboardData(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const start = parsed.searchParams.get('start');
  const end = parsed.searchParams.get('end');
  const teamIds = (parsed.searchParams.get('team') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
    return sendJSON(res, 400, { error: 'start and end are required as YYYY-MM-DD' });
  }

  const startUnix = dateToUnix(start, false);
  const endUnix = dateToUnix(end, true);
  if (startUnix >= endUnix) {
    return sendJSON(res, 400, { error: 'Invalid date range' });
  }

  try {
    const agents = await db.queryLeaderboard({ startUnix, endUnix, teamIds });
    sendJSON(res, 200, { start, end, agents });
  } catch (err) {
    console.error('Leaderboard query failed:', err);
    sendJSON(res, 500, { error: 'Leaderboard query failed', message: err.message });
  }
}

async function handleClearDatabase(req, res) {
  try {
    await db.clearAll();
    console.log('Database cleared via /clear-database');
    sendJSON(res, 200, { cleared: true });
  } catch (err) {
    console.error('Clear database failed:', err);
    sendJSON(res, 500, { error: 'Clear database failed', message: err.message });
  }
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

  if (parsed.pathname === SYNC_ROUTE && req.method === 'GET') {
    handleSync(req, res);
    return;
  }

  if (parsed.pathname === LEADERBOARD_DATA_ROUTE && req.method === 'GET') {
    handleLeaderboardData(req, res);
    return;
  }

  if (parsed.pathname === CLEAR_DATABASE_ROUTE && req.method === 'POST') {
    handleClearDatabase(req, res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX_HTML);
});

db.ensureSchema()
  .catch((err) => console.error('Schema setup failed:', err.message))
  .finally(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`cs-leaderboard listening on 0.0.0.0:${PORT}`);
      if (!INTERCOM_API_KEY) console.warn('WARNING: INTERCOM_API_KEY is not set — proxy requests will fail.');
      if (!process.env.DATABASE_URL) console.warn('WARNING: DATABASE_URL is not set — sync/leaderboard-data will fail.');
      if (BASIC_AUTH_PASSWORD) console.log('Password gate ENABLED (Basic Auth).');
    });
  });
