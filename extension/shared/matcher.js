/**
 * Keyword matching + search-engine URL parsing.
 *
 * Loaded twice — via importScripts() in the service worker and as the first
 * content script file — so it is a plain script that hangs one object off the
 * global, with no imports or exports.
 */
(function attachMatcher(global) {
  'use strict';

  /** Case/diacritic/punctuation-insensitive form used on both sides of a match. */
  function normalise(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Plain substring match against the keyword list. Returns the keyword or null. */
  function matchKeyword(text, keywords) {
    const haystack = normalise(text);
    if (!haystack) return null;
    for (const keyword of keywords || []) {
      const needle = normalise(keyword);
      if (needle && haystack.includes(needle)) return keyword;
    }
    return null;
  }

  // The fixed set of engines this MVP understands. `params` are the query
  // parameters each one puts the search terms in.
  const ENGINES = [
    { name: 'google', test: /(^|\.)google(\.[a-z]{2,3}){1,2}$/, params: ['q', 'as_q', 'search_query'] },
    { name: 'bing', test: /(^|\.)bing\.com$/, params: ['q'] },
    { name: 'duckduckgo', test: /(^|\.)duckduckgo\.com$/, params: ['q'] },
    { name: 'youtube', test: /(^|\.)youtube(-nocookie)?\.com$/, params: ['search_query', 'q'] },
  ];

  // Every engine also gets checked for this, per the "q=/search=" requirement.
  const GENERIC_PARAMS = ['search', 'query', 'p', 'text'];

  function engineForHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return ENGINES.find((engine) => engine.test.test(host)) || null;
  }

  function engineForUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return engineForHost(parsed.hostname);
    } catch {
      return null;
    }
  }

  /** All candidate search strings carried by a search-engine URL. */
  function queriesFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    const engine = engineForHost(parsed.hostname);
    if (!engine) return [];
    const names = [...engine.params, ...GENERIC_PARAMS];
    const found = [];
    for (const name of names) {
      const value = parsed.searchParams.get(name);
      if (value) found.push(value);
    }
    // DuckDuckGo and YouTube also accept the terms in the hash fragment.
    if (parsed.hash && parsed.hash.length > 1) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      for (const name of names) {
        const value = hashParams.get(name);
        if (value) found.push(value);
      }
    }
    return found;
  }

  /**
   * Every query value carried by any URL, whether or not the host is a known
   * engine. Used when the term list is enforced site-wide, so a small site's
   * own `?s=` or `?keyword=` search is caught too.
   *
   * Only query and fragment parameters are read — never the path. A term in a
   * path is usually somebody else's article slug, and blocking on it produces
   * far more false positives than it prevents.
   */
  function queriesFromAnyUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    const found = [];
    for (const [, value] of parsed.searchParams) if (value) found.push(value);
    if (parsed.hash && parsed.hash.length > 1) {
      const hash = parsed.hash.slice(1);
      for (const [, value] of new URLSearchParams(hash)) if (value) found.push(value);
      // A bare fragment such as #some-term carries no "=" to parse.
      if (!hash.includes('=')) found.push(hash);
    }
    return found;
  }

  /** Backstop check for a search-engine navigation. Returns the term or null. */
  function matchUrl(url, keywords) {
    for (const query of queriesFromUrl(url)) {
      const hit = matchKeyword(query, keywords);
      if (hit) return hit;
    }
    return null;
  }

  /** Backstop check for a navigation to any site at all. */
  function matchAnyUrl(url, keywords) {
    for (const query of queriesFromAnyUrl(url)) {
      const hit = matchKeyword(query, keywords);
      if (hit) return hit;
    }
    return null;
  }

  // How far the term list reaches. Ordered from narrowest to widest.
  const SCOPES = ['engines', 'search', 'inputs'];

  const scopeAtLeast = (scope, minimum) =>
    SCOPES.indexOf(SCOPES.includes(scope) ? scope : 'search') >= SCOPES.indexOf(minimum);

  global.AccMatcher = {
    normalise,
    matchKeyword,
    engineForHost,
    engineForUrl,
    queriesFromUrl,
    queriesFromAnyUrl,
    matchUrl,
    matchAnyUrl,
    scopeAtLeast,
    SCOPES,
    ENGINES,
  };
})(typeof self !== 'undefined' ? self : globalThis);
