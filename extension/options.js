'use strict';

const COMPANION_ORIGIN = 'http://127.0.0.1:7373';
const $ = (id) => document.getElementById(id);

let latest = { status: null, config: null };
let keywordsRevealed = false;
let listsDirty = { blocklist: false, keywords: false, scope: false };

const scopeInputs = () => document.querySelectorAll('input[name="scope"]');
const selectedScope = () => {
  for (const input of scopeInputs()) if (input.checked) return input.value;
  return 'search';
};

async function api(path, body) {
  const res = await fetch(`${COMPANION_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function duration(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const asLines = (list) => (list || []).join('\n');
const fromLines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function setStatusLine(id, message, tone = 'muted') {
  const el = $(id);
  el.textContent = message;
  el.className = `status-line ${tone}`;
  if (message) setTimeout(() => (el.textContent === message ? (el.textContent = '') : null), 6000);
}

/** The extension is useless without the companion — say so loudly. */
function renderBanner(reachable, status, error) {
  const banner = $('banner');
  if (!reachable) {
    banner.className = 'banner bad';
    banner.textContent = `Protection inactive — the companion app is not reachable at ${COMPANION_ORIGIN}. Start it with "npm run serve" in the companion folder. ${error || ''}`;
    return;
  }
  if (!status.setupComplete) {
    banner.className = 'banner warn';
    banner.textContent = 'Companion app running, but setup has not been completed yet.';
    return;
  }
  if (!status.protection.active) {
    banner.className = 'banner warn';
    banner.textContent = 'Companion app running. No session is active, so nothing is being blocked.';
    return;
  }
  banner.className = 'banner ok';
  banner.textContent = `Protection active — ${duration(status.protection.remainingMs)} remaining.`;
}

function renderSession(status) {
  const pill = $('session-pill');
  const active = status.protection.active;
  pill.textContent = active ? 'locked' : status.setupComplete ? 'unlocked' : 'not set up';
  pill.className = `pill ${active ? 'ok' : 'warn'}`;

  $('setup-block').hidden = status.setupComplete;
  $('session-start-block').hidden = !status.setupComplete || active;
  $('session-stop-block').hidden = !active;
  $('locked-note').hidden = !active;

  if (active) {
    $('session-detail').textContent =
      `Started ${new Date(status.protection.startedAt).toLocaleString()}, ends ` +
      `${new Date(status.protection.endsAt).toLocaleString()} (${duration(status.protection.remainingMs)} left).`;
  } else if (status.setupComplete) {
    $('session-detail').textContent = status.protection.endedReason
      ? `No session running (last one ended: ${status.protection.endedReason}).`
      : 'No session running.';
  } else {
    $('session-detail').textContent = 'Run setup to generate the vault password and get started.';
  }
}

const SCOPE_LABEL = {
  engines: 'on the supported search engines',
  search: 'in any search box',
  inputs: 'in any text field',
};

function renderLists(config, active) {
  $('blocklist-count').textContent = `${config.blocklist.length} domain(s)`;
  $('keyword-count').textContent =
    `${config.keywords.length} term(s), blocked ${SCOPE_LABEL[config.keywordScope] || ''}`;
  if (!listsDirty.scope) {
    for (const input of scopeInputs()) input.checked = input.value === config.keywordScope;
  }
  if (!listsDirty.blocklist) $('blocklist').value = asLines(config.blocklist);

  const hideKeywords = active && !keywordsRevealed;
  $('keywords').hidden = hideKeywords;
  $('keywords-hidden').hidden = !hideKeywords;
  if (!hideKeywords && !listsDirty.keywords) $('keywords').value = asLines(config.keywords);
}

/** Never leave a password on screen once its request has closed. */
function hidePasswordUnless(revealable) {
  if (revealable) return;
  $('password-box').hidden = true;
  $('password-value').textContent = '';
  $('password-note').textContent = '';
}

function renderUnlock(unlock) {
  const req = unlock.request;
  const reveal = $('unlock-reveal');
  const cancel = $('unlock-cancel');
  const request = $('unlock-request');

  hidePasswordUnless(req && req.revealable);

  if (!req) {
    $('unlock-state').textContent = unlock.active
      ? `No unlock requested. A request starts a ${unlock.cooldownHours}h cooldown.`
      : 'Nothing is locked right now.';
    reveal.disabled = true;
    cancel.disabled = true;
    request.disabled = !unlock.active;
    return;
  }

  if (req.status === 'pending') {
    $('unlock-state').textContent =
      `Cooldown running — ${duration(req.availableInMs)} left (available ` +
      `${new Date(req.availableAt).toLocaleString()}).`;
  } else if (req.status === 'ready') {
    $('unlock-state').textContent = 'Cooldown elapsed. The password can be revealed.';
  } else if (req.status === 'revealed') {
    $('unlock-state').textContent =
      `Revealed at ${new Date(req.revealedAt).toLocaleString()}.` +
      (req.revealWindowRemainingMs > 0
        ? ` Viewable for another ${duration(req.revealWindowRemainingMs)}.`
        : ' The copy window has closed — request a new unlock if you need it again.');
  } else {
    $('unlock-state').textContent = `Request ${req.status}.`;
  }

  reveal.disabled = !req.revealable;
  cancel.disabled = !(req.status === 'pending' || req.status === 'ready');
  request.disabled = req.status === 'pending' || req.status === 'ready';
}

function renderHistory(rows) {
  const tbody = $('unlock-history');
  tbody.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'muted';
    td.textContent = 'No unlock requests yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows.slice().reverse()) {
    const tr = document.createElement('tr');
    for (const value of [
      new Date(row.requestedAt).toLocaleString(),
      new Date(row.availableAt).toLocaleString(),
      row.status,
      row.revealedAt ? new Date(row.revealedAt).toLocaleString() : '—',
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function renderCheckin(checkin) {
  $('streak-current').textContent = checkin.currentStreak;
  $('streak-longest').textContent = checkin.longestStreak;
  $('checkin-state').textContent = checkin.checkedInToday
    ? `Checked in for ${checkin.today}: ${checkin.todayOnTrack ? 'on track' : 'slipped'}.`
    : `No check-in yet for ${checkin.today}.`;
}

function setControlsEnabled(enabled) {
  for (const id of [
    'blocklist-save',
    'keywords-save',
    'session-start',
    'session-stop',
    'setup-run',
    'unlock-request',
    'unlock-reveal',
    'unlock-cancel',
    'checkin-yes',
    'checkin-no',
  ]) {
    $(id).disabled = !enabled;
  }
}

async function refresh() {
  try {
    const [status, config, history] = await Promise.all([
      api('/status'),
      api('/config'),
      api('/unlock/history'),
    ]);
    latest = { status, config };
    setControlsEnabled(true);
    renderBanner(true, status);
    renderSession(status);
    renderLists(config, status.protection.active);
    renderUnlock(status.unlock);
    renderHistory(history.requests);
    renderCheckin(status.checkin);
  } catch (err) {
    setControlsEnabled(false);
    renderBanner(false, null, err.message);
  }
}

/** Runs an action, surfaces the error inline, then re-syncs Chrome's rules. */
async function guard(statusId, fn) {
  try {
    const message = await fn();
    if (statusId) setStatusLine(statusId, message || 'Saved.', 'ok');
  } catch (err) {
    if (statusId) setStatusLine(statusId, err.message, 'bad');
    else alert(err.message);
  }
  chrome.runtime.sendMessage({ type: 'sync' }, () => void chrome.runtime.lastError);
  await refresh();
}

const editPassword = () => $('edit-password').value || undefined;

$('blocklist').addEventListener('input', () => (listsDirty.blocklist = true));
$('keywords').addEventListener('input', () => (listsDirty.keywords = true));
for (const input of document.querySelectorAll('input[name="scope"]')) {
  input.addEventListener('change', () => (listsDirty.scope = true));
}

$('blocklist-save').addEventListener('click', () =>
  guard('blocklist-status', async () => {
    const result = await api('/config', {
      blocklist: fromLines($('blocklist').value),
      password: editPassword(),
    });
    listsDirty.blocklist = false;
    return `Saved ${result.blocklist.length} domain(s).`;
  }),
);

$('keywords-save').addEventListener('click', () =>
  guard('keywords-status', async () => {
    // While the list is masked, only the reach can be changed — saving the
    // empty textarea over a hidden list would wipe it.
    const hidden = $('keywords').hidden;
    const result = await api('/config', {
      ...(hidden ? {} : { keywords: fromLines($('keywords').value) }),
      keywordScope: selectedScope(),
      password: editPassword(),
    });
    listsDirty.keywords = false;
    listsDirty.scope = false;
    return hidden
      ? `Terms now blocked ${SCOPE_LABEL[result.keywordScope]}. Show the list to edit the terms themselves.`
      : `Saved ${result.keywords.length} term(s), blocked ${SCOPE_LABEL[result.keywordScope]}.`;
  }),
);

$('keywords-reveal').addEventListener('click', () => {
  keywordsRevealed = true;
  if (latest.config) renderLists(latest.config, latest.status.protection.active);
});

$('setup-run').addEventListener('click', () =>
  guard(null, async () => {
    await api('/setup', { cooldownHours: Number($('setup-cooldown').value) });
    alert(
      'Setup complete. A random password now exists and has been encrypted — it is not shown to you.\n\n' +
        'If you ever need it, request an unlock and wait out the cooldown.',
    );
  }),
);

$('session-start').addEventListener('click', () =>
  guard(null, async () => {
    const hours = Number($('session-hours').value);
    if (!confirm(`Lock in for ${hours} hour(s)? A fresh password will be generated and sealed.`)) {
      return;
    }
    await api('/session/start', { durationHours: hours });
  }),
);

$('session-stop').addEventListener('click', () =>
  guard(null, async () => {
    await api('/session/stop', { password: $('session-password').value });
    $('session-password').value = '';
  }),
);

$('unlock-request').addEventListener('click', () =>
  guard(null, async () => {
    if (!confirm('Start the unlock cooldown? The request is logged with a timestamp.')) return;
    await api('/unlock/request', {});
  }),
);

$('unlock-cancel').addEventListener('click', () => guard(null, () => api('/unlock/cancel', {})));

$('unlock-reveal').addEventListener('click', () =>
  guard(null, async () => {
    const result = await api('/unlock/reveal', {});
    $('password-box').hidden = false;
    $('password-value').textContent = result.password;
    $('password-note').textContent = `Copy it within ${result.copyWindowMinutes} minutes — after that you would need a new request.`;
  }),
);

$('checkin-yes').addEventListener('click', () => guard(null, () => api('/checkin', { onTrack: true })));
$('checkin-no').addEventListener('click', () => guard(null, () => api('/checkin', { onTrack: false })));
$('open-dashboard').addEventListener('click', () => chrome.tabs.create({ url: COMPANION_ORIGIN }));

refresh();
setInterval(refresh, 15000);
