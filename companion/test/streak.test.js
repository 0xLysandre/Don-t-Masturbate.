'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { currentStreak, longestStreak, shiftDate } = require('../lib/streak');

const yes = (date) => ({ date, onTrack: true });
const no = (date) => ({ date, onTrack: false });

test('consecutive on-track days build a streak', () => {
  const checkins = [yes('2026-07-20'), yes('2026-07-21'), yes('2026-07-22')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 3);
});

test('a missed day resets the streak', () => {
  // Nothing logged on the 21st.
  const checkins = [yes('2026-07-19'), yes('2026-07-20'), yes('2026-07-22')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 1);
});

test('a "no" answer resets the streak', () => {
  const checkins = [yes('2026-07-20'), no('2026-07-21'), yes('2026-07-22')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 1);
});

test('a "no" today drops the streak to zero', () => {
  const checkins = [yes('2026-07-20'), yes('2026-07-21'), no('2026-07-22')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 0);
});

test("yesterday's streak survives until today is answered", () => {
  const checkins = [yes('2026-07-20'), yes('2026-07-21')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 2);
});

test('a two-day gap ends the streak', () => {
  const checkins = [yes('2026-07-19'), yes('2026-07-20')];
  assert.equal(currentStreak(checkins, '2026-07-22'), 0);
});

test('empty history has no streak', () => {
  assert.equal(currentStreak([], '2026-07-22'), 0);
  assert.equal(longestStreak([]), 0);
});

test('longest streak looks across the whole history', () => {
  const checkins = [
    yes('2026-07-01'),
    yes('2026-07-02'),
    yes('2026-07-03'),
    yes('2026-07-04'),
    no('2026-07-05'),
    yes('2026-07-06'),
  ];
  assert.equal(longestStreak(checkins), 4);
  assert.equal(currentStreak(checkins, '2026-07-06'), 1);
});

test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(shiftDate('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
});
