import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord, assignWordForDay, scheduleWord, hintLeaksAnswer } from '../src/words.js';
import { startRankedAttempt, submitGuess, elapsedFor, nextHint } from '../src/attempts.js';

const DAY = '2026-11-17';
const NOON = Date.UTC(2026, 10, 17, 18, 0);
const DEV = 'dev-1';
const CLUE = 'starts at eight whether you are ready or not';

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

function setup(word = 'CLASS', hint = CLUE) {
  const db = openDb(':memory:');
  migrate(db);
  openDbs.push(db);
  db.prepare('INSERT INTO devices (id, created_at) VALUES (?, ?)').run(DEV, NOON);
  addPoolWord(db, { word, hint });
  assignWordForDay(db, DAY, NOON);
  return db;
}

test('tier one returns the curated clue', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  const hint = nextHint(db, { deviceId: DEV, now: NOON + 5000 });
  assert.equal(hint.tier, 1);
  assert.equal(hint.text, CLUE);
  assert.equal(hint.letter, undefined);
  assert.equal(hint.hints, 1);
  assert.equal(hint.elapsedMs, 25000);
});

test('tier two reveals an unknown correct letter and adds 20s', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  nextHint(db, { deviceId: DEV, now: NOON + 1000 });
  const hint = nextHint(db, { deviceId: DEV, now: NOON + 5000 });
  assert.equal(hint.tier, 2);
  assert.match(hint.letter, /^[A-Z]$/);
  assert.ok(Number.isInteger(hint.position) && hint.position >= 0 && hint.position < 5);
  assert.equal(hint.hints, 2);
  assert.equal(hint.text, undefined);
  assert.equal(hint.elapsedMs, 45000);
  const row = db.prepare('SELECT hints, penalty_ms, guesses FROM attempts').get();
  assert.equal(row.hints, 2);
  assert.equal(row.penalty_ms, 40000);
  const entries = JSON.parse(row.guesses);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].reveal, { letter: hint.letter, position: hint.position });
});

test('third hint is refused', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  nextHint(db, { deviceId: DEV, now: NOON + 1000 });
  nextHint(db, { deviceId: DEV, now: NOON + 2000 });
  const third = nextHint(db, { deviceId: DEV, now: NOON + 3000 });
  assert.equal(third.error, 'max_hints');
  assert.equal(elapsedFor(db.prepare('SELECT * FROM attempts').get(), NOON + 3000), 43000);
});

test('word without a clue falls back to a letter at tier one', () => {
  const db = setup('CRANE', null);
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  const hint = nextHint(db, { deviceId: DEV, now: NOON + 1000 });
  assert.equal(hint.tier, 1);
  assert.match(hint.letter, /^[A-Z]$/);
  assert.ok(Number.isInteger(hint.position));
  assert.equal(hint.text, undefined);
});

test('hints require an open attempt', () => {
  const db = setup();
  const cold = nextHint(db, { deviceId: DEV, now: NOON });
  assert.equal(cold.error, 'not_started');

  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  submitGuess(db, { deviceId: DEV, guess: 'CLASS', now: NOON + 1000 });
  const afterWin = nextHint(db, { deviceId: DEV, now: NOON + 2000 });
  assert.equal(afterWin.error, 'finished');
});

test('clue containing the answer is rejected at authoring time', () => {
  assert.equal(hintLeaksAnswer('a place to sleep', 'BED'), false);
  assert.equal(hintLeaksAnswer('the dorm BEDS', 'BEDS'), true);
  assert.equal(hintLeaksAnswer('class starts at eight', 'CLASS'), true);
  assert.equal(hintLeaksAnswer('your whole social world', 'FLOOR'), false);
});

test('saving a word with a leaking clue is refused', () => {
  const db = setup();
  assert.throws(() => addPoolWord(db, { word: 'BUNKS', hint: 'the bunks are stacked' }), /hint_leaks/);
  assert.throws(
    () => scheduleWord(db, { day: '2026-11-19', word: 'TOWEL', hint: 'towel day again' }),
    /hint_leaks/,
  );
});
