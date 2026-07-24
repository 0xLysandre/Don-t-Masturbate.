'use strict';

/** Local-calendar date key, e.g. "2026-07-24". */
function dateKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days between two date keys, computed at UTC midnight so DST cannot skew it. */
function daysBetween(earlier, later) {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function shiftDate(key, deltaDays) {
  const t = Date.parse(`${key}T00:00:00Z`) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Current streak = consecutive on-track days ending today (or yesterday, so a
 * streak is not destroyed simply because today's check-in has not happened
 * yet). A "no" answer, or a missed day, ends the streak.
 */
function currentStreak(checkins, today = dateKey()) {
  const byDate = new Map(checkins.map((c) => [c.date, c]));
  let anchor = today;
  if (!byDate.has(anchor)) {
    const yesterday = shiftDate(today, -1);
    if (!byDate.has(yesterday)) return 0;
    anchor = yesterday;
  }
  let streak = 0;
  let cursor = anchor;
  for (;;) {
    const entry = byDate.get(cursor);
    if (!entry || !entry.onTrack) break;
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

/** Longest run of consecutive on-track days anywhere in the history. */
function longestStreak(checkins) {
  const days = checkins
    .filter((c) => c.onTrack)
    .map((c) => c.date)
    .sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    if (prev !== null && daysBetween(prev, day) === 1) run += 1;
    else run = 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

module.exports = { dateKey, daysBetween, shiftDate, currentStreak, longestStreak };
