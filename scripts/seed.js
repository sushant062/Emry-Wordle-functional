import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../src/db.js';
import { addPoolWord } from '../src/words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || '/var/lib/emry-wordle/emry.db';
const seedFile = join(ROOT, 'data', 'seed.json');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const db = openDb(dbPath);
migrate(db);

let added = 0;
let present = 0;
let invalid = 0;

for (const entry of seed) {
  const word = String(entry.word ?? '').trim().toUpperCase();
  const existing = db.prepare("SELECT id FROM words WHERE word = ? AND day IS NULL").get(word);
  if (existing) {
    present += 1;
    continue;
  }
  try {
    addPoolWord(db, { word, hint: entry.hint ?? null });
    added += 1;
  } catch (error) {
    invalid += 1;
    console.error(`skipped ${word || '(blank)'}: ${error.message}`);
  }
}

const total = db.prepare('SELECT COUNT(*) AS n FROM words WHERE day IS NULL').get().n;
console.log(`seed: ${added} added, ${present} already present, ${invalid} invalid, ${total} pool words total (${dbPath})`);
db.close();
