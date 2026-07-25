/**
 * Enforces the blocked-term list inside the page.
 *
 * Three behaviours, selected by the term scope stored in the companion:
 *
 *   engines  only the supported search engines are watched
 *   search   search boxes on any site are watched too
 *   inputs   as above, and a blocked term cannot be typed or pasted into any
 *            text field at all — the keystroke is refused before it lands
 *
 * Scope note: this reads the contents of page text fields and nothing else. It
 * is not a keylogger — it sees only what a field already contains plus the
 * character about to go into it, only inside a browser tab, only while a
 * session is active, and it sends none of it anywhere.
 */
(function termGuard() {
  'use strict';

  const STATE_KEY = 'accState';
  const DEBOUNCE_MS = 250;
  // A term can only be completed near the caret, so bounding how much text is
  // examined keeps per-keystroke work constant even in a very long document.
  const CARET_WINDOW = 200;
  const SCAN_LIMIT = 4000;
  const SEARCH_FIELD_NAMES = new Set([
    'q',
    's',
    'as_q',
    'search',
    'search_query',
    'searchterm',
    'searchtext',
    'query',
    'keyword',
    'keywords',
    'p',
    'text',
    'term',
  ]);

  const engine = AccMatcher.engineForHost(location.hostname);

  let state = { protectionActive: false, keywords: [], keywordScope: 'search' };
  let leaving = false;
  let debounceTimer = null;

  chrome.storage.local.get(STATE_KEY, (stored) => {
    if (stored && stored[STATE_KEY]) state = stored[STATE_KEY];
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) state = changes[STATE_KEY].newValue || state;
  });

  const scope = () => state.keywordScope || 'search';

  /** Armed at all only while a session is running and terms exist. */
  function armed() {
    if (leaving) return false;
    if (!state.protectionActive) return false;
    if (!(state.keywords || []).length) return false;
    // Narrowest scope: leave every site that is not a supported engine alone.
    if (!engine && !AccMatcher.scopeAtLeast(scope(), 'search')) return false;
    return true;
  }

  const typingBlocked = () => armed() && AccMatcher.scopeAtLeast(scope(), 'inputs');

  // ------------------------------------------------------------ field checks

  function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'tel', ''].includes(type);
    }
    if (tag === 'TEXTAREA') return true;
    return Boolean(el.isContentEditable);
  }

  function isSearchField(el) {
    if (!isTextEntry(el)) return false;
    const name = (el.getAttribute('name') || '').toLowerCase();
    const id = (el.getAttribute('id') || '').toLowerCase();
    if (SEARCH_FIELD_NAMES.has(name) || SEARCH_FIELD_NAMES.has(id)) return true;
    if ((el.getAttribute('type') || '').toLowerCase() === 'search') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'searchbox' || role === 'combobox') return true;
    const hints = [
      id,
      name,
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('title') || '',
      el.getAttribute('class') || '',
    ]
      .join(' ')
      .toLowerCase();
    if (/search|query/.test(hints)) return true;
    // A field inside <form role="search"> or a search form is one too.
    const form = typeof el.closest === 'function' ? el.closest('form') : null;
    if (form) {
      const formHints = [
        form.getAttribute('role') || '',
        form.getAttribute('id') || '',
        form.getAttribute('class') || '',
        form.getAttribute('action') || '',
      ]
        .join(' ')
        .toLowerCase();
      if (/search/.test(formHints)) return true;
    }
    return false;
  }

  const fieldText = (el) => (el.isContentEditable ? el.textContent : el.value) || '';

  function clearField(el) {
    try {
      if (el.isContentEditable) el.textContent = '';
      else el.value = '';
    } catch {
      /* some sites use read-only proxies; the redirect below still applies */
    }
  }

  // ------------------------------------------------------------- reactions

  /** Wipe the field and leave for the local blocked page. */
  function leaveForBlockedPage(field, via) {
    if (leaving) return;
    leaving = true;
    if (field) clearField(field);
    // The matched term is not passed along — no point putting it back in front
    // of the person who asked not to see it.
    const url = chrome.runtime.getURL(
      `blocked.html?${new URLSearchParams({
        reason: 'search',
        engine: engine ? engine.name : location.hostname,
        via,
      })}`,
    );
    location.replace(url);
  }

  let toastHost = null;
  let toastTimer = null;

  /**
   * Refusing a keystroke silently would just look like a broken keyboard, so
   * say what happened. Rendered in a shadow root so page CSS cannot hide it.
   */
  function toast(message) {
    try {
      if (!document.body) return;
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
        const shadow = toastHost.attachShadow({ mode: 'closed' });
        const bubble = document.createElement('div');
        bubble.id = 'bubble';
        bubble.style.cssText = [
          'position: fixed',
          'bottom: 20px',
          'right: 20px',
          'max-width: 22rem',
          'padding: 12px 16px',
          'border-radius: 10px',
          'background: #1b1d22',
          'color: #f6f7f9',
          'font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          'box-shadow: 0 6px 24px rgba(0,0,0,0.28)',
          'pointer-events: none',
        ].join(';');
        shadow.appendChild(bubble);
        document.body.appendChild(toastHost);
      }
      const bubble = toastHost.shadowRoot && toastHost.shadowRoot.getElementById('bubble');
      if (bubble) bubble.textContent = message;
      toastHost.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (toastHost) toastHost.hidden = true;
      }, 2600);
    } catch {
      /* a page that forbids DOM insertion still gets the block itself */
    }
  }

  // --------------------------------------------------------------- listeners

  /**
   * The text around the caret as it would read if this edit were allowed
   * through, so a term is refused on the keystroke that would complete it
   * rather than after the fact.
   */
  function projectedText(el, event) {
    const insertion = event.data || (event.dataTransfer ? event.dataTransfer.getData('text') : '');
    if (!insertion) return null;
    const current = fieldText(el);
    if (el.isContentEditable || typeof el.selectionStart !== 'number') {
      return current.slice(-CARET_WINDOW) + insertion;
    }
    const start = el.selectionStart;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
    return (
      current.slice(Math.max(0, start - CARET_WINDOW), start) +
      insertion +
      current.slice(end, end + CARET_WINDOW)
    );
  }

  // Refuse the edit that would complete a blocked term. `beforeinput` is
  // cancelable for typing, pasting and dropping alike.
  document.addEventListener(
    'beforeinput',
    (event) => {
      if (!typingBlocked() || !event.cancelable) return;
      const field = event.target;
      if (!isTextEntry(field)) return;
      const projected = projectedText(field, event);
      if (!projected) return;
      if (!AccMatcher.matchKeyword(projected, state.keywords)) return;
      event.preventDefault();
      toast('That word is on your blocked list. Your session is still running.');
    },
    true,
  );

  // Fallback for anything that sets a value without a cancelable beforeinput
  // (autofill, some editors). Search fields leave for the blocked page; other
  // fields just have the offending text removed, so an unrelated draft is not
  // destroyed by a stray match.
  document.addEventListener(
    'input',
    (event) => {
      const field = event.target;
      if (!armed()) return;
      const searchField = isSearchField(field);
      if (!searchField && !typingBlocked()) return;
      if (!isTextEntry(field)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!armed()) return;
        // Search boxes are short; anything else is scanned near its tail only.
        const text = searchField ? fieldText(field) : fieldText(field).slice(-SCAN_LIMIT);
        if (!AccMatcher.matchKeyword(text, state.keywords)) return;
        if (searchField) leaveForBlockedPage(field, 'typing');
        else {
          clearField(field);
          toast('That word is on your blocked list, so it was removed.');
        }
      }, DEBOUNCE_MS);
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
      leaveForBlockedPage(field, 'enter');
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
        leaveForBlockedPage(field, 'submit');
        return;
      }
    },
    true,
  );
})();
