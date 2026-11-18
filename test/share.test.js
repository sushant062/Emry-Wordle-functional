import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShare } from '../src/share.js';

test('share text carries the emoji grid and time', () => {
  const text = formatShare({
    rows: [['absent', 'present', 'correct', 'absent', 'present']],
    elapsedMs: 54000,
    hints: 1,
  });
  assert.equal(text, 'Emry Hall 1st Floor — 54s ⏱ (1 hint)\n⬛🟨🟩⬛🟨');
});

test('multiple rows stack and hints are omitted at zero', () => {
  const text = formatShare({
    rows: [
      ['absent', 'absent', 'absent', 'absent', 'absent'],
      ['correct', 'correct', 'correct', 'correct', 'correct'],
    ],
    elapsedMs: 83000,
    hints: 0,
  });
  assert.equal(text, 'Emry Hall 1st Floor — 1m 23s ⏱\n⬛⬛⬛⬛⬛\n🟩🟩🟩🟩🟩');
});

test('two hints are pluralized', () => {
  const text = formatShare({ rows: [], elapsedMs: 5000, hints: 2 });
  assert.equal(text, 'Emry Hall 1st Floor — 5s ⏱ (2 hints)');
});
