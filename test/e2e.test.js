import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { scheduleWord } from '../src/words.js';
import { createApp } from '../src/app.js';

const DAY = '2026-11-17';
const YESTERDAY = '2026-11-16';
const NOON = Date.UTC(2026, 10, 17, 18, 0);
const ANSWER = 'CLASS';
const CLUE = 'starts at eight whether you are ready or not';
const PRACTICE_WORD = 'STUDY';
const WRONG_GUESSES = ['CRANE', 'SLATE', 'AUDIO', 'PIOUS'];

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

function makeWorld() {
  const db = openDb(':memory:');
  migrate(db);
  openDbs.push(db);
  scheduleWord(db, { day: DAY, word: ANSWER, hint: CLUE });
  scheduleWord(db, { day: YESTERDAY, word: PRACTICE_WORD, hint: 'what the library is for, allegedly' });
  let clock = NOON;
  const app = createApp({ db, now: () => clock });
  const advance = (ms) => {
    clock += ms;
    return clock;
  };
  return { db, app, advance };
}

function makeClient(app) {
  let cookie = '';
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    let body = init.body;
    if (body != null && typeof body !== 'string') {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(body);
    }
    const res = await app.request(path, { ...init, headers, body });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };
}

const leaks = (body) => JSON.stringify(body ?? {}).includes(ANSWER);

test('a device can play one full ranked day, then practice without touching the boards', async () => {
  const { db, app, advance } = makeWorld();
  const call = makeClient(app);

  const today = await call('/api/today');
  assert.equal(today.status, 200);
  assert.equal(today.body.status, 'ok');
  assert.equal(today.body.day, DAY);
  assert.equal(today.body.played, false);
  assert.equal(today.body.wordLength, 5);
  assert.equal(leaks(today.body), false, 'today leaks the answer');

  const session = await call('/api/session', { method: 'POST', body: { name: '  Ana  ' } });
  assert.equal(session.status, 200);
  assert.equal(session.body.name, 'Ana');
  assert.equal(leaks(session.body), false, 'session leaks the answer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0, 'session must not create an attempt');

  advance(1000);
  const start = await call('/api/attempt/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal(start.body.created, true);
  assert.equal(start.body.attempt.startedAt, NOON + 1000);
  assert.equal(start.body.attempt.guesses.length, 0);
  assert.equal(leaks(start.body), false, 'start leaks the answer');

  for (const guess of WRONG_GUESSES) {
    advance(4000);
    const res = await call('/api/guess', { method: 'POST', body: { guess } });
    assert.equal(res.status, 200);
    assert.equal(res.body.solved, false);
    assert.equal(res.body.results.length, 5);
    assert.equal(leaks(res.body), false, `guess ${guess} leaks the answer`);
  }

  advance(3000);
  const hint = await call('/api/hint', { method: 'POST' });
  assert.equal(hint.status, 200);
  assert.equal(hint.body.tier, 1);
  assert.equal(hint.body.text, CLUE);
  assert.equal(hint.body.hints, 1);
  assert.ok(hint.body.elapsedMs >= 20000, 'hint adds its penalty');
  assert.equal(leaks(hint.body), false, 'hint leaks the answer');

  advance(2000);
  const win = await call('/api/guess', { method: 'POST', body: { guess: ANSWER } });
  assert.equal(win.status, 200);
  assert.equal(win.body.solved, true);
  assert.equal(win.body.finished, true);
  assert.equal(win.body.remaining, 1);
  assert.equal(win.body.results.every((cell) => cell === 'correct'), true);
  assert.equal(leaks(win.body), false, 'solve response leaks the answer');

  const day = await call('/api/leaderboard?range=day');
  assert.deepEqual(day.body.rows.map((row) => row.name), ['Ana']);
  assert.equal(day.body.rows.length, 1);
  assert.equal(day.body.rows[0].hints, 1);
  const week = await call('/api/leaderboard?range=week');
  assert.deepEqual(week.body.rows.map((row) => row.name), ['Ana']);
  const month = await call('/api/leaderboard?range=month');
  assert.deepEqual(month.body.fastest.map((row) => row.name), ['Ana']);
  assert.equal(month.body.streaks[0].streak, 1);

  const again = await call('/api/attempt/start', { method: 'POST' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_finished');
  assert.equal(again.body.attempt.solved, true);

  const practice = await call('/api/practice/start', { method: 'POST' });
  assert.equal(practice.status, 201);
  assert.equal(typeof practice.body.practiceId, 'number');
  assert.equal(leaks(practice.body), false, 'practice start leaks the answer');

  const practiceGuess = await call('/api/practice/guess', {
    method: 'POST',
    body: { practiceId: practice.body.practiceId, guess: PRACTICE_WORD },
  });
  assert.equal(practiceGuess.status, 200);
  assert.equal(practiceGuess.body.solved, true);
  assert.equal(practiceGuess.body.finished, true);

  const dayAfter = await call('/api/leaderboard?range=day');
  assert.equal(dayAfter.body.rows.length, 1, 'practice must not add a day row');
  const weekAfter = await call('/api/leaderboard?range=week');
  assert.equal(weekAfter.body.rows.length, 1, 'practice must not add a week row');
  const monthAfter = await call('/api/leaderboard?range=month');
  assert.equal(monthAfter.body.fastest.length, 1, 'practice must not add a month row');
  assert.equal(monthAfter.body.streaks.length, 1, 'practice must not add a streak');
});

test('the answer never appears in the served page or its assets', async () => {
  const { app } = makeWorld();
  for (const path of ['/', '/app.js', '/app.css', '/share.js?v=1', '/manifest.webmanifest']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.equal(text.includes(ANSWER), false, `${path} leaks the answer`);
  }
});
