import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreGuess, loadWordSets, isValidGuess } from '../src/game.js';

test('exact match is all correct', () => {
  assert.deepEqual(scoreGuess('CRANE', 'CRANE'), ['correct', 'correct', 'correct', 'correct', 'correct']);
});

test('single occurrence in answer cannot produce two presents', () => {
  assert.deepEqual(scoreGuess('ALLEY', 'LEMON'), ['absent', 'present', 'absent', 'present', 'absent']);
});

test('duplicates with mixed greens', () => {
  assert.deepEqual(scoreGuess('BABES', 'ABBEY'), ['present', 'present', 'correct', 'correct', 'absent']);
});

test('greens consume letters before yellows', () => {
  // answer SPEED, guess ERASE: answer has two Es, no position matches
  assert.deepEqual(scoreGuess('ERASE', 'SPEED'), ['present', 'absent', 'absent', 'present', 'present']);
});

test('word sets load with valid five-letter entries', () => {
  const { allowed, answers } = loadWordSets();
  assert.ok(allowed.size >= 1000);
  assert.ok(answers.length >= 150);
  for (const w of allowed) assert.match(w, /^[A-Z]{5}$/);
  assert.equal(isValidGuess('CRANE', allowed), true);
  assert.equal(isValidGuess('CRANEE', allowed), false);
  assert.equal(isValidGuess('cr4ne', allowed), false);
});
