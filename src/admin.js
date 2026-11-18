import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPoolWord, previewDays, scheduleWord } from './words.js';
import { validateName } from './names.js';
import { centralDay } from './time.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = join(HERE, '..', 'public', 'admin.html');
export const ADMIN_COOKIE = 'emry_admin';

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseGuesses(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function attemptView(row) {
  return {
    id: row.id,
    day: row.day,
    deviceId: row.device_id,
    name: row.display_name ?? 'Player',
    mode: row.mode,
    elapsedMs: row.elapsed_ms,
    hints: row.hints,
    solved: Boolean(row.solved),
    suspicious: Boolean(row.suspicious),
    disqualified: Boolean(row.disqualified),
    disqualifyReason: row.disqualify_reason,
    guesses: typeof row.guesses === 'string' ? parseGuesses(row.guesses) : (row.guesses ?? []),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

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

const STATUS = {
  bad_json: 400,
  invalid_word: 400,
  invalid_day: 400,
  hint_leaks: 400,
  name_required: 400,
  name_too_long: 400,
  name_invalid: 400,
  day_played: 409,
  word_played: 409,
};

export function createAdminRoutes({ db, token, secureCookies = process.env.NODE_ENV === 'production', now = () => Date.now() }) {  const app = new Hono();

  app.use('/api/admin/*', async (c, next) => {
    if (c.req.path === '/api/admin/login') return next();
    const cookie = getCookie(c, ADMIN_COOKIE);
    if (!token || !sameToken(cookie, token)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/admin', (c) => {
    try {
      return c.html(readFileSync(ADMIN_HTML, 'utf8'));
    } catch {
      return c.text('admin page missing', 503);
    }
  });

  app.post('/api/admin/login', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    if (!token || !sameToken(body.token, token)) return c.json({ error: 'unauthorized' }, 401);
    setCookie(c, ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: secureCookies,
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return c.json({ ok: true });
  });

  app.get('/api/admin/words', (c) => {
    const from = c.req.query('from') ?? centralDay(now());
    const requested = Number(c.req.query('days') ?? 14);
    const days = Number.isFinite(requested) ? Math.min(60, Math.max(1, Math.trunc(requested))) : 14;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return c.json({ error: 'invalid_day' }, 400);
    return c.json({ from, days: previewDays(db, from, days) });
  });

  app.post('/api/admin/words', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    try {
      const row = body.day
        ? scheduleWord(db, { day: body.day, word: body.word, hint: body.hint ?? null })
        : addPoolWord(db, { word: body.word, hint: body.hint ?? null });
      return c.json({ word: row }, 201);
    } catch (error) {
      const code = String(error?.message ?? 'invalid_word');
      return c.json({ error: code }, STATUS[code] ?? 400);
    }
  });

  app.delete('/api/admin/words/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400);
    const used = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE word_id = ?').get(id).n;
    if (used > 0) return c.json({ error: 'word_played' }, 409);
    const info = db.prepare('DELETE FROM words WHERE id = ?').run(id);
    if (info.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ deleted: true });
  });

  app.get('/api/admin/attempts', (c) => {
    const day = c.req.query('day') ?? centralDay(now());
    const rows = db
      .prepare(
        `SELECT a.*, d.display_name
         FROM attempts a
         JOIN devices d ON d.id = a.device_id
         WHERE a.day = ?
         ORDER BY a.mode DESC, a.elapsed_ms IS NULL, a.elapsed_ms, a.id`,
      )
      .all(day);
    return c.json({ day, attempts: rows.map(attemptView) });
  });

  const setDisqualified = (id, reason) => {
    db.prepare('UPDATE attempts SET disqualified = 1, disqualify_reason = ? WHERE id = ?').run(reason, id);
    const row = db
      .prepare(
        `SELECT a.*, d.display_name FROM attempts a JOIN devices d ON d.id = a.device_id WHERE a.id = ?`,
      )
      .get(id);
    return row ? attemptView(row) : null;
  };

  app.post('/api/admin/attempts/:id/disqualify', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : null;
    const row = setDisqualified(Number(c.req.param('id')), reason);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  });

  app.post('/api/admin/attempts/:id/reinstate', (c) => {
    db.prepare('UPDATE attempts SET disqualified = 0, disqualify_reason = NULL WHERE id = ?').run(
      Number(c.req.param('id')),
    );
    const row = db
      .prepare(
        `SELECT a.*, d.display_name FROM attempts a JOIN devices d ON d.id = a.device_id WHERE a.id = ?`,
      )
      .get(Number(c.req.param('id')));
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(attemptView(row));
  });

  app.post('/api/admin/devices/:id/name', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const name = validateName(body.name);
    if (!name.ok) return c.json({ error: name.error }, STATUS[name.error] ?? 400);
    const info = db
      .prepare('UPDATE devices SET display_name = ?, name_norm = ? WHERE id = ?')
      .run(name.display, name.norm, c.req.param('id'));
    if (info.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ id: c.req.param('id'), name: name.display });
  });

  app.get('/api/admin/export.csv', (c) => {
    const rows = db
      .prepare(
        `SELECT a.day, a.device_id, d.display_name, a.elapsed_ms, a.hints, a.solved, a.disqualified
         FROM attempts a
         JOIN devices d ON d.id = a.device_id
         ORDER BY a.day, a.id`,
      )
      .all();
    const lines = ['day,device,name,elapsed_ms,hints,solved,disqualified'];
    for (const row of rows) {
      lines.push(
        [
          row.day,
          row.device_id,
          row.display_name ?? '',
          row.elapsed_ms ?? '',
          row.hints,
          row.solved,
          row.disqualified,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="emry-attempts.csv"');
    return c.body(`${lines.join('\r\n')}\r\n`);
  });

  return app;
}
