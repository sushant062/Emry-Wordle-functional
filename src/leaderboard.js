import { centralDay } from './time.js';

const SOLVED_FILTER = "a.mode = 'ranked' AND a.solved = 1 AND a.disqualified = 0";

function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const monthIndex = ((total % 12) + 12) % 12;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function bestPerDevice(db, where, params) {
  return db
    .prepare(
      `SELECT deviceId, name, elapsedMs, hints, finishedAt
       FROM (
         SELECT a.device_id AS deviceId,
                COALESCE(d.display_name, 'Player') AS name,
                a.elapsed_ms AS elapsedMs,
                a.hints AS hints,
                a.finished_at AS finishedAt,
                a.day AS day,
                ROW_NUMBER() OVER (
                  PARTITION BY a.device_id
                  ORDER BY a.elapsed_ms, a.hints, a.finished_at, a.day
                ) AS rn
         FROM attempts a
         JOIN devices d ON d.id = a.device_id
         WHERE ${SOLVED_FILTER} AND ${where}
       )
       WHERE rn = 1
       ORDER BY elapsedMs, hints, finishedAt`,
    )
    .all(...params);
}

export function dayBoard(db, day) {
  return bestPerDevice(db, 'a.day = ?', [day]);
}

export function weekBoard(db, weekStartDay) {
  return bestPerDevice(db, 'a.day BETWEEN ? AND ?', [weekStartDay, addDays(weekStartDay, 6)]);
}

function betterSolve(a, b) {
  if (!b) return true;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs < b.elapsedMs;
  if (a.hints !== b.hints) return a.hints < b.hints;
  return a.finishedAt < b.finishedAt;
}

export function monthBoard(db, month) {
  const fastest = bestPerDevice(db, 'substr(a.day, 1, 7) = ?', [month]);

  const rows = db
    .prepare(
      `SELECT a.device_id AS deviceId,
              COALESCE(d.display_name, 'Player') AS name,
              a.day AS day,
              a.elapsed_ms AS elapsedMs,
              a.hints AS hints,
              a.finished_at AS finishedAt
       FROM attempts a
       JOIN devices d ON d.id = a.device_id
       WHERE ${SOLVED_FILTER} AND substr(a.day, 1, 7) = ?
       ORDER BY a.device_id, a.day`,
    )
    .all(month);

  const byDevice = new Map();
  for (const row of rows) {
    let entry = byDevice.get(row.deviceId);
    if (!entry) {
      entry = { deviceId: row.deviceId, name: row.name, days: [], best: null };
      byDevice.set(row.deviceId, entry);
    }
    entry.days.push(row.day);
    const solve = { elapsedMs: row.elapsedMs, hints: row.hints, finishedAt: row.finishedAt };
    if (betterSolve(solve, entry.best)) entry.best = solve;
  }

  const streaks = [];
  for (const entry of byDevice.values()) {
    const days = [...new Set(entry.days)].sort();
    let longest = 0;
    let current = 0;
    let previous = null;
    for (const day of days) {
      current = previous && addDays(previous, 1) === day ? current + 1 : 1;
      previous = day;
      if (current > longest) longest = current;
    }
    streaks.push({ deviceId: entry.deviceId, name: entry.name, streak: longest, ...entry.best });
  }

  streaks.sort(
    (a, b) =>
      b.streak - a.streak ||
      a.elapsedMs - b.elapsedMs ||
      a.hints - b.hints ||
      a.finishedAt - b.finishedAt,
  );

  return { fastest, streaks };
}

export function hallOfFame(db, months, now = Date.now()) {
  const current = centralDay(now).slice(0, 7);
  const out = [];
  for (let i = 1; i <= months; i += 1) {
    const month = shiftMonth(current, -i);
    const board = monthBoard(db, month);
    if (board.streaks.length === 0) continue;
    out.push({ month, ...board.streaks[0] });
  }
  return out;
}
