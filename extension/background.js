/**
 * Service worker: keeps the local companion app and Chrome's blocking engines
 * in sync.
 *
 *  - declarativeNetRequest dynamic rules  -> domain blocking
 *  - webNavigation.onBeforeNavigate       -> search-query backstop (catches a
 *                                            pasted URL, where no content
 *                                            script has run yet)
 *
 * The lists themselves are owned by the companion app; this worker only
 * mirrors them and caches the last known copy so a companion that stops
 * running cannot silently switch protection off.
 */
importScripts('shared/matcher.js');

const COMPANION_ORIGIN = 'http://127.0.0.1:7373';
const STATE_KEY = 'accState';
const SYNC_ALARM = 'companion-sync';
const FETCH_TIMEOUT_MS = 4000;

const EMPTY_STATE = {
  connected: false,
  lastSyncAt: null,
  lastError: null,
  protectionActive: false,
  endsAt: null,
  blocklist: [],
  keywords: [],
  setupComplete: false,
};

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...EMPTY_STATE, ...(stored[STATE_KEY] || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

function blockedUrl(params) {
  const query = new URLSearchParams(params).toString();
  return chrome.runtime.getURL(`blocked.html?${query}`);
}

// ---------------------------------------------------------------- companion

async function companionFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${COMPANION_ORIGIN}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Companion returned ${res.status}`);
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the lists. On failure the cached lists are deliberately left in place
 * and enforced — the user is told protection is unverified rather than being
 * quietly unblocked.
 */
async function sync() {
  try {
    const config = await companionFetch('/config');
    const state = await setState({
      connected: true,
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      setupComplete: Boolean(config.setupComplete),
      protectionActive: Boolean(config.active),
      endsAt: config.session ? config.session.endsAt : null,
      blocklist: config.blocklist || [],
      keywords: config.keywords || [],
    });
    await applyRules(state);
    await updateBadge(state);
    return state;
  } catch (err) {
    const state = await setState({
      connected: false,
      lastError: err.message || String(err),
    });
    await applyRules(state); // keep enforcing the cached lists
    await updateBadge(state);
    return state;
  }
}

// ------------------------------------------------------------------ blocking

async function applyRules(state) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  const addRules = state.protectionActive
    ? state.blocklist.map((domain, index) => ({
        id: index + 1,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: `/blocked.html?${new URLSearchParams({
              reason: 'domain',
              target: domain,
            })}`,
          },
        },
        condition: {
          // requestDomains covers the domain and every subdomain of it.
          requestDomains: [domain],
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      }))
    : [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    await setState({ lastError: `Could not install blocking rules: ${err.message}` });
  }
}

async function updateBadge(state) {
  let text = '';
  let color = '#5f6368';
  let title = 'Accountability Blocker';

  if (!state.connected) {
    text = '!';
    color = '#b3261e';
    title = state.protectionActive
      ? `PROTECTION INACTIVE — companion app is not running.\nEnforcing the lists cached at ${state.lastSyncAt || 'never'}.\nStart it with: npm run serve`
      : 'PROTECTION INACTIVE — companion app is not running. Start it with: npm run serve';
  } else if (state.protectionActive) {
    text = 'ON';
    color = '#1a7f4b';
    const ends = state.endsAt ? new Date(state.endsAt).toLocaleString() : 'unknown';
    title = `Protection active until ${ends}\n${state.blocklist.length} domain(s), ${state.keywords.length} term(s)`;
  } else {
    text = 'OFF';
    color = '#a15c07';
    title = state.setupComplete
      ? 'No session running — protection is off.'
      : 'Companion app is not set up yet.';
  }

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

/**
 * Backstop for search queries. Runs before the request is made, so a pasted
 * `?q=` URL never reaches the search engine even though no content script had
 * a chance to see it typed.
 */
async function inspectNavigation(details) {
  if (details.frameId !== 0) return;
  const state = await getState();
  if (!state.protectionActive || state.keywords.length === 0) return;
  const engine = AccMatcher.engineForUrl(details.url);
  if (!engine) return;
  if (!AccMatcher.matchUrl(details.url, state.keywords)) return;
  // The matched term is deliberately not echoed into the blocked page.
  try {
    await chrome.tabs.update(details.tabId, {
      url: blockedUrl({ reason: 'search', engine: engine.name, via: 'navigation' }),
    });
  } catch {
    /* tab closed mid-navigation */
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(inspectNavigation);
// YouTube (and Google's instant results) navigate via the History API, which
// never fires onBeforeNavigate.
chrome.webNavigation.onHistoryStateUpdated.addListener(inspectNavigation);

// ------------------------------------------------------------------- wiring

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
  sync();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
  sync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) sync();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'sync') {
    sync().then(sendResponse);
    return true;
  }
  if (message && message.type === 'getState') {
    getState().then(sendResponse);
    return true;
  }
  return false;
});

// Cold start of the worker for any reason.
sync();
