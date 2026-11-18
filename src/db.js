import Database from 'better-sqlite3';

export function openDb(path = ':memory:') {
  const db = new Database(path);
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      name_norm TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY,
      day TEXT UNIQUE,
      word TEXT NOT NULL,
      hint TEXT,
      source TEXT NOT NULL CHECK (source IN ('pool', 'auto', 'scheduled')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id),
      mode TEXT NOT NULL CHECK (mode IN ('ranked', 'practice')),
      word_id INTEGER NOT NULL REFERENCES words(id),
      started_at INTEGER,
      finished_at INTEGER,
      solved INTEGER NOT NULL DEFAULT 0,
      guesses TEXT NOT NULL DEFAULT '[]',
      hints INTEGER NOT NULL DEFAULT 0,
      penalty_ms INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER,
      suspicious INTEGER NOT NULL DEFAULT 0,
      disqualified INTEGER NOT NULL DEFAULT 0,
      disqualify_reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_ranked_per_device_day
      ON attempts(device_id, day) WHERE mode = 'ranked';
    CREATE INDEX IF NOT EXISTS attempts_day_mode ON attempts(day, mode, disqualified);
    CREATE INDEX IF NOT EXISTS words_day ON words(day);
  `);
}
