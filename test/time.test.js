import test from 'node:test';
import assert from 'node:assert/strict';
import { centralDay, nextCentralMidnight, weekStart } from '../src/time.js';

test('centralDay uses the Chicago calendar date', () => {
  assert.equal(centralDay(Date.UTC(2026, 10, 18, 4, 0)), '2026-11-17'); // 23:00 CST
  assert.equal(centralDay(Date.UTC(2026, 10, 18, 6, 0)), '2026-11-18'); // 00:00 CST
});

test('nextCentralMidnight is midnight Central in both DST directions', () => {
  // 2026-03-08 spring forward: local midnight is still CST (-6)
  assert.equal(nextCentralMidnight(Date.UTC(2026, 2, 7, 18, 0)), Date.UTC(2026, 2, 8, 6, 0));
  // 2026-11-01 fall back: local midnight is CDT (-5)
  assert.equal(nextCentralMidnight(Date.UTC(2026, 9, 31, 18, 0)), Date.UTC(2026, 10, 1, 5, 0));
  // ordinary night
  assert.equal(nextCentralMidnight(Date.UTC(2026, 10, 17, 18, 0)), Date.UTC(2026, 10, 18, 6, 0));
});

test('weekStart returns the Monday of the week', () => {
  assert.equal(weekStart('2026-11-17'), '2026-11-16');
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
  assert.equal(weekStart('2026-11-22'), '2026-11-16');
});
