import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';

test('migrate creates the schema and is idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(names.includes('devices') && names.includes('words') && names.includes('attempts'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  assert.ok(idx.includes('one_ranked_per_device_day'));
});
