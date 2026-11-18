// Local preview: an in-memory database seeded from data/seed.json, no env setup.
// Run with `npm run dev`, then open http://localhost:3999
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord, assignWordForDay, scheduleWord } from '../src/words.js';
import { centralDay } from '../src/time.js';
import { createApp } from '../src/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3999);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'devtoken';

const db = openDb(':memory:');
migrate(db);

for (const { word, hint } of JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'))) {
  addPoolWord(db, { word, hint: hint ?? null });
}

const now = Date.now();
const today = centralDay(now);
assignWordForDay(db, today, now);

// Give yesterday a word so practice and the board views have something to show.
scheduleWord(db, {
  day: centralDay(now - 86400000),
  word: 'CLASS',
  hint: 'starts at eight whether you are ready or not',
});

const app = createApp({ db, adminToken: ADMIN_TOKEN });
const todayWord = db.prepare('SELECT word FROM words WHERE day = ?').get(today)?.word;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`dev server on http://localhost:${info.port}`);
  console.log(`today (${today}) word: ${todayWord}`);
  console.log(`admin: http://localhost:${info.port}/admin (token: ${ADMIN_TOKEN})`);
});
