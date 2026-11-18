import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, migrate } from './db.js';
import { assignWordForDay, startScheduler } from './words.js';
import { centralDay } from './time.js';
import { createApp } from './app.js';

const DEFAULT_DB = '/var/lib/emry-wordle/emry.db';

function fail(message) {
  console.error(`emry-wordle: ${message}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || DEFAULT_DB;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const adminToken = process.env.ADMIN_TOKEN || '';
const production = process.env.NODE_ENV === 'production';

if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`invalid PORT "${process.env.PORT}"`);
if (production && !adminToken) {
  fail('ADMIN_TOKEN is required in production; generate one with: openssl rand -hex 32');
}
if (production && adminToken.length < 32) {
  fail('ADMIN_TOKEN must be at least 32 characters in production; generate one with: openssl rand -hex 32');
}
if (!adminToken) {
  console.warn('emry-wordle: ADMIN_TOKEN is not set — /admin and /api/admin/* are disabled');
}
if (dbPath !== ':memory:') {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (error) {
    fail(`cannot create database directory for ${dbPath}: ${error.message}`);
  }
}

let db;
try {
  db = openDb(dbPath);
  migrate(db);
} catch (error) {
  fail(`cannot open database ${dbPath}: ${error.message}`);
}

const today = centralDay(Date.now());
if (!assignWordForDay(db, today, Date.now())) {
  fail(`no word available for ${today}; is data/answers.txt present?`);
}

const scheduler = startScheduler(db);
const app = createApp({ db, adminToken });

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`emry-wordle listening on http://${shown}:${info.port} (db ${dbPath})`);
  console.log(`today is ${today}; answer assigned`);
  console.log('Tailscale Funnel: run "tailscale funnel --bg 3000" and open the printed https://<machine>.<tailnet>.ts.net URL');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`emry-wordle: ${signal} received, shutting down`);
  scheduler.stop();
  const done = () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  const force = setTimeout(() => {
    console.error('emry-wordle: shutdown timed out');
    process.exit(1);
  }, 5000);
  force.unref?.();
  server.close(done);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}
