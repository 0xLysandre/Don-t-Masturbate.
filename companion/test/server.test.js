'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { useTempHome } = require('./helpers');

const HOME = useTempHome();

const { App } = require('../lib/app');
const { Store } = require('../lib/store');
const { createServer } = require('../lib/server');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function listen(app) {
  const server = createServer({ app, log: () => {} });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        async call(pathname, { body, origin = EXTENSION_ORIGIN, method } = {}) {
          const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: {
              ...(origin ? { Origin: origin } : {}),
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data, headers: res.headers };
        },
      });
    });
  });
}

test('the API drives a full session lifecycle', async (t) => {
  const app = new App(new Store(path.join(HOME, 'server-a.enc.json')));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const setup = await call('/setup', { body: { cooldownHours: 0 } });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.passwordExists, true);
  assert.equal(setup.data.password, undefined);

  await call('/config', { body: { blocklist: ['blocked.example'], keywords: ['badword'] } });
  const config = await call('/config');
  assert.deepEqual(config.data.blocklist, ['blocked.example']);
  assert.deepEqual(config.data.keywords, ['badword']);
  assert.equal(config.data.active, false);

  const started = await call('/session/start', { body: { durationHours: 24 } });
  assert.equal(started.status, 200);
  assert.equal((await call('/config')).data.active, true);

  // Locked: no edits without the password.
  const refused = await call('/config', { body: { keywords: [] } });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, 'password_required');

  // Unlock is time-locked, never immediate.
  const requested = await call('/unlock/request', { body: {} });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.request.password, undefined);

  const revealed = await call('/unlock/reveal', { body: {} });
  assert.equal(revealed.status, 200); // cooldown was configured as 0 hours
  const password = revealed.data.password;
  assert.ok(password && password.length >= 20);

  const stopped = await call('/session/stop', { body: { password } });
  assert.equal(stopped.status, 200);
  assert.equal((await call('/config')).data.active, false);

  const history = await call('/unlock/history');
  assert.equal(history.data.requests.length, 1);
  assert.ok(history.data.requests[0].revealedAt);
});

test('a non-zero cooldown blocks the reveal', async (t) => {
  const app = new App(new Store(path.join(HOME, 'server-b.enc.json')));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  await call('/setup', { body: { cooldownHours: 8 } });
  await call('/session/start', { body: { durationHours: 24 } });
  await call('/unlock/request', { body: {} });

  const reveal = await call('/unlock/reveal', { body: {} });
  assert.equal(reveal.status, 423);
  assert.equal(reveal.data.code, 'cooldown_active');
  assert.equal(reveal.data.password, undefined);

  const status = await call('/unlock/status');
  assert.equal(status.data.request.revealable, false);
  assert.ok(status.data.request.availableInMs > 7 * 3600000);
});

test('check-ins are recorded and streaks reported', async (t) => {
  const app = new App(new Store(path.join(HOME, 'server-c.enc.json')));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  await call('/setup', { body: {} });
  const first = await call('/checkin', { body: { onTrack: true } });
  assert.equal(first.data.currentStreak, 1);
  assert.equal(first.data.checkedInToday, true);

  const bad = await call('/checkin', { body: { onTrack: 'maybe' } });
  assert.equal(bad.status, 400);
});

test('only extension and dashboard origins are served', async (t) => {
  const app = new App(new Store(path.join(HOME, 'server-d.enc.json')));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const fromWebPage = await call('/config', { origin: 'https://evil.example' });
  assert.equal(fromWebPage.status, 403);
  assert.equal(fromWebPage.data.code, 'bad_origin');

  const fromExtension = await call('/config', { origin: EXTENSION_ORIGIN });
  assert.equal(fromExtension.status, 200);
  assert.equal(fromExtension.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);

  const fromCli = await call('/config', { origin: null });
  assert.equal(fromCli.status, 200);
});

test('unknown routes 404 rather than falling through', async (t) => {
  const app = new App(new Store(path.join(HOME, 'server-e.enc.json')));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const missing = await call('/does-not-exist');
  assert.equal(missing.status, 404);
});

test('the running server sees a change written by the CLI', async (t) => {
  const file = path.join(HOME, 'server-f.enc.json');
  const app = new App(new Store(file));
  const { server, call } = await listen(app);
  t.after(() => server.close());

  await call('/setup', { body: { cooldownHours: 12 } });
  await call('/config', { body: { keywords: ['from the api'] } });

  // A separate process — the CLI — edits the same file underneath it.
  new App(new Store(file)).updateConfig({ keywords: ['from the cli'] });

  const config = await call('/config');
  assert.deepEqual(config.data.keywords, ['from the cli']);
});
