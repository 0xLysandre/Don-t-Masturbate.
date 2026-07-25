'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The matcher is a plain script shared by the service worker and the content
// script; requiring it attaches AccMatcher to the global.
require('../../extension/shared/matcher.js');
const { matchKeyword, matchUrl, engineForUrl, queriesFromUrl } = globalThis.AccMatcher;

const KEYWORDS = ['flagged phrase', 'badword'];

test('plain substring matching, case and spacing insensitive', () => {
  assert.equal(matchKeyword('a FLAGGED   Phrase here', KEYWORDS), 'flagged phrase');
  assert.equal(matchKeyword('BADWORD', KEYWORDS), 'badword');
  assert.equal(matchKeyword('perfectly ordinary search', KEYWORDS), null);
  assert.equal(matchKeyword('', KEYWORDS), null);
  assert.equal(matchKeyword('badword', []), null);
});

test('punctuation and diacritics do not defeat a match', () => {
  assert.equal(matchKeyword('f.l.a.g.g.e.d  phrase', KEYWORDS), null); // letters still split
  assert.equal(matchKeyword('flagged-phrase', KEYWORDS), 'flagged phrase');
  assert.equal(matchKeyword('bàdwörd', KEYWORDS), 'badword');
});

test('the supported engines are recognised, others are not', () => {
  const recognised = [
    'https://www.google.com/search?q=hello',
    'https://google.co.uk/search?q=hello',
    'https://www.bing.com/search?q=hello',
    'https://duckduckgo.com/?q=hello',
    'https://www.youtube.com/results?search_query=hello',
  ];
  for (const url of recognised) assert.ok(engineForUrl(url), `${url} should be recognised`);
  assert.equal(engineForUrl('https://example.com/search?q=hello'), null);
  assert.equal(engineForUrl('not a url'), null);
});

test('flagged query parameters are caught on every supported engine', () => {
  const urls = [
    'https://www.google.com/search?q=some+badword+thing',
    'https://www.google.com/search?as_q=badword',
    'https://www.bing.com/search?q=BADWORD&form=QBLH',
    'https://duckduckgo.com/?q=a%20flagged%20phrase',
    'https://www.youtube.com/results?search_query=badword',
    'https://www.youtube.com/results?search=badword',
  ];
  for (const url of urls) {
    assert.ok(queriesFromUrl(url).length > 0, `${url} should expose a query`);
    assert.ok(matchUrl(url, KEYWORDS), `${url} should be blocked`);
  }
});

test('clean searches on supported engines pass through', () => {
  assert.equal(matchUrl('https://www.google.com/search?q=node+test+runner', KEYWORDS), null);
  assert.equal(matchUrl('https://www.youtube.com/watch?v=abc123', KEYWORDS), null);
});

test('a flagged term on an unsupported host is ignored by the backstop', () => {
  // Domain blocking is declarativeNetRequest's job; the query backstop is
  // deliberately limited to the engines this MVP supports.
  assert.equal(matchUrl('https://example.com/search?q=badword', KEYWORDS), null);
});

test('terms hidden in the URL fragment are still caught', () => {
  assert.equal(matchUrl('https://duckduckgo.com/?t=h_#q=badword', KEYWORDS), 'badword');
});

// --------------------------------------------------------------- site-wide

const { matchAnyUrl, queriesFromAnyUrl, scopeAtLeast } = globalThis.AccMatcher;

test('the site-wide backstop reads any query parameter on any host', () => {
  const urls = [
    'https://some-forum.example/search?s=badword',
    'https://shop.example/products?keyword=BADWORD&page=2',
    'https://wiki.example/index.php?title=x&search=a+flagged+phrase',
    'https://app.example/#/results?term=badword',
  ];
  for (const url of urls) assert.ok(matchAnyUrl(url, KEYWORDS), `${url} should be blocked`);
});

test('the site-wide backstop ignores the path, to keep false positives down', () => {
  // An article slug containing the term is somebody else's page, not a search.
  assert.equal(matchAnyUrl('https://news.example/2026/badword-explained', KEYWORDS), null);
  assert.equal(matchAnyUrl('https://news.example/ok?ref=newsletter', KEYWORDS), null);
});

test('the site-wide backstop leaves non-web URLs alone', () => {
  assert.deepEqual(queriesFromAnyUrl('chrome-extension://abc/blocked.html?reason=search'), []);
  assert.equal(matchAnyUrl('chrome-extension://abc/blocked.html?q=badword', KEYWORDS), null);
  assert.equal(matchAnyUrl('about:blank', KEYWORDS), null);
});

test('a bare fragment is treated as a query too', () => {
  assert.equal(matchAnyUrl('https://app.example/page#badword', KEYWORDS), 'badword');
});

test('scope ordering decides how far the list reaches', () => {
  assert.equal(scopeAtLeast('engines', 'engines'), true);
  assert.equal(scopeAtLeast('engines', 'search'), false);
  assert.equal(scopeAtLeast('engines', 'inputs'), false);
  assert.equal(scopeAtLeast('search', 'search'), true);
  assert.equal(scopeAtLeast('search', 'inputs'), false);
  assert.equal(scopeAtLeast('inputs', 'inputs'), true);
  // An unknown or missing scope falls back to the default, never to "off".
  assert.equal(scopeAtLeast(undefined, 'search'), true);
  assert.equal(scopeAtLeast('nonsense', 'search'), true);
  assert.equal(scopeAtLeast('nonsense', 'inputs'), false);
});
