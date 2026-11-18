import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrate } from '../src/db.js';
import { loadWordSets } from '../src/game.js';
import {
  assignWordForDay,
  getWordForDay,
  addPoolWord,
  scheduleWord,
  previewDays,
  startScheduler,
} from '../src/words.js';

const openDbs = [];
after(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  openDbs.push(db);
  return db;
}

const DAY = '2026-11-17';
const NEXT = '2026-11-18';

test('scheduled word wins over pool and dictionary', () => {
  const db = freshDb();
  scheduleWord(db, { day: DAY, word: 'CLASS' });
  addPoolWord(db, { word: 'STUDY' });
  const word = assignWordForDay(db, DAY, Date.now());
  assert.equal(word.word, 'CLASS');
  assert.equal(word.source, 'scheduled');
});

test('pool word is used when nothing is scheduled', () => {
  const db = freshDb();
  addPoolWord(db, { word: 'STUDY', hint: 'what the library is for' });
  const word = assignWordForDay(db, DAY, Date.now());
  assert.equal(word.word, 'STUDY');
  assert.equal(word.source, 'pool');
  assert.equal(word.hint, 'what the library is for');
});

test('dictionary is the last resort', () => {
  const db = freshDb();
  const word = assignWordForDay(db, DAY, Date.now(), { answers: ['CRANE', 'SLATE'] });
  assert.equal(word.source, 'auto');
  assert.match(word.word, /^[A-Z]{5}$/);
});

test('assignment is idempotent and returns one row per day', () => {
  const db = freshDb();
  addPoolWord(db, { word: 'STUDY' });
  addPoolWord(db, { word: 'CLASS' });
  const first = assignWordForDay(db, DAY, Date.now());
  const second = assignWordForDay(db, DAY, Date.now());
  assert.equal(first.id, second.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM words WHERE day = ?').get(DAY).n;
  assert.equal(count, 1);
});

test('repeats within 180 days are avoided when alternatives exist', () => {
  const db = freshDb();
  addPoolWord(db, { word: 'STUDY' });
  addPoolWord(db, { word: 'CLASS' });
  const first = assignWordForDay(db, DAY, Date.now());
  const second = assignWordForDay(db, NEXT, Date.now());
  assert.notEqual(first.word, second.word);
});

test('no available word returns null instead of throwing', () => {
  const db = freshDb();
  const word = assignWordForDay(db, DAY, Date.now(), { answers: [] });
  assert.equal(word, null);
  assert.equal(getWordForDay(db, DAY), undefined);
});

test('preview reports scheduled, pool, and automatic days', () => {
  const db = freshDb();
  scheduleWord(db, { day: DAY, word: 'CLASS' });
  addPoolWord(db, { word: 'STUDY' });
  const preview = previewDays(db, DAY, 3, { answers: ['CRANE'] });
  assert.equal(preview[0].status, 'scheduled');
  assert.equal(preview[0].word, 'CLASS');
  assert.equal(preview[1].status, 'pool');
  assert.equal(preview[2].status, 'pool');
});

test('scheduler catches up every missed day and arms the next midnight', () => {
  const db = freshDb();
  const timers = [];
  const scheduler = startScheduler(db, {
    now: () => Date.UTC(2026, 10, 19, 15, 0),
    setTimer: (fn, ms) => {
      timers.push(ms);
      return timers.length;
    },
    clearTimer: () => {},
    answers: ['CRANE'],
  });
  scheduler.fire();
  assert.ok(getWordForDay(db, '2026-11-19'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM words WHERE day IS NOT NULL").get().n, 1);
  assert.equal(timers.length, 1);
  assert.ok(timers[0] > 0 && timers[0] <= 24 * 60 * 60 * 1000);
  scheduler.stop();
});

test('seed list is playable: five letters, answerable, hints hide the word', () => {
  const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const { answers } = loadWordSets();
  const answerSet = new Set(answers);
  assert.ok(seed.length >= 30);
  for (const { word, hint } of seed) {
    assert.match(word, /^[A-Z]{5}$/);
    assert.ok(answerSet.has(word), `${word} must be a possible answer`);
    assert.ok(hint.length > 0);
    assert.ok(!hint.toUpperCase().includes(word), `${word} appears in its own hint`);
  }
});
