import { scoreGuess, isValidGuess, loadWordSets } from './game.js';
import { centralDay } from './time.js';
import { getWordById, getWordForDay } from './words.js';

export const MAX_GUESSES = 6;
const SUSPICIOUS_MS = 1200;

let wordSets = null;
function allowedWords() {
  if (!wordSets) wordSets = loadWordSets().allowed;
  return wordSets;
}

function parseGuesses(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function elapsedFor(attempt, now = Date.now()) {
  if (!attempt || attempt.started_at == null) return 0;
  const end = attempt.finished_at ?? now;
  return Math.max(0, end - attempt.started_at + (attempt.penalty_ms ?? 0));
}

function findRanked(db, deviceId, day) {
  return db
    .prepare("SELECT * FROM attempts WHERE device_id = ? AND day = ? AND mode = 'ranked'")
    .get(deviceId, day);
}

function openRanked(db, deviceId) {
  return db
    .prepare(
      "SELECT * FROM attempts WHERE device_id = ? AND mode = 'ranked' AND finished_at IS NULL ORDER BY day DESC LIMIT 1",
    )
    .get(deviceId);
}

export function startRankedAttempt(db, { deviceId, day, now = Date.now() }) {
  if (!deviceId) return { error: 'device_required' };
  const today = centralDay(now);
  if (day !== today) return { error: 'day_over' };

  const existing = findRanked(db, deviceId, day);
  if (existing) {
    if (existing.finished_at != null) return { error: 'already_finished' };
    return { attempt: existing, created: false };
  }

  const open = openRanked(db, deviceId);
  if (open && open.day !== day) return { error: 'day_over' };

  const word = getWordForDay(db, day);
  if (!word) return { error: 'no_word' };

  const insert = db.transaction(() => {
    const raced = findRanked(db, deviceId, day);
    if (raced) return raced.finished_at != null ? null : raced;
    const info = db
      .prepare(
        `INSERT INTO attempts (day, device_id, mode, word_id, started_at, guesses, created_at)
         VALUES (?, ?, 'ranked', ?, ?, '[]', ?)`,
      )
      .run(day, deviceId, word.id, now, now);
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(info.lastInsertRowid);
  });

  const attempt = insert();
  if (!attempt) return { error: 'already_finished' };
  return { attempt, created: true };
}

export function submitGuess(db, { deviceId, guess, now = Date.now() }) {
  const today = centralDay(now);
  const raw = typeof guess === 'string' ? guess : '';
  const upper = raw.toUpperCase();

  if (!/^[A-Z]{5}$/.test(raw) || !isValidGuess(upper, allowedWords())) {
    return { error: 'invalid_word' };
  }

  const attempt = openRanked(db, deviceId);
  if (!attempt) {
    const finishedToday = findRanked(db, deviceId, today);
    return { error: finishedToday?.finished_at != null ? 'already_finished' : 'no_attempt' };
  }
  if (attempt.day !== today) return { error: 'day_over' };

  const word = getWordById(db, attempt.word_id);
  if (!word) return { error: 'no_word' };

  const guesses = parseGuesses(attempt.guesses);
  if (guesses.length >= MAX_GUESSES) return { error: 'already_finished' };

  const results = scoreGuess(upper, word.word);
  guesses.push({ word: upper, results });
  const solved = upper === word.word;
  const finished = solved || guesses.length >= MAX_GUESSES;

  const write = db.transaction(() => {
    const finishedAt = finished ? now : null;
    db.prepare('UPDATE attempts SET guesses = ?, finished_at = ?, solved = ?, elapsed_ms = ? WHERE id = ?').run(
      JSON.stringify(guesses),
      finishedAt,
      solved ? 1 : 0,
      finished ? elapsedFor({ ...attempt, finished_at: finishedAt }, now) : null,
      attempt.id,
    );
    if (finished) {
      const elapsed = elapsedFor({ ...attempt, finished_at: finishedAt }, now);
      db.prepare('UPDATE attempts SET suspicious = ? WHERE id = ?').run(elapsed < SUSPICIOUS_MS ? 1 : 0, attempt.id);
    }
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt.id);
  });

  const updated = write();
  return {
    results,
    solved,
    finished,
    elapsedMs: elapsedFor(updated, now),
    remaining: MAX_GUESSES - guesses.length,
    guesses,
  };
}

export function getTodayState(db, { deviceId, day }) {
  if (!deviceId) return { attempt: null, played: false };
  const attempt = findRanked(db, deviceId, day);
  if (!attempt) return { attempt: null, played: false };
  return { attempt: { ...attempt, guesses: parseGuesses(attempt.guesses) }, played: true };
}
