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

test('the term scope defaults to site-wide search boxes and is validated', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  assert.equal(app.getConfig().keywordScope, 'search');

  assert.equal(app.updateConfig({ keywordScope: 'inputs' }).keywordScope, 'inputs');
  assert.equal(app.updateConfig({ keywordScope: 'ENGINES' }).keywordScope, 'engines');
  assert.equal(app.status().lists.keywordScope, 'engines');
  assert.throws(() => app.updateConfig({ keywordScope: 'everything' }), /must be one of/);
  // The rejected value did not stick.
  assert.equal(app.getConfig().keywordScope, 'engines');
});

test('the term scope is locked behind the password like the lists are', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0, keywordScope: 'inputs' });
  app.startSession({ durationHours: 24 });
  assert.throws(() => app.updateConfig({ keywordScope: 'engines' }), /password/i);
  assert.equal(app.getConfig().keywordScope, 'inputs');

  app.requestUnlock();
  const { password } = app.revealPassword();
  assert.equal(app.updateConfig({ keywordScope: 'engines', password }).keywordScope, 'engines');
});

test('a data file written before scopes existed still loads', () => {
  const file = newFile();
  const app = appAt(file);
  app.setup({ cooldownHours: 12 });
  delete app.state.keywordScope; // simulate an older state blob
  app.save();

  assert.equal(appAt(file).getConfig().keywordScope, 'search');
});

test('a store picks up a write made by another process', () => {
  // The server runs as a user service while the CLI writes to the same file;
  // without a reload the server would overwrite the CLI's change.
  const file = newFile();
  const server = appAt(file);
  server.setup({ cooldownHours: 12, keywords: ['first'] });

  const cli = appAt(file);
  cli.updateConfig({ keywords: ['second'] });

  assert.deepEqual(server.state.keywords, ['first'], 'stale copy still in memory');
  assert.equal(server.store.reloadIfChanged(), true);
  assert.deepEqual(server.state.keywords, ['second']);
  assert.equal(server.store.reloadIfChanged(), false, 'no reload when nothing changed');

  // And a save from the reloaded server does not resurrect the old list.
  server.checkIn({ onTrack: true });
  assert.deepEqual(appAt(file).state.keywords, ['second']);
});

test('a revealed unlock does not carry over into the next session', () => {
  // The reported bug: reveal, start a new session, then press "Reveal
  // password" again and get the freshly generated one with no cooldown.
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 24 });
  app.requestUnlock();

  // Reach the cooldown the honest way, then reveal.
  app.state.unlockRequests.at(-1).availableAt = new Date(Date.now() - 1000).toISOString();
  const first = app.revealPassword().password;
  app.stopSession({ password: first });

  // Straight into a new session, well inside the 10-minute copy window.
  app.startSession({ durationHours: 24 });

  assert.throws(() => app.revealPassword(), /no longer applies/i);
  const status = app.unlockStatus();
  assert.equal(status.request, null, 'the button must not be live');
  assert.equal(status.pending, false);

  // And the old password really is dead.
  assert.throws(() => app.stopSession({ password: first }), /Incorrect password/);

  // Getting out again costs a fresh request and a fresh cooldown.
  const reopened = app.requestUnlock();
  assert.equal(reopened.request.status, 'pending');
  assert.ok(reopened.request.availableInMs > 11 * 3600000);
  assert.throws(() => app.revealPassword(), /Cooldown still running/);
});

test('the same hole is closed for a reveal that spans a setup re-run', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 });
  app.startSession({ durationHours: 24 });
  app.requestUnlock();
  const first = app.revealPassword().password;
  app.stopSession({ password: first });

  app.setup({ cooldownHours: 0 }); // rotates too
  assert.throws(() => app.revealPassword(), /no longer applies/i);
});

test('rotation closes the request without destroying the note or the log', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 0 });
  app.startSession({ durationHours: 24 });
  app.requestUnlock({ note: 'felt rough tonight' });
  const password = app.revealPassword().password;
  app.stopSession({ password });
  app.startSession({ durationHours: 24 });

  const [entry] = app.unlockHistory();
  assert.equal(entry.note, 'felt rough tonight', 'the user note must survive');
  assert.equal(entry.status, 'revealed', 'the log still shows it was revealed');
  assert.ok(entry.revealedAt);
  assert.ok(entry.closedAt);
  assert.match(entry.closedReason, /rotated/i);
});

test('a cancelled request stays cancelled through a rotation', () => {
  const app = freshApp();
  app.setup({ cooldownHours: 12 });
  app.startSession({ durationHours: 24 });
  app.requestUnlock();
  app.cancelUnlock();
  const closedAt = app.state.unlockRequests.at(-1).closedAt;

  app.state.session.endsAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(app.sessionActive(), false);
  app.startSession({ durationHours: 24 });
  assert.equal(app.unlockHistory().at(-1).status, 'cancelled');
  assert.equal(app.unlockHistory().at(-1).closedAt, closedAt, 'not re-closed');
});
