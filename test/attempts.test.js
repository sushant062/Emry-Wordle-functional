import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord, assignWordForDay } from '../src/words.js';
import { startRankedAttempt, submitGuess, getTodayState, elapsedFor } from '../src/attempts.js';

const DAY = '2026-11-17';
const NOON = Date.UTC(2026, 10, 17, 18, 0); // 12:00 CST
const DEV = 'dev-1';

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

function setup(dbPath = ':memory:', word = 'STUDY') {
  const db = openDb(dbPath);
  migrate(db);
  openDbs.push(db);
  db.prepare('INSERT OR IGNORE INTO devices (id, created_at) VALUES (?, ?)').run(DEV, NOON);
  addPoolWord(db, { word });
  assignWordForDay(db, DAY, NOON);
  return db;
}

test('first keypress creates one ranked attempt with server start time', () => {
  const db = setup();
  const first = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  assert.equal(first.created, true);
  assert.equal(first.attempt.started_at, NOON);
  const second = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON + 4000 });
  assert.equal(second.created, false);
  assert.equal(second.attempt.id, first.attempt.id);
  assert.equal(second.attempt.started_at, NOON);
});

test('refresh resumes with the original started_at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emry-attempts-'));
  const file = join(dir, 'game.db');
  try {
    const db = setup(file);
    const { attempt } = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
    db.close();

    const reopened = setup(file);
    const state = getTodayState(reopened, { deviceId: DEV, day: DAY });
    assert.equal(state.played, true);
    assert.equal(state.attempt.started_at, attempt.started_at);
    assert.equal(elapsedFor(state.attempt, NOON + 5000), 5000);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('second ranked attempt after finish is refused', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  const win = submitGuess(db, { deviceId: DEV, guess: 'STUDY', now: NOON + 3000 });
  assert.equal(win.finished, true);
  const again = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON + 5000 });
  assert.equal(again.error, 'already_finished');
});

test('guesses after midnight are refused with day_over', () => {
  const db = setup();
  const late = Date.UTC(2026, 10, 18, 5, 59); // 23:59 CST on the 17th
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: late });
  const result = submitGuess(db, { deviceId: DEV, guess: 'STUDY', now: Date.UTC(2026, 10, 18, 6, 1) });
  assert.equal(result.error, 'day_over');
  const row = db.prepare('SELECT finished_at, guesses FROM attempts').get();
  assert.equal(row.finished_at, null);
  assert.equal(row.guesses, '[]');
});

test('an unfinished attempt from yesterday does not lock the device out today', () => {
  const db = setup();
  const yesterday = '2026-11-16';
  const yesterdayNoon = NOON - 24 * 60 * 60 * 1000;
  assignWordForDay(db, yesterday, yesterdayNoon);
  const started = startRankedAttempt(db, { deviceId: DEV, day: yesterday, now: yesterdayNoon });
  assert.equal(started.created, true);
  const yesterdayWord = db.prepare('SELECT word FROM words WHERE day = ?').get(yesterday).word;
  const wrong = ['CRANE', 'SLATE', 'AUDIO', 'PIOUS'].find((word) => word !== yesterdayWord);
  const guess = submitGuess(db, { deviceId: DEV, guess: wrong, now: yesterdayNoon + 1000 });
  assert.equal(guess.error, undefined);

  const today = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  assert.equal(today.created, true);
  assert.equal(today.attempt.day, DAY);

  const stale = db.prepare('SELECT finished_at, solved FROM attempts WHERE day = ?').get(yesterday);
  assert.notEqual(stale.finished_at, null, 'stale attempt should be closed');
  assert.equal(stale.solved, 0);
  const open = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE mode = 'ranked' AND finished_at IS NULL").get().n;
  assert.equal(open, 1);
});

test('losing completes the attempt with no rank', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  let result;
  for (let i = 0; i < 6; i += 1) {
    result = submitGuess(db, { deviceId: DEV, guess: 'PIZZA', now: NOON + 1000 * (i + 1) });
    assert.equal(result.error, undefined);
  }
  assert.equal(result.solved, false);
  assert.equal(result.finished, true);
  assert.equal(result.remaining, 0);
  assert.ok(result.elapsedMs >= 6000);
  const row = db.prepare('SELECT solved, finished_at, elapsed_ms FROM attempts').get();
  assert.equal(row.solved, 0);
  assert.equal(row.finished_at, NOON + 6000);
  assert.equal(row.elapsed_ms, 6000);
  const seventh = submitGuess(db, { deviceId: DEV, guess: 'PIZZA', now: NOON + 7000 });
  assert.equal(seventh.error, 'already_finished');
});

test('sub-1.2s solve is flagged suspicious but accepted', () => {
  const db = setup();
  const started = startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  db.prepare('UPDATE attempts SET started_at = ? WHERE id = ?').run(NOON - 800, started.attempt.id);
  const result = submitGuess(db, { deviceId: DEV, guess: 'STUDY', now: NOON });
  assert.equal(result.solved, true);
  assert.equal(result.finished, true);
  const row = db.prepare('SELECT suspicious, solved FROM attempts').get();
  assert.equal(row.suspicious, 1);
  assert.equal(row.solved, 1);
});

test('invalid or lowercase guess is rejected without consuming a turn', () => {
  const db = setup();
  startRankedAttempt(db, { deviceId: DEV, day: DAY, now: NOON });
  const lowercase = submitGuess(db, { deviceId: DEV, guess: 'study', now: NOON + 1000 });
  assert.equal(lowercase.error, 'invalid_word');
  const nonsense = submitGuess(db, { deviceId: DEV, guess: 'ZZZZZ', now: NOON + 1500 });
  assert.equal(nonsense.error, 'invalid_word');
  const short = submitGuess(db, { deviceId: DEV, guess: 'STU', now: NOON + 2000 });
  assert.equal(short.error, 'invalid_word');
  const row = db.prepare('SELECT guesses, finished_at FROM attempts').get();
  assert.equal(row.guesses, '[]');
  assert.equal(row.finished_at, null);
});
