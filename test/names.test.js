import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, validateName } from '../src/names.js';

test('accepts ordinary dorm names', () => {
  assert.deepEqual(validateName('  Alex  B. '), { ok: true, display: 'Alex B.', norm: 'alex b' });
  assert.equal(validateName("D'Angelo").ok, true);
  assert.equal(validateName('Mary-Jane').ok, true);
});

test('rejects empty, too long, and markup', () => {
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('x'.repeat(21)).ok, false);
  assert.equal(validateName('<script>alert(1)</script>').ok, false);
});

test('normalization is case and whitespace insensitive', () => {
  assert.equal(normalizeName('  SUSHANT   thakur '), 'sushant thakur');
});
