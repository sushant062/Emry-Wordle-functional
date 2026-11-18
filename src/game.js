import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', 'data');

export function scoreGuess(guess, answer) {
  const g = String(guess).toUpperCase();
  const a = String(answer).toUpperCase();
  const results = new Array(5).fill('absent');
  const remaining = new Map();

  for (let i = 0; i < 5; i += 1) {
    if (g[i] === a[i]) {
      results[i] = 'correct';
    } else {
      remaining.set(a[i], (remaining.get(a[i]) ?? 0) + 1);
    }
  }

  for (let i = 0; i < 5; i += 1) {
    if (results[i] === 'correct') continue;
    const count = remaining.get(g[i]) ?? 0;
    if (count > 0) {
      results[i] = 'present';
      remaining.set(g[i], count - 1);
    }
  }

  return results;
}

function readWordFile(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter(Boolean);
}

export function loadWordSets(dir = DEFAULT_DIR) {
  const allowed = new Set(readWordFile(join(dir, 'allowed.txt')));
  const answers = [...new Set(readWordFile(join(dir, 'answers.txt')))].sort();
  for (const answer of answers) allowed.add(answer);
  return { allowed, answers };
}

export function isValidGuess(word, allowed) {
  if (typeof word !== 'string') return false;
  const upper = word.toUpperCase();
  return /^[A-Z]{5}$/.test(upper) && allowed.has(upper);
}
