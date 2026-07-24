'use strict';

const params = new URLSearchParams(location.search);
const reason = params.get('reason');
const engine = params.get('engine');
const target = params.get('target');
const via = params.get('via');

const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const context = document.getElementById('context');

if (reason === 'search') {
  headline.textContent = 'That search is on your list';
  detail.textContent =
    'The search you were about to run matched a term you asked to be kept away from.';
  const source =
    via === 'navigation'
      ? 'caught on navigation — a pasted or linked search URL'
      : 'caught in the search box';
  context.textContent = `${engine ? `${engine} — ` : ''}${source}.`;
} else if (reason === 'domain') {
  headline.textContent = 'That site is on your blocklist';
  detail.textContent = 'You added this domain to your blocklist while setting up your session.';
  context.textContent = target ? `Blocked domain: ${target}` : '';
} else {
  headline.textContent = 'Blocked';
  detail.textContent = 'This page was blocked by your accountability session.';
}

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.replace('about:blank');
});

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('checkin').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:7373/' });
});
