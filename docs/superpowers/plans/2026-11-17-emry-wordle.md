# Emry Hall Wordle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daily, server-authoritative Emry Hall 1st floor Wordle with timed ranked attempts, tiered hints, leaderboards, and an admin page, deployed on the dorm Fujitsu behind Tailscale Funnel.

**Architecture:** One Node process (Node 22 + Hono + better-sqlite3) serves a JSON API and a vanilla HTML/CSS/JS page. SQLite holds devices, words, and attempts. An in-process midnight job assigns each day's word in `America/Chicago`. The frontend is a single page with Play, Board, and Admin views; no build step.

**Tech Stack:** Node.js 22, Hono, `@hono/node-server`, better-sqlite3, `node:test`, vanilla JS/CSS, systemd, Tailscale Funnel.

**Spec:** `docs/superpowers/specs/2026-11-17-emry-wordle-design.md`

## Global Constraints

- Node.js 22 or newer.
- Runtime dependencies limited to `hono`, `@hono/node-server`, `better-sqlite3`.
- No build step, no bundler, no framework on the client.
- All timestamps stored as integer milliseconds since epoch (UTC).
- Day boundaries and week boundaries computed in `America/Chicago`.
- The current day's answer never appears in any response, HTML, JS, or static file until the attempt is finished.
- Ranked eligibility keys on `device_id`, never on the typed name.
- One ranked attempt per `(device_id, day)`, enforced by a partial unique index.
- Every guess is validated against `data/allowed.txt` server-side.
- Hint tier 1 text must never contain the answer or its stem.
- Admin routes require the `ADMIN_TOKEN` cookie; token compared with `crypto.timingSafeEqual`.
- `index.html` served `no-store`; `app.js` and `app.css` served with `?v=N` and `immutable`.
- Total shipped frontend under 30 KB gzipped.
- `prefers-reduced-motion` disables flips and confetti.

## Review Focus

1. **Duplicate letters between guess and answer** — a guess may legitimately use a letter twice while the answer has it once (and vice versa); feedback must not award two yellows for one occurrence. Tested in Task 2.
2. **A tab left open across midnight** — the open attempt belongs to the old day; a guess after midnight must be refused with a clear "day ended" result, not silently scored against the new word. Tested in Task 5.
3. **Server restart mid-attempt** — an open attempt must resume from SQLite with its original `started_at`; timing must not reset and the answer must still match the attempt's `word_id`. Tested in Task 5.
4. **Midnight with no scheduled word and an empty pool** — the door must still show a usable page or a clear "no word today" state, never a 500 and never two different words for one day. Tested in Task 4.
5. **Malformed input from a door tap** — names with emoji/HTML/leading spaces or 500 characters, guesses not five letters, and requests with no cookie must produce 4xx responses or a fresh device, never a crash or reflected HTML. Tested in Tasks 3 and 8.

---

## File Structure

```
package.json                 scripts: start, test; engines.node >=22
src/server.js                boot, static serving, scheduler start, listen 127.0.0.1:3000
src/app.js                   Hono app factory, public routes, cookie handling
src/db.js                    openDb, migrate, close
src/time.js                  centralDay, ctParts, nextCentralMidnight, weekStart
src/game.js                  scoreGuess, loadWordSets, isValidGuess
src/names.js                 normalizeName, validateName
src/words.js                 assignWordForDay, getWordForDay, addPoolWord, scheduleWord, previewDays
src/attempts.js              startRankedAttempt, submitGuess, nextHint, getTodayState, finish
src/leaderboard.js           dayBoard, weekBoard, monthBoard
src/admin.js                 admin auth middleware, admin routes
src/share.js                 formatShare, shared by client and tests
src/ratelimit.js             per-device sliding window
data/answers.txt             curated themed + general answers (one per line)
data/allowed.txt             allowed guess dictionary
data/seed.json               themed words with vague clues
public/index.html            markup and view shells
public/admin.html            token gate, word form, attempts table, preview
public/app.js                client state machine, fetch calls, keyboard
public/app.css               layout, tiles, animations, reduced motion
public/manifest.webmanifest  installable metadata
scripts/seed.js              load seed.json into the pool
systemd/emry-wordle.service  service unit
test/*.test.js               one file per module, node:test
```

---

### Task 1: Project scaffold, time utilities, database

**Files:**
- Create: `package.json`, `src/time.js`, `src/db.js`, `test/time.test.js`, `test/db.test.js`, `.gitignore` already exists
- Test: `test/time.test.js`, `test/db.test.js`

**Interfaces:**
- Produces:
  - `centralDay(now?: number): string` — `YYYY-MM-DD` in `America/Chicago`
  - `ctParts(ms: number): {year, month, day, hour, minute, second}`
  - `nextCentralMidnight(now?: number): number` — ms epoch of next 00:00 CT
  - `weekStart(day: string): string` — the Monday of that ISO day's week as `YYYY-MM-DD`
  - `openDb(path?: string): Database` — `better-sqlite3` handle, WAL on file DBs
  - `migrate(db): void` — creates all tables and indexes idempotently

- [ ] **Step 1: Create `package.json`**

`name: emry-wordle`, `type: module`, `engines.node: ">=22"`, scripts `start: "node src/server.js"` and `test: "node --test test/"`. Dependencies exactly `hono`, `@hono/node-server`, `better-sqlite3`. Run `npm install`.

- [ ] **Step 2: Write the failing time tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { centralDay, nextCentralMidnight } from '../src/time.js';

test('centralDay uses the Chicago calendar date', () => {
  assert.equal(centralDay(Date.UTC(2026, 10, 18, 4, 0)), '2026-11-17'); // 23:00 CST
  assert.equal(centralDay(Date.UTC(2026, 10, 18, 6, 0)), '2026-11-18'); // 00:00 CST
});

test('nextCentralMidnight is midnight Central in both DST directions', () => {
  // 2026-03-08 spring forward: local midnight is still CST (-6)
  assert.equal(nextCentralMidnight(Date.UTC(2026, 2, 7, 18, 0)), Date.UTC(2026, 2, 8, 6, 0));
  // 2026-11-01 fall back: local midnight is CDT (-5)
  assert.equal(nextCentralMidnight(Date.UTC(2026, 9, 31, 18, 0)), Date.UTC(2026, 10, 1, 5, 0));
  // ordinary night
  assert.equal(nextCentralMidnight(Date.UTC(2026, 10, 17, 18, 0)), Date.UTC(2026, 10, 18, 6, 0));
});

test('weekStart returns the Monday of the week', () => {
  assert.equal(weekStart('2026-11-17'), '2026-11-16');
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
  assert.equal(weekStart('2026-11-22'), '2026-11-16');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/time.test.js`
Expected: FAIL, cannot find module `../src/time.js`.

- [ ] **Step 4: Implement `src/time.js`**

Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ... })` with `formatToParts` for `ctParts` and `centralDay`. Implement `nextCentralMidnight` by taking the CT calendar date, building the following day's `Date.UTC`, then correcting twice by the delta between the desired wall-clock and the wall-clock that instant actually has in CT (the two-pass correction handles both DST transitions).

- [ ] **Step 5: Write the failing migration test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';

test('migrate creates the schema and is idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(names.includes('devices') && names.includes('words') && names.includes('attempts'));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  assert.ok(idx.includes('one_ranked_per_device_day'));
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL, cannot find module `../src/db.js`.

- [ ] **Step 7: Implement `src/db.js`**

Schema exactly as the spec's data model, plus:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_ranked_per_device_day
  ON attempts(device_id, day) WHERE mode = 'ranked';
CREATE INDEX IF NOT EXISTS attempts_day_mode ON attempts(day, mode, disqualified);
CREATE INDEX IF NOT EXISTS words_day ON words(day);
```

`openDb(':memory:')` skips WAL; file paths enable `journal_mode = WAL` and `foreign_keys = ON`.

- [ ] **Step 8: Run both test files and commit**

Run: `node --test test/` → PASS. Then `git add package.json package-lock.json src test && git commit -m "feat: scaffold, Central time helpers, schema"`.

---

### Task 2: Wordle feedback and guess validation

**Files:**
- Create: `src/game.js`, `test/game.test.js`, `data/allowed.txt`
- Test: `test/game.test.js`

**Interfaces:**
- Produces:
  - `scoreGuess(guess: string, answer: string): Array<'correct'|'present'|'absent'>` — five entries, inputs uppercase
  - `loadWordSets(dir?: string): {allowed: Set<string>, answers: string[]}`
  - `isValidGuess(word: string, allowed: Set<string>): boolean`

- [ ] **Step 1: Write the failing feedback tests**

```js
test('exact match is all correct', () => {
  assert.deepEqual(scoreGuess('CRANE', 'CRANE'), ['correct','correct','correct','correct','correct']);
});
test('single occurrence in answer cannot produce two presents', () => {
  assert.deepEqual(scoreGuess('ALLEY', 'LEMON'), ['absent','present','absent','present','absent']);
});
test('duplicates with mixed greens', () => {
  assert.deepEqual(scoreGuess('BABES', 'ABBEY'), ['present','present','correct','correct','absent']);
});
test('greens consume letters before yellows', () => {
  // answer SPEED, guess ERASE: E appears twice in answer (positions 3,4)
  assert.deepEqual(scoreGuess('ERASE', 'SPEED'), ['present','present','absent','absent','correct']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/game.test.js` → FAIL, module missing.

- [ ] **Step 3: Implement `scoreGuess`**

Two-pass algorithm: first mark exact-position matches and delete those letters from a mutable count of remaining answer letters; second pass marks `present` when the letter count is above zero and decrements, otherwise `absent`. No third pass, no order-dependent shortcuts.

- [ ] **Step 4: Write the failing dictionary test**

```js
test('word sets load with valid five-letter entries', () => {
  const { allowed, answers } = loadWordSets();
  assert.ok(allowed.size >= 1000);
  assert.ok(answers.length >= 150);
  for (const w of allowed) assert.match(w, /^[A-Z]{5}$/);
  assert.equal(isValidGuess('CRANE', allowed), true);
  assert.equal(isValidGuess('CRANEE', allowed), false);
  assert.equal(isValidGuess('cr4ne', allowed), false);
});
```

- [ ] **Step 5: Run to verify failure**

Run: `node --test test/game.test.js` → FAIL on `loadWordSets`.

- [ ] **Step 6: Implement `loadWordSets` and add data**

`data/allowed.txt`: at least 1,000 common five-letter uppercase words, one per line, no proper nouns, no duplicates. Source any standard Wordle-style allowed-guess list; commit it. `data/answers.txt`: curated themed list plus at least 150 general words, same format, every entry also present in `allowed.txt`. `loadWordSets` reads once, uppercases, trims, dedupes, exposes a `Set` and a sorted answers array.

- [ ] **Step 7: Run tests and commit**

Run: `node --test test/` → PASS. `git add src/game.js data test/game.test.js && git commit -m "feat: feedback scoring and dictionaries"`.

---

### Task 3: Names

**Files:**
- Create: `src/names.js`, `test/names.test.js`
- Test: `test/names.test.js`

**Interfaces:**
- Produces:
  - `validateName(raw: unknown): {ok: true, display: string, norm: string} | {ok: false, error: string}`
  - `normalizeName(raw: string): string` — lowercase, collapsed whitespace, trimmed

- [ ] **Step 1: Write the failing tests**

```js
test('accepts ordinary dorm names', () => {
  assert.deepEqual(validateName('  Alex  B. '), { ok: true, display: 'Alex B.', norm: 'alex b' });
  assert.equal(validateName("D'Angelo").ok, true);
  assert.equal(validateName('Mary-Jane').ok, true);
});
test('rejects empty, too long, and markup', () => {
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('x'.repeat(21)).ok, false);
  assert.equal(validateName('<script>alert(1)</script>').ok, false);
});
test('normalization is case and whitespace insensitive', () => {
  assert.equal(normalizeName('  SUSHANT   thakur '), 'sushant thakur');
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/names.test.js` → FAIL.

- [ ] **Step 3: Implement**

Allowed characters: letters (unicode letters), digits, space, hyphen, apostrophe, period. Trim, collapse inner whitespace, enforce 1–20 characters after cleaning; reject anything still containing `<`, `>`, `&`, or control characters. `norm` strips trailing periods and lowercases.

- [ ] **Step 4: Run and commit** — `node --test test/` → PASS; commit `feat: name validation`.

---

### Task 4: Word assignment and the midnight job

**Files:**
- Create: `src/words.js`, `test/words.test.js`, `data/seed.json`
- Test: `test/words.test.js`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `centralDay`, `nextCentralMidnight`
- Produces:
  - `assignWordForDay(db, day: string, now: number): {id, day, word} ` — idempotent, transactional
  - `getWordForDay(db, day)` / `getWordById(db, id)`
  - `addPoolWord(db, {word, hint})`, `scheduleWord(db, {day, word, hint})`, `previewDays(db, fromDay, count)`
  - `startScheduler(db, {now, setTimer, clearTimer})` — returns `{stop, fire}` for tests

- [ ] **Step 1: Write the failing selection tests**

```js
test('scheduled word wins over pool and dictionary', () => { /* schedule CLASS for day; add pool word; assign; expect CLASS */ });
test('pool word is used when nothing is scheduled', () => { /* expect pool word, source 'pool' */ });
test('dictionary is the last resort', () => { /* empty pool; expect source 'auto', 5 letters */ });
test('assignment is idempotent and race-safe', () => {
  const a = assignWordForDay(db, '2026-11-17', now);
  const b = assignWordForDay(db, '2026-11-17', now);
  assert.equal(a.id, b.id);
});
test('repeats within 180 days are avoided when alternatives exist', () => { /* insert two pool words, assign day1 then day2, expect different words */ });
```

- [ ] **Step 2: Run to verify failure** — `node --test test/words.test.js` → FAIL.

- [ ] **Step 3: Implement selection and scheduling**

Selection order: row with `day = ?` → random unused pool row (`day IS NULL`) whose text was not used in the previous 180 days → random answer from `data/answers.txt` not used in 180 days. Wrap in `db.transaction`, catch the `day` unique-constraint error and re-read. Scheduler: compute `nextCentralMidnight`, `setTimeout` at that distance + 250 ms, on fire loop from the last assigned day to today assigning each missing day, then re-arm; `fire()` exposed for tests with an injected clock.

- [ ] **Step 4: Seed data**

`data/seed.json` starts with the themed list and vague clues (all five letters, clues never containing the answer):

```json
[
  {"word": "CLASS", "hint": "starts at eight whether you are ready or not"},
  {"word": "STUDY", "hint": "what the library is for, allegedly"},
  {"word": "ESSAY", "hint": "due at midnight, written at 11:40"},
  {"word": "EXAMS", "hint": "the week everyone suddenly gets religious"},
  {"word": "FINAL", "hint": "the last one, and the worst one"},
  {"word": "MAJOR", "hint": "the thing you change at least twice"},
  {"word": "TUTOR", "hint": "the person you should have seen sooner"},
  {"word": "NOTES", "hint": "what nobody borrows and returns"},
  {"word": "PAPER", "hint": "what printers exist to jam"},
  {"word": "DORMS", "hint": "where the RA's door is"},
  {"word": "SUITE", "hint": "a room with a shared bathroom, if you're lucky"},
  {"word": "LOBBY", "hint": "where packages wait to be claimed"},
  {"word": "FLOOR", "hint": "your whole social world, and also what you walk on"},
  {"word": "STAIR", "hint": "the thing the elevator makes you regret skipping"},
  {"word": "BUNKS", "hint": "the ceiling is closer to one of them"},
  {"word": "ALARM", "hint": "the most hated sound on a Tuesday"},
  {"word": "QUIET", "hint": "the thing the hallway forgets after midnight"},
  {"word": "EARLY", "hint": "a time of day that should not exist"},
  {"word": "TIRED", "hint": "your default state by Thursday"},
  {"word": "SNACK", "hint": "what the vending machine is for"},
  {"word": "RAMEN", "hint": "a broke student's best friend"},
  {"word": "PIZZA", "hint": "the only thing a floor meeting agrees on"},
  {"word": "NACHO", "hint": "a shared plate that becomes a fight"},
  {"word": "COCOA", "hint": "a drink that makes winter survivable"},
  {"word": "SWIPE", "hint": "a small motion with big consequences at dinner"},
  {"word": "MEALS", "hint": "what your plan runs out of before you do"},
  {"word": "TOWEL", "hint": "the thing still in the laundry room"},
  {"word": "SHEET", "hint": "it never fits the first time"},
  {"word": "MOVIE", "hint": "what the lounge TV is always showing"},
  {"word": "CHILL", "hint": "the floor's official evening activity"},
  {"word": "PRANK", "hint": "harmless until someone files a report"},
  {"word": "PARTY", "hint": "the reason the hallway smells like a candle"},
  {"word": "BISON", "hint": "big, hairy, and from up the road"},
  {"word": "JACKS", "hint": "they live up north and love to gloat"},
  {"word": "SNOWY", "hint": "the forecast for most of the semester"},
  {"word": "FROST", "hint": "why the walk across campus gets slippery"}
]
```

- [ ] **Step 5: Run tests and commit** — `node --test test/` → PASS; commit `feat: daily word selection and scheduler`.

---

### Task 5: Attempt lifecycle

**Files:**
- Create: `src/attempts.js`, `test/attempts.test.js`
- Test: `test/attempts.test.js`

**Interfaces:**
- Consumes: `scoreGuess`, `centralDay`, `getWordForDay`, `getWordById`
- Produces:
  - `startRankedAttempt(db, {deviceId, day, now}) → {attempt, created: boolean} | {error: 'already_finished'|'day_over'}`
  - `submitGuess(db, {deviceId, guess, now}) → {results, solved, finished, elapsedMs, remaining, error?}`
  - `getTodayState(db, {deviceId, day}) → {attempt|null, played: boolean}`
  - `finishAttempt(...)` internal helper writing `finished_at`, `solved`, `elapsed_ms`
  - `elapsedFor(attempt, now)` → number

- [ ] **Step 1: Write the failing lifecycle tests** (in-memory DB, fixed `now`)

```js
test('first keypress creates one ranked attempt with server start time', () => { /* start twice → same id, created false second time */ });
test('refresh resumes with the original started_at', () => { /* reopen db file, getTodayState returns same elapsed base */ });
test('second ranked attempt after finish is refused', () => { /* expect error 'already_finished' */ });
test('guesses after midnight are refused with day_over', () => { /* start at 23:59, guess next day → error 'day_over' */ });
test('losing completes the attempt with no rank', () => { /* six wrong guesses → finished true, solved false, elapsed set */ });
test('sub-1.2s solve is flagged suspicious but accepted', () => { /* started_at now-800 → suspicious 1 */ });
test('invalid or lowercase guess is rejected without consuming a turn', () => { /* error 'invalid_word', guesses unchanged */ });
```

- [ ] **Step 2: Run to verify failure** — `node --test test/attempts.test.js` → FAIL.

- [ ] **Step 3: Implement**

`startRankedAttempt`: look up today's ranked row for the device; return it if open; return `already_finished` if `finished_at` is set; insert with `started_at = now`, `mode = 'ranked'`, `word_id = getWordForDay(day).id`. `submitGuess`: load open attempt, reject if `attempt.day !== centralDay(now)` with `day_over`, uppercase and validate, append `{word, results}` to the JSON column, finish on win or six guesses, compute `elapsed_ms = finished_at - started_at + penalty_ms`, set `suspicious` when `elapsed < 1200`. All writes in transactions.

- [ ] **Step 4: Run and commit** — PASS; commit `feat: attempt lifecycle with server timing`.

---

### Task 6: Tiered hints

**Files:**
- Modify: `src/attempts.js` (add `nextHint`), `src/words.js` (hint validation helper)
- Create: `test/hints.test.js`
- Test: `test/hints.test.js`

**Interfaces:**
- Produces:
  - `nextHint(db, {deviceId, now}) → {tier: 1|2, text?: string, letter?: string, position?: number, hints, elapsedMs} | {error: 'max_hints'|'not_started'|'finished'}`
  - `hintLeaksAnswer(hint: string, word: string): boolean`

- [ ] **Step 1: Write the failing tests**

```js
test('tier one returns the curated clue', () => { /* word CLASS with clue → text equals clue, hints 1 */ });
test('tier two reveals an unknown correct letter and adds 20s', () => { /* hints 2, elapsed grows by 20000 */ });
test('third hint is refused', () => { /* error max_hints */ });
test('word without a clue falls back to a letter at tier one', () => { /* source auto → letter present */ });
test('clue containing the answer is rejected at authoring time', () => {
  assert.equal(hintLeaksAnswer('a place to sleep', 'BED'), false);
  assert.equal(hintLeaksAnswer('the dorm BEDS', 'BEDS'), true);
  assert.equal(hintLeaksAnswer('class starts at eight', 'CLASS'), true);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

Tier 1: if `hints === 0` and the word has a clue, return it; otherwise fall through to a letter. Letter choice: scan indices whose answer letter is not already marked `correct` in existing guesses, pick the lowest such index, return `{letter, position}` and append a synthetic revealed entry to the attempt's guess JSON so the client can render it. Increment `hints`, add 20,000 to `penalty_ms`, both in one transaction. Tier 2 with no unrevealed correct letters returns `max_hints`. `hintLeaksAnswer` lowercases both, strips non-letters, and checks whether the clue contains the word or the word's first four letters.

- [ ] **Step 4: Wire clue validation into `scheduleWord`/`addPoolWord`, run tests, commit**

On save, reject with `{error: 'hint_leaks'}` if `hintLeaksAnswer(hint, word)`. Commit `feat: tiered hints with penalties`.

---

### Task 7: Leaderboards and streaks

**Files:**
- Create: `src/leaderboard.js`, `test/leaderboard.test.js`
- Test: `test/leaderboard.test.js`

**Interfaces:**
- Produces:
  - `dayBoard(db, day)` → rows `{deviceId, name, elapsedMs, hints, finishedAt}`
  - `weekBoard(db, weekStartDay)` → rows for Monday–Sunday range, fastest per device
  - `monthBoard(db, month: 'YYYY-MM')` → `{fastest: rows, streaks: rows}` and `hallOfFame(db, months: number)` for past months

- [ ] **Step 1: Write failing tests with seeded attempts**

```js
test('day board keeps the fastest solve per device and excludes disqualified', () => {});
test('week board compares fastest single solves across days', () => {});
test('ties break on fewer hints, then earlier finish', () => {});
test('month streaks count consecutive solved days within the month only', () => {});
test('failed days do not extend a streak', () => {});
test('practice attempts never appear', () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement with SQL plus a small JS pass**

Common filter: `mode='ranked' AND solved=1 AND disqualified=0`. Day: `GROUP BY device_id` with `MIN(elapsed_ms)`, join `devices.display_name`. Week: filter `day BETWEEN monday AND sunday`, same grouping, order by elapsed, hints, finished_at. Month streaks: fetch solved days per device within the month, sort, count runs of consecutive dates using `centralDay` arithmetic on ISO day strings; tie-break by the month's fastest solve. `hallOfFame` runs the month computation for the previous N months.

- [ ] **Step 4: Run and commit** — PASS; commit `feat: leaderboards and monthly streaks`.

---

### Task 8: Public API and device cookie

**Files:**
- Create: `src/app.js`, `src/ratelimit.js`, `test/api.test.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: all previous modules
- Produces:
  - `createApp({db, now?}) → Hono` — testable with `app.request()`
  - Device cookie `emry_device` (httpOnly, SameSite=Lax, Secure in production, 1 year)
  - Routes exactly as the spec's Public API section

- [ ] **Step 1: Write failing API tests**

```js
test('first request issues a device cookie and reports today', () => {});
test('session sets display name without creating an attempt', () => {});
test('start then guess returns feedback and no answer field', () => {
  // assert body has results but JSON.stringify(body) does not include the answer word
});
test('guess before start returns 409', () => {});
test('practice start rejects today\'s word and never includes an answer', () => {});
test('unknown cookie value is replaced with a fresh device', () => {});
test('guess rate limit returns 429 after 60 in a minute', () => {});
test('malformed JSON body returns 400, not 500', () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

Hono app factory. Middleware: parse/issue device cookie, attach `deviceId`. JSON body parsing wrapped to convert parse errors into `400 {error:'bad_json'}`. Handlers call the module functions; responses match the interfaces in Tasks 5–7. Never serialize `word` for the current day. Practice picks a random `words` row with `day < centralDay(now)` and creates a `mode='practice'` attempt with a 60-guess cap for the whole practice session. Rate limit: in-memory `Map<deviceId, number[]>` sliding window for guesses (60/min) and start/session calls (10/min); prune on access.

- [ ] **Step 4: Run and commit** — PASS; commit `feat: public API with device identity`.

---

### Task 9: Admin API and page

**Files:**
- Create: `src/admin.js`, `public/admin.html`, `test/admin.test.js`
- Modify: `src/app.js` (mount)
- Test: `test/admin.test.js`

**Interfaces:**
- Produces:
  - `createAdminRoutes({db, token}) → Hono`
  - `POST /api/admin/login {token}` → sets `emry_admin` cookie
  - `GET /api/admin/words?from=&days=14`, `POST /api/admin/words {day?, word, hint?}`, `DELETE /api/admin/words/:id`
  - `GET /api/admin/attempts?day=`, `POST /api/admin/attempts/:id/disqualify`, `.../reinstate`
  - `POST /api/admin/devices/:id/name {name}`, `GET /api/admin/export.csv`

- [ ] **Step 1: Write failing tests**

```js
test('admin routes reject requests without the token', () => {});
test('correct token sets an httpOnly cookie', () => {});
test('scheduling a word with a leaking clue returns 400 hint_leaks', () => {});
test('disqualify excludes from boards but keeps the row and the day locked', () => {});
test('reinstate restores the row to the board', () => {});
test('CSV export quotes commas and newlines in names', () => {});
test('14-day preview lists scheduled, pooled-pending, and dictionary fallback days', () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

Token check via `crypto.timingSafeEqual` on equal-length buffers; issue an httpOnly cookie with `SameSite=Strict`. Disqualify writes `disqualified=1` and `disqualify_reason`; it never deletes and never touches the unique index. CSV: header `day,device,name,elapsed_ms,hints,solved,disqualified`, RFC 4180 quoting, attachment filename `emry-attempts.csv`. `admin.html` is a single static page with a token field, word form, day picker, attempt table with disqualify/reinstate buttons, preview list, and an export link.

- [ ] **Step 4: Run and commit** — PASS; commit `feat: admin page and moderation endpoints`.

---

### Task 10: Play view

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/app.css`, `public/manifest.webmanifest`
- Modify: `src/app.js` (static serving with `no-store` for HTML and `?v=1` immutable for JS/CSS)

**Interfaces:**
- Consumes: `GET /api/today`, `POST /api/session`, `POST /api/attempt/start`, `POST /api/guess`, `POST /api/hint`

- [ ] **Step 1: Build the markup and styles**

`100dvh` grid: header (hall name, date, tiny timer), 6×5 board, hint row, keyboard, view switch links. CSS custom properties for accent, dark default, `env(safe-area-inset-*)` padding, tiles with flip keyframes, shake keyframes, `@media (prefers-reduced-motion: reduce)` disabling both.

- [ ] **Step 2: Implement the client state machine**

States: `loading`, `idle` (name + Play), `playing`, `finished`, `no_word`. On load, `GET /api/today`; prefill the last name from `localStorage`; render an existing attempt's guesses and remaining time. First letter keypress (physical or on-screen) calls `POST /api/attempt/start` once and starts the visual timer from `startedAt`. Each submitted five-letter word disables input until `/api/guess` returns, then animates tiles and paints keyboard colors. Hint button labels `Hint (+20s)` and shows `hints/2`. On finish, show time, today's rank, share text, Practice and Board buttons.

- [ ] **Step 3: Verify manually and with syntax checks**

Run: `node --check public/app.js` and `node --check src/app.js`. Then `npm start` and in a browser check: name → Play → first keypress starts the timer → 6 guesses cap → hint reveals clue → reload resumes with the same elapsed time → share text copies.

- [ ] **Step 4: Commit**

`git add public src/app.js && git commit -m "feat: play view with timer and hints"`.

---

### Task 11: Board view and share text

**Files:**
- Modify: `public/app.js`, `public/app.css`, `public/index.html`, `src/app.js` (leaderboard route already exists)
- Test: `test/share.test.js` (export the pure formatter)

**Interfaces:**
- Produces: `formatShare({resultsByRow, elapsedMs, hints}) → string` in `public/app.js`, exported for tests via a tiny `export` guarded by `typeof module`? Use a plain function attached to `window` and duplicate the pure helper in `src/share.js` imported by both? Keep it simple: put `formatShare` in `src/share.js`, serve it as a module to the client, and test it with `node:test`.

- [ ] **Step 1: Write the failing formatter test**

```js
test('share text carries the emoji grid and time', () => {
  const text = formatShare({rows: [['absent','present','correct','absent','present']], elapsedMs: 54000, hints: 1});
  assert.equal(text, 'Emry Hall 1st Floor — 54s ⏱ (1 hint)\n⬛🟨🟩⬛🟨');
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `src/share.js` and the Board view**

Three tabs: Today, This Week, This Month. Rows show rank, name, formatted time, hint marker, and streak where relevant. Month view lists the derived Hall of Fame. The finish sheet gets a copy button using `navigator.clipboard` with a `document.execCommand` fallback.

- [ ] **Step 4: Verify, run tests, commit**

Run `node --check public/app.js`, `node --test test/` → PASS. Commit `feat: leaderboard views and share text`.

---

### Task 12: Server boot, scheduler wiring, deployment files

**Files:**
- Create: `src/server.js`, `scripts/seed.js`, `systemd/emry-wordle.service`, `README.md` (replace placeholder)
- Modify: `src/app.js` (static + admin mount final order)

**Interfaces:**
- Consumes: `createApp`, `openDb`, `migrate`, `startScheduler`, `assignWordForDay`
- Produces: an HTTP server on `127.0.0.1:3000` and a documented deployment path

- [ ] **Step 1: Implement boot**

Read `DB_PATH` (default `/var/lib/emry-wordle/emry.db`), `ADMIN_TOKEN` (fail fast with a clear message when absent in production), `PORT` (default 3000). Open DB, migrate, assign today's word immediately, start the scheduler, serve the app, log the Funnel hint on listen. Handle `SIGTERM` by closing the server and DB.

- [ ] **Step 2: Seed script**

`node scripts/seed.js` reads `data/seed.json`, inserts any missing pool words idempotently (skip duplicates by word text), prints counts. Test with a temporary DB.

- [ ] **Step 3: systemd unit and README**

Unit: `ExecStart=/usr/bin/node /opt/emry-wordle/src/server.js`, `EnvironmentFile=/etc/emry-wordle.env`, `User=emry`, `Restart=always`, `WorkingDirectory=/opt/emry-wordle`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/emry-wordle`. README: install Node 22, clone, `npm ci --omit=dev`, create env file with a generated admin token, seed, enable unit, `tailscale funnel --bg 3000`, verify from cellular, reprogram the NFC tag, backup cron line.

- [ ] **Step 4: Boot test**

Run: `DB_PATH=:memory: ADMIN_TOKEN=test PORT=3999 node src/server.js` then `curl -s localhost:3999/api/today`. Expected: JSON with `status: "ok"` and a five-letter length. Ctrl-C stops cleanly.

- [ ] **Step 5: Commit** — `feat: server boot, scheduler, deployment`.

---

### Task 13: End-to-end smoke and performance check

**Files:**
- Create: `test/e2e.test.js`
- Modify: `README.md` (performance notes)

- [ ] **Step 1: Write the end-to-end test**

Drive `createApp().request()` through: fresh device → name → start → four guesses → hint → solve → day board shows one row → second start returns `already_finished` → practice start works and is absent from boards. Assert every response body lacks the answer string until finished.

- [ ] **Step 2: Run it**

Run: `node --test test/e2e.test.js` → PASS.

- [ ] **Step 3: Measure payload and response**

Run `npm start`, then `curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download} %{time_total}\n' localhost:3000/` and the same for `app.js`, `app.css`, and `/api/today`. Expected: combined gzipped frontend under 30 KB, API under 100 ms locally. Record the numbers in the README.

- [ ] **Step 4: Final commit and push**

`git add -A && git commit -m "test: end-to-end flow and performance notes" && git push origin main`.

---

## Notes for the implementer

- Work task by task; run the whole suite before each commit.
- The answer for the current day must never appear in a public response or in `public/`. Grep the response bodies in tests.
- Keep the frontend dependency-free; no external fonts or CDNs.
- If a task's tests reveal a spec contradiction, stop and raise it rather than inventing a rule.
