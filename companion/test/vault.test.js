'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { useTempHome } = require('./helpers');

const HOME = useTempHome();

const { App } = require('../lib/app');
const { Store } = require('../lib/store');

let counter = 0;
const newFile = () => path.join(HOME, `data-${(counter += 1)}.enc.json`);
const appAt = (file) => new App(new Store(file));
const freshApp = () => appAt(newFile());

test('setup creates a password without ever returning it', () => {
  const app = freshApp();
  const result = app.setup({ cooldownHours: 12 });
  assert.equal(result.passwordExists, true);
  assert.equal(result.password, undefined);
  assert.equal(app.status().passwordExists, true);
});

test('the plaintext password appears in no serialised state or status payload', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 });
  app.startSession({ durationHours: 24 });
  app.requestUnlock();
  const { password } = app.revealPassword();

  assert.ok(password.length >= 20);
  assert.ok(!JSON.stringify(app.state).includes(password), 'password leaked into stored state');
  assert.ok(!JSON.stringify(app.status()).includes(password), 'password leaked into /status');
  assert.ok(!JSON.stringify(app.getConfig()).includes(password), 'password leaked into /config');
  assert.ok(!JSON.stringify(app.unlockHistory()).includes(password), 'password leaked into history');
  assert.equal(app.state.vault.secret.alg, 'aes-256-gcm');
});

test('list edits are refused while a session is active without the password', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 24 });
  assert.throws(() => app.updateConfig({ keywords: [] }), /password/i);
  assert.throws(() => app.stopSession({}), /password/i);
  assert.throws(() => app.updateConfig({ keywords: [], password: 'wrong' }), /Incorrect password/);
});

test('requesting an unlock does not reveal the password and starts a visible cooldown', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 48 });

  const status = app.requestUnlock({ note: 'testing' });
  assert.equal(status.request.status, 'pending');
  assert.equal(status.request.revealable, false);
  assert.ok(status.request.availableInMs > 11 * 3600000);
  assert.throws(() => app.revealPassword(), /Cooldown still running/);

  const history = app.unlockHistory();
  assert.equal(history.length, 1);
  assert.ok(history[0].requestedAt);
  assert.ok(history[0].availableAt);
  assert.equal(history[0].note, 'testing');
  assert.equal(history[0].revealedAt, null);
});

test('the password is released once the cooldown has elapsed, and unlocks the session', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 }); // zero-hour cooldown keeps the test fast
  app.startSession({ durationHours: 48 });
  app.requestUnlock();

  const revealed = app.revealPassword();
  assert.equal(typeof revealed.password, 'string');
  assert.equal(app.unlockStatus().request.status, 'revealed');

  // The revealed password is the one that actually opens the lock.
  app.updateConfig({ keywords: ['ok'], password: revealed.password });
  assert.deepEqual(app.state.keywords, ['ok']);
  app.stopSession({ password: revealed.password });
  assert.equal(app.sessionActive(), false);
});

test('a revealed password is re-shown only inside the copy window', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 });
  app.startSession({ durationHours: 48 });
  app.requestUnlock();
  const first = app.revealPassword();
  assert.equal(app.revealPassword().password, first.password);

  // Age the reveal past the copy window.
  app.state.unlockRequests.at(-1).revealedAt = new Date(Date.now() - 60 * 60000).toISOString();
  assert.throws(() => app.revealPassword(), /already revealed/i);
});

test('starting a new session rotates the password and voids the old reveal', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 });
  app.startSession({ durationHours: 1 });
  app.requestUnlock();
  const old = app.revealPassword().password;
  app.stopSession({ password: old });

  app.startSession({ durationHours: 1 });
  assert.throws(() => app.updateConfig({ keywords: [], password: old }), /Incorrect password/);
});

test('a pending request is superseded when the password rotates', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 1 });
  app.requestUnlock();

  app.state.session.endsAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(app.sessionActive(), false);

  app.startSession({ durationHours: 1 });
  assert.equal(app.unlockHistory().at(-1).status, 'superseded');
});

test('an expired session stops being enforced', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 1 });
  app.state.session.endsAt = new Date(Date.now() - 1000).toISOString();

  assert.equal(app.sessionActive(), false);
  assert.equal(app.state.session.endedReason, 'expired');
  // With no active session, edits need no password at all.
  app.updateConfig({ keywords: ['free'] });
  assert.deepEqual(app.state.keywords, ['free']);
});

test('unlock cannot be requested when nothing is locked', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  assert.throws(() => app.requestUnlock(), /No active session/);
});

test('domains are normalised and de-duplicated', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  const config = app.updateConfig({
    blocklist: ['HTTPS://WWW.Example.com/some/path?x=1', 'example.com', 'other.net:8080'],
  });
  assert.deepEqual(config.blocklist, ['example.com', 'other.net']);
});

test('check-ins are upserted per day and drive the streak', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.checkIn({ onTrack: true, date: '2026-07-20' });
  app.checkIn({ onTrack: true, date: '2026-07-21' });
  const summary = app.checkIn({ onTrack: false, date: '2026-07-21' });
  assert.equal(summary.totalCheckIns, 2);
  assert.equal(app.state.checkins.find((c) => c.date === '2026-07-21').onTrack, false);
});

test('state survives a round trip through the encrypted file', () => {
  const file = newFile();
  const app = appAt(file);
  app.setup({ cooldownHours: 6, blocklist: ['persist.example'], keywords: ['persist me'] });
  app.checkIn({ onTrack: true });

  const reloaded = appAt(file);
  assert.deepEqual(reloaded.state.blocklist, ['persist.example']);
  assert.deepEqual(reloaded.state.keywords, ['persist me']);
  assert.equal(reloaded.state.cooldownHours, 6);
  assert.equal(reloaded.checkInSummary().currentStreak, 1);
});

test('the data file on disk is not readable as plaintext', () => {
  const fs = require('node:fs');
  const file = newFile();
  const app = appAt(file);
  app.setup({ cooldownHours: 6, blocklist: ['secret-domain.example'], keywords: ['secret term'] });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('secret-domain.example'));
  assert.ok(!raw.includes('secret term'));
  assert.equal(JSON.parse(raw).alg, 'aes-256-gcm');
});
