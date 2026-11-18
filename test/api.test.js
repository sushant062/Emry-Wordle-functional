import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord, assignWordForDay, scheduleWord } from '../src/words.js';
import { createApp, DEVICE_COOKIE } from '../src/app.js';

const DAY = '2026-11-17';
const NOON = Date.UTC(2026, 10, 17, 18, 0);
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

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  openDbs.push(db);
  addPoolWord(db, { word: 'CLASS', hint: CLUE });
  assignWordForDay(db, DAY, NOON);
  const app = createApp({ db, now: () => NOON });
  return { db, app };
}

function makeClient(app) {
  let cookie = '';
  const call = async (path, init = {}) => {
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
    return { status: res.status, body: parsed, res };
  };
  return call;
}

test('first request issues a device cookie and reports today', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  const { status, body, res } = await call('/api/today');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.day, DAY);
  assert.equal(body.wordLength, 5);
  assert.equal(body.played, false);
  assert.equal(body.attempt, null);
  assert.deepEqual(body.names, []);
  const set = res.headers.get('set-cookie');
  assert.match(set, new RegExp(`^${DEVICE_COOKIE}=`));
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.match(set, /Max-Age=31536000/);
});

test('session sets display name without creating an attempt', async () => {
  const { db, app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  const session = await call('/api/session', { method: 'POST', body: { name: '  Alex  ' } });
  assert.equal(session.status, 200);
  assert.equal(session.body.name, 'Alex');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
  const today = await call('/api/today');
  assert.equal(today.body.played, false);
  assert.deepEqual(today.body.names, ['Alex']);
});

test('start then guess returns feedback and no answer field', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  const start = await call('/api/attempt/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal(start.body.created, true);
  assert.equal(start.body.attempt.startedAt, NOON);

  const guess = await call('/api/guess', { method: 'POST', body: { guess: 'CRANE' } });
  assert.equal(guess.status, 200);
  assert.equal(guess.body.results.length, 5);
  assert.equal(guess.body.solved, false);
  assert.equal(guess.body.remaining, 5);
  assert.ok(!JSON.stringify(guess.body).includes('CLASS'), 'answer must never be serialized');
  assert.equal(guess.body.word, undefined);

  const resume = await call('/api/attempt/start', { method: 'POST' });
  assert.equal(resume.body.created, false);
  assert.equal(resume.body.attempt.guesses.length, 1);
});

test('guess before start returns 409', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  const guess = await call('/api/guess', { method: 'POST', body: { guess: 'CRANE' } });
  assert.equal(guess.status, 409);
  assert.equal(guess.body.error, 'no_attempt');
});

test('practice start rejects today\'s word and never includes an answer', async () => {
  const { db, app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  const none = await call('/api/practice/start', { method: 'POST' });
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'no_practice_word');
  assert.ok(!JSON.stringify(none.body).includes('CLASS'));

  scheduleWord(db, { day: '2026-11-16', word: 'STUDY' });
  const start = await call('/api/practice/start', { method: 'POST' });
  assert.equal(start.status, 201);
  assert.equal(typeof start.body.practiceId, 'number');
  const text = JSON.stringify(start.body);
  assert.ok(!text.includes('STUDY'));
  assert.ok(!text.includes('CLASS'));

  const guess = await call('/api/practice/guess', {
    method: 'POST',
    body: { practiceId: start.body.practiceId, guess: 'STUDY' },
  });
  assert.equal(guess.status, 200);
  assert.equal(guess.body.solved, true);
  assert.equal(guess.body.finished, true);
  const row = db.prepare('SELECT mode FROM attempts ORDER BY id').get();
  assert.equal(row.mode, 'practice');
});

test('unknown cookie value is replaced with a fresh device', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  const stranger = '11111111-2222-3333-4444-555555555555';
  const first = await call('/api/today', { headers: { cookie: `${DEVICE_COOKIE}=${stranger}` } });
  assert.equal(first.status, 200);
  const set = first.res.headers.get('set-cookie');
  assert.ok(set);
  assert.ok(!set.startsWith(`${DEVICE_COOKIE}=${stranger}`));
  assert.match(set, /^emry_device=[0-9a-f-]{36}/);
});

test('guess rate limit returns 429 after 60 in a minute', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  for (let i = 0; i < 60; i += 1) {
    const res = await call('/api/guess', { method: 'POST', body: { guess: 'ZZZZZ' } });
    assert.equal(res.status, 400);
  }
  const blocked = await call('/api/guess', { method: 'POST', body: { guess: 'ZZZZZ' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
});

test('malformed JSON body returns 400, not 500', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  const res = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_json');
});

test('hint returns the curated clue once', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  await call('/api/attempt/start', { method: 'POST' });
  const hint = await call('/api/hint', { method: 'POST' });
  assert.equal(hint.status, 200);
  assert.equal(hint.body.tier, 1);
  assert.equal(hint.body.text, CLUE);
  assert.equal(hint.body.hints, 1);
});

test('leaderboard reports the solved attempt after a win', async () => {
  const { app } = makeApp();
  const call = makeClient(app);
  await call('/api/today');
  await call('/api/session', { method: 'POST', body: { name: 'Alex' } });
  await call('/api/attempt/start', { method: 'POST' });
  const win = await call('/api/guess', { method: 'POST', body: { guess: 'CLASS' } });
  assert.equal(win.body.solved, true);

  const day = await call('/api/leaderboard?range=day');
  assert.equal(day.status, 200);
  assert.deepEqual(day.body.rows.map((r) => r.name), ['Alex']);
  const week = await call('/api/leaderboard?range=week');
  assert.equal(week.body.weekStart, '2026-11-16');
  assert.deepEqual(week.body.rows.map((r) => r.name), ['Alex']);
  const month = await call('/api/leaderboard?range=month');
  assert.equal(month.body.month, '2026-11');
  assert.equal(month.body.fastest[0].name, 'Alex');
  assert.equal(month.body.streaks[0].streak, 1);
});
