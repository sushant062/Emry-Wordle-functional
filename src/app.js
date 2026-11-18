import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { getCookie, setCookie } from 'hono/cookie';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { centralDay, weekStart } from './time.js';
import { assignWordForDay, getWordForDay, getWordById } from './words.js';
import { elapsedFor, getTodayState, nextHint, startRankedAttempt, submitGuess } from './attempts.js';
import { dayBoard, hallOfFame, monthBoard, weekBoard } from './leaderboard.js';
import { validateName } from './names.js';
import { isValidGuess, loadWordSets, scoreGuess } from './game.js';
import { createRateLimiter } from './ratelimit.js';
import { createAdminRoutes } from './admin.js';

export const DEVICE_COOKIE = 'emry_device';
const PRACTICE_MAX_GUESSES = 60;
const YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const LONG_CACHE = 'public, max-age=31536000, immutable';
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8', 'no-store']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8', 'no-store']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8', LONG_CACHE]],
  ['/app.css', ['app.css', 'text/css; charset=utf-8', LONG_CACHE]],
  ['/icon.svg', ['icon.svg', 'image/svg+xml', LONG_CACHE]],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=3600']],
]);

const STATUS = {
  bad_json: 400,
  name_required: 400,
  name_too_long: 400,
  name_invalid: 400,
  invalid_word: 400,
  no_attempt: 409,
  already_finished: 409,
  day_over: 409,
  not_started: 409,
  finished: 409,
  max_hints: 409,
  no_practice_word: 409,
  no_practice: 404,
  today_word: 409,
  no_word: 503,
};

function statusFor(error) {
  return STATUS[error] ?? 400;
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createApp({
  db,
  now = () => Date.now(),
  secureCookies = process.env.NODE_ENV === 'production',
  adminToken = process.env.ADMIN_TOKEN ?? '',
}) {
  const app = new Hono();
  app.use('*', compress());
  const guessLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, now });
  const startLimiter = createRateLimiter({ limit: 10, windowMs: 60_000, now });
  let allowed = null;
  const allowedWords = () => {
    if (!allowed) allowed = loadWordSets().allowed;
    return allowed;
  };

  async function readJson(c) {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  const deviceId = (c) => c.get('deviceId');
  const today = () => centralDay(now());

  for (const [route, [file, type, cache]] of STATIC_FILES) {
    app.get(route, (c) => {
      try {
        const body = readFileSync(join(PUBLIC_DIR, file), 'utf8');
        c.header('content-type', type);
        c.header('cache-control', cache);
        return c.body(body);
      } catch {
        return c.text('not found', 404);
      }
    });
  }

  app.get('/share.js', (c) => {
    try {
      const body = readFileSync(join(SRC_DIR, 'share.js'), 'utf8');
      c.header('content-type', 'text/javascript; charset=utf-8');
      c.header('cache-control', LONG_CACHE);
      return c.body(body);
    } catch {
      return c.text('not found', 404);
    }
  });

  function ensureWord(day) {
    return getWordForDay(db, day) ?? assignWordForDay(db, day, now());
  }

  function attemptView(attempt) {
    if (!attempt) return null;
    return {
      day: attempt.day,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      solved: Boolean(attempt.solved),
      guesses: typeof attempt.guesses === 'string' ? parseJson(attempt.guesses) : (attempt.guesses ?? []),
      hints: attempt.hints,
      penaltyMs: attempt.penalty_ms,
      elapsedMs: elapsedFor(attempt, now()),
      suspicious: Boolean(attempt.suspicious),
      disqualified: Boolean(attempt.disqualified),
    };
  }

  function nameSuggestions() {
    return db
      .prepare(
        `SELECT display_name AS name, COUNT(*) AS uses
         FROM devices
         WHERE display_name IS NOT NULL
         GROUP BY display_name
         ORDER BY uses DESC, display_name ASC
         LIMIT 20`,
      )
      .all()
      .map((row) => row.name);
  }

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/admin')) return next();
    const incoming = getCookie(c, DEVICE_COOKIE);
    let id = null;
    if (incoming && UUID_RE.test(incoming)) {
      const row = db.prepare('SELECT id FROM devices WHERE id = ?').get(incoming);
      if (row) id = row.id;
    }
    if (id) {
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), id);
    } else {
      id = crypto.randomUUID();
      db.prepare('INSERT INTO devices (id, created_at, last_seen) VALUES (?, ?, ?)').run(id, now(), now());
      setCookie(c, DEVICE_COOKIE, id, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: secureCookies,
        path: '/',
        maxAge: YEAR_SECONDS,
      });
    }
    c.set('deviceId', id);
    await next();
  });

  app.get('/api/today', (c) => {
    const day = today();
    ensureWord(day);
    const state = getTodayState(db, { deviceId: deviceId(c), day });
    return c.json({
      status: 'ok',
      day,
      wordLength: 5,
      attempt: attemptView(state.attempt),
      played: state.played,
      names: nameSuggestions(),
      serverNow: now(),
    });
  });

  app.post('/api/session', async (c) => {
    if (!startLimiter.check(deviceId(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const name = validateName(body.name);
    if (!name.ok) return c.json({ error: name.error }, statusFor(name.error));
    db.prepare('UPDATE devices SET display_name = ?, name_norm = ?, last_seen = ? WHERE id = ?').run(
      name.display,
      name.norm,
      now(),
      deviceId(c),
    );
    return c.json({ name: name.display });
  });

  app.post('/api/attempt/start', async (c) => {
    if (!startLimiter.check(deviceId(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const day = today();
    if (!ensureWord(day)) return c.json({ error: 'no_word' }, 503);
    const result = startRankedAttempt(db, { deviceId: deviceId(c), day, now: now() });
    if (result.error) {
      const payload = { error: result.error };
      if (result.error === 'already_finished') {
        const state = getTodayState(db, { deviceId: deviceId(c), day });
        payload.attempt = attemptView(state.attempt);
      }
      return c.json(payload, statusFor(result.error));
    }
    return c.json({ attempt: attemptView(result.attempt), created: result.created });
  });

  app.post('/api/guess', async (c) => {
    if (!guessLimiter.check(deviceId(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const result = submitGuess(db, { deviceId: deviceId(c), guess: body.guess, now: now() });
    if (result.error) return c.json({ error: result.error }, statusFor(result.error));
    return c.json({
      results: result.results,
      solved: result.solved,
      finished: result.finished,
      remaining: result.remaining,
      elapsedMs: result.elapsedMs,
    });
  });

  app.post('/api/hint', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const result = nextHint(db, { deviceId: deviceId(c), now: now() });
    if (result.error) return c.json({ error: result.error }, statusFor(result.error));
    return c.json(result);
  });

  app.get('/api/leaderboard', (c) => {
    const day = today();
    const range = c.req.query('range') ?? 'day';
    if (range === 'week') {
      const start = weekStart(day);
      return c.json({ range, day, weekStart: start, rows: weekBoard(db, start) });
    }
    if (range === 'month') {
      const month = day.slice(0, 7);
      const board = monthBoard(db, month);
      return c.json({
        range,
        day,
        month,
        fastest: board.fastest,
        streaks: board.streaks,
        hallOfFame: hallOfFame(db, 6, now()),
      });
    }
    return c.json({ range: 'day', day, rows: dayBoard(db, day) });
  });

  app.post('/api/practice/start', async (c) => {
    if (!startLimiter.check(deviceId(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const day = today();
    const todayWord = getWordForDay(db, day);
    const row = db
      .prepare(
        'SELECT id FROM words WHERE day IS NOT NULL AND day < ? AND word != ? ORDER BY RANDOM() LIMIT 1',
      )
      .get(day, todayWord?.word ?? '');
    if (!row) return c.json({ error: 'no_practice_word' }, 409);
    const info = db
      .prepare(
        `INSERT INTO attempts (day, device_id, mode, word_id, started_at, guesses, created_at)
         VALUES (?, ?, 'practice', ?, ?, '[]', ?)`,
      )
      .run(day, deviceId(c), row.id, now(), now());
    return c.json({ practiceId: info.lastInsertRowid, wordLength: 5 }, 201);
  });

  app.post('/api/practice/guess', async (c) => {
    if (!guessLimiter.check(deviceId(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const attempt = db
      .prepare("SELECT * FROM attempts WHERE id = ? AND device_id = ? AND mode = 'practice'")
      .get(body.practiceId, deviceId(c));
    if (!attempt) return c.json({ error: 'no_practice' }, 404);
    if (attempt.finished_at != null) return c.json({ error: 'already_finished' }, 409);

    const raw = typeof body.guess === 'string' ? body.guess : '';
    const upper = raw.toUpperCase();
    if (!/^[A-Z]{5}$/.test(raw) || !isValidGuess(upper, allowedWords())) {
      return c.json({ error: 'invalid_word' }, 400);
    }

    const word = getWordById(db, attempt.word_id);
    if (!word) return c.json({ error: 'no_word' }, 503);
    const todayWord = getWordForDay(db, today());
    if (todayWord && word.word === todayWord.word) return c.json({ error: 'today_word' }, 409);

    const guesses = parseJson(attempt.guesses);
    if (guesses.length >= PRACTICE_MAX_GUESSES) return c.json({ error: 'already_finished' }, 409);

    const results = scoreGuess(upper, word.word);
    guesses.push({ word: upper, results });
    const solved = upper === word.word;
    const finished = solved || guesses.length >= PRACTICE_MAX_GUESSES;
    db.prepare('UPDATE attempts SET guesses = ?, solved = ?, finished_at = ? WHERE id = ?').run(
      JSON.stringify(guesses),
      solved ? 1 : 0,
      finished ? now() : null,
      attempt.id,
    );

    return c.json({
      results,
      solved,
      finished,
      remaining: PRACTICE_MAX_GUESSES - guesses.length,
    });
  });

  app.route('/', createAdminRoutes({ db, token: adminToken, secureCookies, now }));

  return app;
}
