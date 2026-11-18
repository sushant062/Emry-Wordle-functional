import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { dayBoard, weekBoard, monthBoard, hallOfFame } from '../src/leaderboard.js';

const NOW = Date.UTC(2026, 10, 17, 18, 0);

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

function addDevice(db, id, name) {
  db.prepare('INSERT INTO devices (id, display_name, created_at) VALUES (?, ?, ?)').run(id, name, NOW);
}

function wordId(db, day) {
  const existing = db.prepare('SELECT id FROM words WHERE day = ?').get(day);
  if (existing) return existing.id;
  const info = db
    .prepare("INSERT INTO words (day, word, source, created_at) VALUES (?, 'CLASS', 'auto', ?)")
    .run(day, NOW);
  return info.lastInsertRowid;
}

function addAttempt(db, opts) {
  const {
    device,
    day,
    elapsedMs = 30000,
    hints = 0,
    solved = true,
    mode = 'ranked',
    disqualified = false,
    finishedAt = NOW,
  } = opts;
  db.prepare(
    `INSERT INTO attempts (day, device_id, mode, word_id, started_at, finished_at, solved, guesses, hints,
       penalty_ms, elapsed_ms, suspicious, disqualified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, 0, ?, ?)`,
  ).run(day, device, mode, wordId(db, day), finishedAt - elapsedMs, finishedAt, solved ? 1 : 0, hints, elapsedMs, disqualified ? 1 : 0, NOW);
}

test('day board keeps the fastest solve per device and excludes disqualified', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addDevice(db, 'd2', 'Ben');
  addDevice(db, 'd3', 'Cy');
  addDevice(db, 'd4', 'Di');
  addAttempt(db, { device: 'd1', day: '2026-11-17', elapsedMs: 30000 });
  addAttempt(db, { device: 'd2', day: '2026-11-17', elapsedMs: 20000 });
  addAttempt(db, { device: 'd3', day: '2026-11-17', elapsedMs: 10000, disqualified: true });
  addAttempt(db, { device: 'd2', day: '2026-11-17', elapsedMs: 9000, mode: 'practice' });
  addAttempt(db, { device: 'd4', day: '2026-11-17', elapsedMs: 8000, solved: false });

  const rows = dayBoard(db, '2026-11-17');
  assert.deepEqual(
    rows.map((r) => [r.name, r.elapsedMs]),
    [
      ['Ben', 20000],
      ['Ana', 30000],
    ],
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), ['deviceId', 'elapsedMs', 'finishedAt', 'hints', 'name']);
});

test('week board compares fastest single solves across days', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addDevice(db, 'd2', 'Ben');
  addDevice(db, 'd3', 'Cy');
  addAttempt(db, { device: 'd1', day: '2026-11-17', elapsedMs: 25000 });
  addAttempt(db, { device: 'd1', day: '2026-11-18', elapsedMs: 15000 });
  addAttempt(db, { device: 'd2', day: '2026-11-16', elapsedMs: 18000 });
  addAttempt(db, { device: 'd3', day: '2026-11-15', elapsedMs: 5000 });

  const rows = weekBoard(db, '2026-11-16');
  assert.deepEqual(
    rows.map((r) => [r.name, r.elapsedMs]),
    [
      ['Ana', 15000],
      ['Ben', 18000],
    ],
  );
});

test('ties break on fewer hints, then earlier finish', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addDevice(db, 'd2', 'Ben');
  addDevice(db, 'd5', 'Eve');
  addAttempt(db, { device: 'd1', day: '2026-11-17', elapsedMs: 20000, hints: 1, finishedAt: 1000 });
  addAttempt(db, { device: 'd2', day: '2026-11-17', elapsedMs: 20000, hints: 0, finishedAt: 2000 });
  addAttempt(db, { device: 'd5', day: '2026-11-18', elapsedMs: 20000, hints: 0, finishedAt: 1500 });

  const rows = weekBoard(db, '2026-11-16');
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Eve', 'Ben', 'Ana'],
  );
  const ties = dayBoard(db, '2026-11-17');
  assert.deepEqual(
    ties.map((r) => r.name),
    ['Ben', 'Ana'],
  );
});

test('month streaks count consecutive solved days within the month only', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addDevice(db, 'd2', 'Ben');
  addDevice(db, 'd3', 'Cy');
  for (const day of ['2026-11-03', '2026-11-04', '2026-11-05']) {
    addAttempt(db, { device: 'd1', day, elapsedMs: 30000 });
  }
  for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']) {
    addAttempt(db, { device: 'd2', day, elapsedMs: 26000 });
  }
  // streak that spans the month boundary is cut off at the boundary
  for (const day of ['2026-10-31', '2026-11-01', '2026-11-02']) {
    addAttempt(db, { device: 'd3', day, elapsedMs: 20000 });
  }

  const board = monthBoard(db, '2026-11');
  assert.deepEqual(
    board.streaks.map((r) => [r.name, r.streak]),
    [
      ['Ben', 5],
      ['Ana', 3],
      ['Cy', 2],
    ],
  );
  assert.equal(board.fastest[0].name, 'Cy');
  assert.equal(board.fastest[0].elapsedMs, 20000);
});

test('failed days do not extend a streak', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addAttempt(db, { device: 'd1', day: '2026-11-03', elapsedMs: 30000 });
  addAttempt(db, { device: 'd1', day: '2026-11-04', elapsedMs: 30000 });
  addAttempt(db, { device: 'd1', day: '2026-11-05', elapsedMs: 30000, solved: false });
  addAttempt(db, { device: 'd1', day: '2026-11-06', elapsedMs: 30000 });
  addAttempt(db, { device: 'd1', day: '2026-11-07', elapsedMs: 30000 });

  const board = monthBoard(db, '2026-11');
  assert.equal(board.streaks.length, 1);
  assert.equal(board.streaks[0].streak, 2);
});

test('practice attempts never appear', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addAttempt(db, { device: 'd1', day: '2026-11-17', elapsedMs: 5000, mode: 'practice' });
  assert.deepEqual(dayBoard(db, '2026-11-17'), []);
  assert.deepEqual(weekBoard(db, '2026-11-16'), []);
  const board = monthBoard(db, '2026-11');
  assert.deepEqual(board.fastest, []);
  assert.deepEqual(board.streaks, []);
});

test('hall of fame reports past months, newest first', () => {
  const db = freshDb();
  addDevice(db, 'd1', 'Ana');
  addDevice(db, 'd2', 'Ben');
  for (const day of ['2026-11-10', '2026-11-11', '2026-11-12']) {
    addAttempt(db, { device: 'd1', day, elapsedMs: 30000 });
  }
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
    addAttempt(db, { device: 'd2', day, elapsedMs: 25000 });
  }
  for (const day of ['2026-09-01', '2026-09-02']) {
    addAttempt(db, { device: 'd2', day, elapsedMs: 25000 });
  }

  const months = hallOfFame(db, 2, Date.UTC(2026, 11, 15, 18, 0));
  assert.deepEqual(
    months.map((m) => [m.month, m.name, m.streak]),
    [
      ['2026-11', 'Ana', 3],
      ['2026-10', 'Ben', 4],
    ],
  );
});
