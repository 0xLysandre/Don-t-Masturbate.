'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { App } = require('./app');
const { PORT } = require('./paths');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Origin policy. The companion listens on loopback only, but any web page in
 * the browser can still *send* a request to 127.0.0.1. Restricting CORS to
 * extension origins and the dashboard's own origin means such a page can never
 * read the blocklist or the check-in history, and cross-origin mutations are
 * rejected outright rather than merely hidden from the caller.
 */
function originAllowed(origin) {
  if (!origin) return true; // CLI / curl / top-level navigation to the dashboard
  if (origin.startsWith('chrome-extension://')) return true;
  return (
    origin === `http://127.0.0.1:${PORT}` ||
    origin === `http://localhost:${PORT}`
  );
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Body must be JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createServer({ app = new App(), log = console.log } = {}) {
  const routes = {
    'GET /health': () => ({ ok: true, service: 'accountability-companion' }),
    'GET /status': () => app.status(),
    'GET /config': () => app.getConfig(),
    'POST /config': (body) => app.updateConfig(body),
    'POST /setup': (body) => app.setup(body),
    'POST /session/start': (body) => app.startSession(body),
    'POST /session/stop': (body) => app.stopSession(body),
    'POST /unlock/request': (body) => app.requestUnlock(body),
    'POST /unlock/cancel': () => app.cancelUnlock(),
    'GET /unlock/status': () => app.unlockStatus(),
    'POST /unlock/reveal': () => app.revealPassword(),
    'GET /unlock/history': () => ({ requests: app.unlockHistory() }),
    'GET /checkin': () => app.checkInSummary(),
    'POST /checkin': (body) => app.checkIn(body),
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, payload) => {
      const bodyText = JSON.stringify(payload);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(origin && originAllowed(origin)
          ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
          : {}),
      });
      res.end(bodyText);
    };

    if (!isLoopback(req)) {
      send(403, { error: 'Loopback connections only.', code: 'not_loopback' });
      return;
    }

    if (req.method === 'OPTIONS') {
      if (!originAllowed(origin)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      res.end();
      return;
    }

    if (!originAllowed(origin)) {
      send(403, { error: `Origin ${origin} is not permitted.`, code: 'bad_origin' });
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      serveDashboard(res);
      return;
    }

    const handler = routes[route];
    if (!handler) {
      send(404, { error: `No route for ${route}.`, code: 'not_found' });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(200, handler(body));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log(`[companion] ${route} failed:`, err);
      send(status, { error: err.message, code: err.code || 'error' });
    }
  });

  return server;
}

function serveDashboard(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Dashboard missing.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The dashboard is fully self-contained; nothing may be loaded remotely.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(data);
  });
}

function start({ port = PORT, app, log = console.log } = {}) {
  const server = createServer({ app, log });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind to loopback explicitly: never reachable from the local network.
    server.listen(port, '127.0.0.1', () => {
      log(`Accountability companion listening on http://127.0.0.1:${port}`);
      log('Dashboard / daily check-in: open that URL in your browser.');
      resolve(server);
    });
  });
}

module.exports = { createServer, start, originAllowed };
