import { loadWordSets } from './game.js';
import { centralDay, nextCentralMidnight } from './time.js';

const COOLDOWN_DAYS = 180;
const WORD_RE = /^[A-Z]{5}$/;

function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function hintLeaksAnswer(hint, word) {
  const cleanWord = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const cleanHint = String(hint ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!cleanWord || !cleanHint) return false;
  if (cleanHint.includes(cleanWord)) return true;
  const stem = cleanWord.slice(0, 4);
  return stem.length === 4 && cleanHint.includes(stem);
}

export function getWordForDay(db, day) {
  return db.prepare('SELECT id, day, word, hint, source FROM words WHERE day = ?').get(day);
}

export function getWordById(db, id) {
  return db.prepare('SELECT id, day, word, hint, source FROM words WHERE id = ?').get(id);
}

export function addPoolWord(db, { word, hint = null }) {
  const upper = String(word ?? '').trim().toUpperCase();
  if (!WORD_RE.test(upper)) throw new Error('invalid_word');
  if (hint != null && hintLeaksAnswer(hint, upper)) throw new Error('hint_leaks');
  const existing = db.prepare("SELECT id FROM words WHERE word = ? AND day IS NULL").get(upper);
  if (existing) return getWordById(db, existing.id);
  const info = db
    .prepare("INSERT INTO words (day, word, hint, source, created_at) VALUES (NULL, ?, ?, 'pool', ?)")
    .run(upper, hint, Date.now());
  return getWordById(db, info.lastInsertRowid);
}

export function scheduleWord(db, { day, word, hint = null }) {
  const upper = String(word ?? '').trim().toUpperCase();
  if (!WORD_RE.test(upper)) throw new Error('invalid_word');
  if (hint != null && hintLeaksAnswer(hint, upper)) throw new Error('hint_leaks');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) throw new Error('invalid_day');
  const played = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE day = ?').get(day).n;
  if (played > 0) throw new Error('day_played');
  const existing = getWordForDay(db, day);
  if (existing) {
    db.prepare("UPDATE words SET word = ?, hint = ?, source = 'scheduled' WHERE id = ?").run(upper, hint, existing.id);
    return getWordForDay(db, day);
  }
  const info = db
    .prepare("INSERT INTO words (day, word, hint, source, created_at) VALUES (?, ?, ?, 'scheduled', ?)")
    .run(day, upper, hint, Date.now());
  return getWordById(db, info.lastInsertRowid);
}

export function assignWordForDay(db, day, now = Date.now(), options = {}) {
  const already = getWordForDay(db, day);
  if (already) return already;

  const answers = options.answers ?? loadWordSets().answers;
  const cutoff = addDays(day, -COOLDOWN_DAYS);

  const assign = db.transaction(() => {
    const raced = getWordForDay(db, day);
    if (raced) return raced;

    const poolRow = db
      .prepare(
        `SELECT id FROM words
         WHERE day IS NULL
           AND word NOT IN (SELECT word FROM words WHERE day IS NOT NULL AND day > ? AND day < ?)
         ORDER BY RANDOM() LIMIT 1`,
      )
      .get(cutoff, day);
    if (poolRow) {
      db.prepare("UPDATE words SET day = ?, source = 'pool' WHERE id = ?").run(day, poolRow.id);
      return getWordById(db, poolRow.id);
    }

    const used = new Set(
      db
        .prepare('SELECT word FROM words WHERE day IS NOT NULL AND day > ? AND day < ?')
        .all(cutoff, day)
        .map((row) => row.word),
    );
    const fresh = answers.filter((word) => !used.has(word));
    const candidates = fresh.length > 0 ? fresh : answers;
    if (candidates.length === 0) return null;

    const word = candidates[Math.floor(Math.random() * candidates.length)];
    const info = db
      .prepare("INSERT INTO words (day, word, hint, source, created_at) VALUES (?, ?, NULL, 'auto', ?)")
      .run(day, word, now);
    return getWordById(db, info.lastInsertRowid);
  });

  try {
    return assign();
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) return getWordForDay(db, day);
    throw error;
  }
}

export function previewDays(db, fromDay, count, options = {}) {
  const answers = options.answers ?? loadWordSets().answers;
  const poolCount = db.prepare('SELECT COUNT(*) AS n FROM words WHERE day IS NULL').get().n;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const day = addDays(fromDay, i);
    const row = getWordForDay(db, day);
    if (row) {
      out.push({
        id: row.id,
        day,
        status: row.source === 'scheduled' ? 'scheduled' : row.source,
        word: row.word,
        hint: row.hint,
      });
    } else if (poolCount > 0) {
      out.push({ day, status: 'pool', word: null });
    } else if (answers.length > 0) {
      out.push({ day, status: 'auto', word: null });
    } else {
      out.push({ day, status: 'missing', word: null });
    }
  }
  return out;
}

export function startScheduler(db, options = {}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let stopped = false;
  let timer = null;

  const fire = () => {
    const today = centralDay(now());
    const max = db.prepare('SELECT MAX(day) AS day FROM words WHERE day IS NOT NULL').get().day;
    let cursor = today;
    if (max && max < today) cursor = addDays(max, 1);
    for (let day = cursor; day <= today; day = addDays(day, 1)) {
      if (!getWordForDay(db, day)) assignWordForDay(db, day, now(), options);
    }
    if (!getWordForDay(db, today)) assignWordForDay(db, today, now(), options);
  };

  const arm = () => {
    if (stopped) return;
    const delay = Math.max(1000, nextCentralMidnight(now()) - now() + 250);
    timer = setTimer(() => {
      fire();
      arm();
    }, delay);
  };

  const stop = () => {
    stopped = true;
    if (timer != null) clearTimer(timer);
  };

  arm();

  return { fire, arm, stop };
}
