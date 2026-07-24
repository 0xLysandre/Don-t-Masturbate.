/**
 * Search-box listener for the supported engines.
 *
 * Scope note: this only ever reads the value of a search input on the handful
 * of search-engine pages listed in the manifest. It does not observe any other
 * field, any other page, or anything outside the browser.
 */
(function searchBoxGuard() {
  'use strict';

  const STATE_KEY = 'accState';
  const DEBOUNCE_MS = 250;
  const SEARCH_FIELD_NAMES = new Set(['q', 'as_q', 'search', 'search_query', 'query', 'p', 'text']);

  const engine = AccMatcher.engineForHost(location.hostname);
  if (!engine) return;

  let state = { protectionActive: false, keywords: [] };
  let blocked = false;
  let debounceTimer = null;

  chrome.storage.local.get(STATE_KEY, (stored) => {
    if (stored && stored[STATE_KEY]) state = stored[STATE_KEY];
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) state = changes[STATE_KEY].newValue || state;
  });

  const armed = () => state.protectionActive && (state.keywords || []).length > 0 && !blocked;

  function isSearchField(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'search', 'url', ''].includes(type)) return false;
    } else if (tag !== 'TEXTAREA' && !el.isContentEditable) {
      return false;
    }
    const name = (el.getAttribute('name') || '').toLowerCase();
    const id = (el.getAttribute('id') || '').toLowerCase();
    if (SEARCH_FIELD_NAMES.has(name) || SEARCH_FIELD_NAMES.has(id)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'searchbox' || role === 'combobox') return true;
    const hints = [
      id,
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('title') || '',
    ]
      .join(' ')
      .toLowerCase();
    return /search|query/.test(hints) || (el.getAttribute('type') || '') === 'search';
  }

  const fieldText = (el) => (el.isContentEditable ? el.textContent : el.value) || '';

  function clearField(el) {
    try {
      if (el.isContentEditable) el.textContent = '';
      else el.value = '';
    } catch {
      /* some engines use read-only proxies; the redirect below still applies */
    }
  }

  /** Wipe the field and leave for the local blocked page. */
  function block(field, via) {
    if (blocked) return;
    blocked = true;
    if (field) clearField(field);
    // The matched term is not passed along — no point putting it back in front
    // of the person who asked not to see it.
    const url = chrome.runtime.getURL(
      `blocked.html?${new URLSearchParams({ reason: 'search', engine: engine.name, via })}`,
    );
    location.replace(url);
  }

  function check(field, via) {
    if (!armed() || !field) return false;
    if (!AccMatcher.matchKeyword(fieldText(field), state.keywords)) return false;
    block(field, via);
    return true;
  }

  document.addEventListener(
    'input',
    (event) => {
      const field = event.target;
      if (!armed() || !isSearchField(field)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => check(field, 'typing'), DEBOUNCE_MS);
    },
    true,
  );

  // Enter is checked synchronously — a debounce would let the query through.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || !armed()) return;
      const field = event.target;
      if (!isSearchField(field)) return;
      if (!AccMatcher.matchKeyword(fieldText(field), state.keywords)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      block(field, 'enter');
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      if (!armed()) return;
      const form = event.target;
      if (!form || typeof form.querySelectorAll !== 'function') return;
      for (const field of form.querySelectorAll('input, textarea, [contenteditable="true"]')) {
        if (!isSearchField(field)) continue;
        if (!AccMatcher.matchKeyword(fieldText(field), state.keywords)) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        block(field, 'submit');
        return;
      }
    },
    true,
  );
})();
