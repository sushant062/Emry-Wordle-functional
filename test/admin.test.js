import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord, assignWordForDay } from '../src/words.js';
import { dayBoard } from '../src/leaderboard.js';
import { startRankedAttempt } from '../src/attempts.js';
import { createAdminRoutes } from '../src/admin.js';

const DAY = '2026-11-17';
const NOON = Date.UTC(2026, 10, 17, 18, 0);
const TOKEN = 'test-admin-token-0123456789abcdef';

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

function seedAttempt(db, { device = 'd1', name = 'Ana', day = DAY, elapsedMs = 30000, hints = 0 } = {}) {
  db.prepare('INSERT INTO devices (id, display_name, created_at) VALUES (?, ?, ?)').run(device, name, NOON);
  addPoolWord(db, { word: 'CLASS', hint: 'starts at eight whether you are ready or not' });
  assignWordForDay(db, day, NOON);
  const wordId = db.prepare('SELECT id FROM words WHERE day = ?').get(day).id;
  db.prepare(
    `INSERT INTO attempts (day, device_id, mode, word_id, started_at, finished_at, solved, guesses, hints,
       penalty_ms, elapsed_ms, suspicious, disqualified, created_at)
     VALUES (?, ?, 'ranked', ?, ?, ?, 1, '[]', ?, 0, ?, 0, 0, ?)`,
  ).run(day, device, wordId, NOON - elapsedMs, NOON, hints, elapsedMs, NOON);
}

function makeAdmin(db, token = TOKEN) {
  const routes = createAdminRoutes({ db, token });
  let cookie = '';
  const call = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    let body = init.body;
    if (body != null && typeof body !== 'string') {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(body);
    }
    const res = await routes.request(path, { ...init, headers, body });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: parsed, res };
  };
  return { routes, call };
}

test('admin routes reject requests without the token', async () => {
  const db = freshDb();
  const { call } = makeAdmin(db);
  const attempts = await call(`/api/admin/attempts?day=${DAY}`);
  assert.equal(attempts.status, 401);
  const words = await call('/api/admin/words', { method: 'POST', body: { word: 'BUNKS' } });
  assert.equal(words.status, 401);
  const csv = await call('/api/admin/export.csv');
  assert.equal(csv.status, 401);
});

test('correct token sets an httpOnly cookie', async () => {
  const db = freshDb();
  const { call } = makeAdmin(db);
  const bad = await call('/api/admin/login', { method: 'POST', body: { token: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  assert.equal(ok.status, 200);
  const set = ok.res.headers.get('set-cookie');
  assert.match(set, /^emry_admin=/);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  const authed = await call(`/api/admin/attempts?day=${DAY}`);
  assert.equal(authed.status, 200);
});

test('scheduling a word with a leaking clue returns 400 hint_leaks', async () => {
  const db = freshDb();
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const res = await call('/api/admin/words', {
    method: 'POST',
    body: { day: '2026-11-18', word: 'BUNKS', hint: 'the bunks are stacked' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'hint_leaks');
  const ok = await call('/api/admin/words', {
    method: 'POST',
    body: { day: '2026-11-18', word: 'BUNKS', hint: 'the ceiling is closer to one of them' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.word.word, 'BUNKS');
});

test('disqualify excludes from boards but keeps the row and the day locked', async () => {
  const db = freshDb();
  seedAttempt(db);
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const id = db.prepare('SELECT id FROM attempts').get().id;
  const res = await call(`/api/admin/attempts/${id}/disqualify`, {
    method: 'POST',
    body: { reason: 'pasted answer' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.disqualified, true);
  assert.equal(res.body.disqualifyReason, 'pasted answer');
  assert.deepEqual(dayBoard(db, DAY), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  const again = startRankedAttempt(db, { deviceId: 'd1', day: DAY, now: NOON });
  assert.equal(again.error, 'already_finished');
});

test('reinstate restores the row to the board', async () => {
  const db = freshDb();
  seedAttempt(db);
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const id = db.prepare('SELECT id FROM attempts').get().id;
  await call(`/api/admin/attempts/${id}/disqualify`, { method: 'POST', body: { reason: 'oops' } });
  const back = await call(`/api/admin/attempts/${id}/reinstate`, { method: 'POST' });
  assert.equal(back.status, 200);
  assert.equal(back.body.disqualified, false);
  assert.deepEqual(dayBoard(db, DAY).map((r) => r.name), ['Ana']);
});

test('CSV export quotes commas and newlines in names', async () => {
  const db = freshDb();
  seedAttempt(db, { name: 'Ana, "The Great"\nRA' });
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const res = await call('/api/admin/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.res.headers.get('content-type'), /text\/csv/);
  assert.match(res.res.headers.get('content-disposition'), /attachment; filename="emry-attempts.csv"/);
  const lines = res.body.split('\r\n');
  assert.equal(lines[0], 'day,device,name,elapsed_ms,hints,solved,disqualified');
  assert.equal(lines[1], `2026-11-17,d1,"Ana, ""The Great""\nRA",30000,0,1,0`);
});

test('CSV export neutralizes formula-like names', async () => {
  const db = freshDb();
  seedAttempt(db, { name: '-Eve' });
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const res = await call('/api/admin/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.body, /\n2026-11-17,d1,'-Eve,30000,0,1,0/);
});

test('14-day preview lists scheduled, pooled-pending, and dictionary fallback days', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO words (day, word, source, created_at) VALUES ('2026-11-17', 'CLASS', 'scheduled', ?)").run(NOON);
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });

  const fallback = await call('/api/admin/words?from=2026-11-17&days=3');
  assert.equal(fallback.status, 200);
  assert.deepEqual(
    fallback.body.days.map((d) => [d.day, d.status]),
    [
      ['2026-11-17', 'scheduled'],
      ['2026-11-18', 'auto'],
      ['2026-11-19', 'auto'],
    ],
  );
  assert.equal(fallback.body.days[0].word, 'CLASS');
  assert.equal(typeof fallback.body.days[0].id, 'number');

  addPoolWord(db, { word: 'RAMEN', hint: "a broke student's best friend" });
  const pooled = await call('/api/admin/words?from=2026-11-17&days=2');
  assert.deepEqual(
    pooled.body.days.map((d) => [d.day, d.status]),
    [
      ['2026-11-17', 'scheduled'],
      ['2026-11-18', 'pool'],
    ],
  );
});

test('admin page is served without the token', async () => {
  const db = freshDb();
  const { call } = makeAdmin(db);
  const page = await call('/admin');
  assert.equal(page.status, 200);
  assert.match(page.res.headers.get('content-type'), /text\/html/);
  assert.match(page.body, /Emry Wordle Admin/);
});

test('deleting a scheduled word that has been played is refused', async () => {
  const db = freshDb();
  seedAttempt(db);
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const id = db.prepare('SELECT id FROM words WHERE day = ?').get(DAY).id;
  const res = await call(`/api/admin/words/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'word_played');
});

test('renaming a device updates the board name', async () => {
  const db = freshDb();
  seedAttempt(db);
  const { call } = makeAdmin(db);
  await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
  const res = await call('/api/admin/devices/d1/name', { method: 'POST', body: { name: 'Alexandra' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Alexandra');
  assert.equal(db.prepare('SELECT display_name FROM devices WHERE id = ?').get('d1').display_name, 'Alexandra');
  assert.deepEqual(dayBoard(db, DAY).map((r) => r.name), ['Alexandra']);
});
