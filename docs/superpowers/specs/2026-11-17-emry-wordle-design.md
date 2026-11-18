# Emry Hall 1st Floor Wordle — Design

Date: 2026-11-17
Status: Draft, awaiting owner approval
Revision: 2 (builder review folded in)

## Intent

The RA of Emry Hall 1st floor has an NFC sticker on the door that opens a custom
Wordle hosted on Replit. This design replaces it with a faster, self-hosted,
phone-first daily game that doubles as a floor ritual and a small competition:
the fastest solve of the week wins $10 flex, and the longest daily streak of the
month earns a bonus.

The people using it are residents tapping a sticker while walking past a door.
They are not logged in, not patient, and not necessarily Wordle players. The
first tap has to be self-explanatory, and every interaction has to feel instant.

## Goals

- Under one second to playable on a phone, over dorm wifi or cellular.
- Zero onboarding: name, tap Play, start guessing.
- Server-authoritative puzzle, guesses, and timing, because a cash prize makes
  cheating worth attempting.
- Daily puzzle shared by everyone; fastest single solve of the week wins.
- Monthly longest-streak tracking with a visible bonus.
- Leaderboards readable at a glance: today, this week, this month.
- Word list and player log administrable from a phone by the RA.
- Runs on the existing headless Fujitsu in the dorm room, reachable from
  anywhere over the existing Tailscale tailnet.

## Non-goals

- Accounts, passwords, email, or any signup.
- Native iOS/Android apps.
- Chat, comments, reactions, or a social feed.
- Multi-floor or multi-building support.
- Offline play of the daily puzzle (the answer must stay server-side).
- Payments or automated prize payouts; the RA hands out flex.
- Buying a domain now; a free `*.ts.net` hostname is acceptable for v1.
- Merging player identities, or cross-device identity recovery.

## Constraints

- Single small Debian box on a dorm network with outbound-only connectivity.
- Tailscale is already installed and SSH access works from anywhere.
- Phone-first; must also work on a laptop browser.
- No build step: the RA edits words and copy without a toolchain.
- Tailscale Funnel terminates TLS publicly; no port forwarding, no inbound
  firewall changes, no domain purchase.

## Game rules (decided with the owner)

- Five-letter words, six guesses, Wordle-style feedback with correct duplicate
  handling.
- One shared puzzle per calendar day. Day boundary is midnight
  `America/Chicago`, so DSU local time matches the door.
- The day's word is assigned **automatically at 00:00 Central**, by a scheduler
  inside the server. It is never dependent on someone opening the page, and
  never requires the RA to touch it. Manual scheduling exists as an override,
  not a requirement.
- The player types their name on every game. The last name used on the device is
  prefilled, and previously used names are offered as autocomplete suggestions
  to reduce typo-created duplicate identities.
- The ranked attempt is the first attempt started on a given device on a given
  day, through a given name. Starting is triggered by the first letter keypress,
  never by submitting a name or opening the page, so nobody burns their day by
  walking away from a filled-in name field.
- The clock starts when the server receives the first-letter start signal, and
  stops when the server receives the winning or sixth guess. Timing is recorded
  and computed server-side.
- Refreshing or closing the tab resumes the same attempt with the same elapsed
  time. No clock reset.
- A failed ranked attempt produces no rank for that day, and the day's word may
  not be replayed ranked. A second ranked attempt on the same device and day is
  refused outright; there is no "practice on today's word" escape hatch, because
  the word would already be visible.
- Streaks count solved days, not merely played days, and follow the device
  identity, not the typed name.
- Hints: at most two per ranked puzzle, tiered. The first is a vague, indirect
  one-line clue — a situation or feeling the word belongs to, never a
  definition, synonym, or category label — and adds 20 seconds. The second
  reveals one unknown correctly-placed letter and adds another 20 seconds. Words
  without an authored clue fall back to a letter hint. Hints are shown as a
  marker on leaderboard rows and are a tie-breaker against players who used
  fewer.
- Hint descriptions never contain the answer or a form of it; the server
  rejects a scheduled description that does, and the admin page validates on
  save.
- Weekly winner is the fastest single ranked solve within the week
  (Monday 00:00 through Sunday 23:59, Central). Ties break on fewer hints, then
  on earlier submission time.
- Monthly bonus goes to the longest consecutive solved-day streak inside the
  calendar month, tie-broken by that month's fastest single solve. The RA
  decides what the bonus is; the app reports the leader and shows it on the
  month board.
- Practice mode uses past words only, is unlimited and unranked, and has no
  leaderboard effect.

## Identity (resolved after review)

Identity is the **device**, not the name. A random device id is issued by the
server as an httpOnly cookie with a one-year lifetime, and every ranked
eligibility check uses it. The typed name is a display label attached to the
attempt.

This settles several problems at once:

- Two residents named Alex are two devices, so both can play and both appear on
  the board; no name collision blocks anyone.
- One resident cannot farm the weekly prize under three spellings from one
  phone, because the second ranked attempt from that device is refused.
- A shared phone is a known, accepted limitation: the second resident sees
  "this phone already played today" and uses their own device.
- Clearing cookies or using a private window yields a new device identity, which
  is the remaining cheat vector without accounts. It is accepted for a $10 dorm
  prize and mitigated by the admin log: brand-new devices with fast solves and
  no history are flagged for review.

The consequence the owner should know: **the streak follows the phone.** Clearing
site data, or switching phones, resets it. The admin page can fix a display name
but cannot transplant a streak, by design.

## Approaches considered

**A. Small Node service plus a static vanilla frontend on the Fujitsu
(chosen).** Node with SQLite, a couple of dependencies, plain HTML/CSS/JS with
no build step, served publicly through Tailscale Funnel. Fast enough, readable,
easy for the RA to maintain, and cheap to operate.

**B. Go single binary with embedded assets.** More robust operationally and
marginally faster, but editing words or UI later means recompiling, and the
code is less approachable for a student-maintained side project. Rejected as
unnecessary robustness at dorm scale.

**C. Stay on Replit, or static frontend with a hosted database (Supabase).**
No server to operate, but the Replit URL problem stays on the sticker, every
guess gains a remote hop, and free-tier limits introduce the exact lag the
owner called out. Rejected.

## Architecture

- **Runtime:** Node.js 22 LTS, single process, listening on `127.0.0.1:3000`.
- **HTTP:** Hono with `@hono/node-server` for routing and middleware.
- **Data:** SQLite through `better-sqlite3`, WAL mode, one file under
  `/var/lib/emry-wordle/`.
- **Frontend:** one HTML file, one CSS file, one JS module. No framework, no
  build step, no external requests, no web fonts. Target under 30 KB gzipped
  total.
- **Public entry:** Tailscale Funnel on 443 forwarding to `127.0.0.1:3000`.
  Tailscale terminates TLS. A Caddy layer is unnecessary for v1.
- **Process management:** one systemd unit, restart on failure, environment file
  for secrets.
- **Scheduler:** an in-process midnight job (single process, so no locking
  needed) assigns the next day's word at 00:00 `America/Chicago`, recomputes the
  next fire time after every run (DST-safe via `Intl` date arithmetic), and runs
  a catch-up assignment on boot or on the first request of a day if the process
  was down at midnight.
- **Backups:** nightly `sqlite3 .backup` into `/var/backups/emry-wordle/`,
  keeping 14 files.

## Data model

```
devices(
  id TEXT PK,              -- server-issued UUID, httpOnly cookie, 1 year
  display_name TEXT,       -- last name typed on this device
  name_norm TEXT,
  created_at INTEGER,
  last_seen INTEGER
)

attempts(
  id INTEGER PK,
  day TEXT,                -- YYYY-MM-DD, America/Chicago
  device_id TEXT,
  mode TEXT,               -- 'ranked' | 'practice'
  word_id INTEGER,
  started_at INTEGER,      -- ms since epoch, server receipt of first keypress
  finished_at INTEGER,     -- ms, winning or sixth guess
  solved INTEGER,
  guesses TEXT,            -- JSON array of {word, results}
  hints INTEGER DEFAULT 0,
  penalty_ms INTEGER DEFAULT 0,
  elapsed_ms INTEGER,      -- computed server-side, authoritative
  suspicious INTEGER DEFAULT 0,
  disqualified INTEGER DEFAULT 0,
  disqualify_reason TEXT,
  created_at INTEGER
)

words(
  id INTEGER PK,
  day TEXT UNIQUE NULL,    -- NULL means available in the RA pool
  word TEXT,               -- no UNIQUE: repeats allowed after a cooldown
  hint TEXT NULL,          -- one vague line, no answer leakage
  source TEXT,             -- 'pool' | 'auto' | 'scheduled'
  created_at INTEGER
)
```

- One ranked attempt per `(device_id, day)`, enforced by a unique index. Practice
  attempts are not covered by it.
- `elapsed_ms = finished_at - started_at + penalty_ms`, written once at finish.
- `display_name` is a label; `name_norm` exists only for autocomplete and admin
  search, never for identity or ranking.
- `disqualified` is a soft flag: the row is kept as evidence, excluded from every
  leaderboard, and does not free the day for another ranked attempt.

## Attempt lifecycle

1. Page load calls `GET /api/today`. No attempt is created.
2. The player enters or confirms a name, presses Play, and the board appears.
3. The first letter keypress fires `POST /api/attempt/start` once. The server
   creates the ranked attempt, records `started_at`, and returns the current
   state. If the device already has a finished ranked attempt today, this
   returns 409 and the UI shows today's result instead.
4. Each guess is `POST /api/guess`; the server validates the word, computes
   feedback, persists, and returns the new state.
5. Finish happens on the winning guess or after six guesses; the server writes
   `finished_at` and `elapsed_ms`.
6. A refresh calls `GET /api/today`, which returns the open attempt (resume) or
   the finished result, with elapsed time derived from stored timestamps.

Starting the clock on first keypress rather than first guess means typing the
first word counts toward the time, which is what "fastest solve" should mean.
The start call is fire-and-forget from the UI, so it adds no perceived latency.

## API

Public, cookie-scoped by the device cookie:

- `GET /api/today` — day, word length, current attempt state (guesses, started
  time, hints, finished result), whether the device has played today, and name
  suggestions for autocomplete.
- `POST /api/session` — `{name}`; updates the device's display name. Never
  creates an attempt and never consumes the day.
- `POST /api/attempt/start` — begins or resumes today's ranked attempt.
- `POST /api/guess` — `{guess}`; validates against the allowed-word list,
  computes feedback, persists, and returns `{results, solved, remaining,
  elapsedMs}`.
- `POST /api/hint` — returns the next hint tier: first the one-line description if
  the word has one (otherwise a letter), then one unknown correctly-placed
  letter. Increments `hints`, adds 20 000 ms to `penalty_ms`, and returns
  `{tier, text|letter, position, hints}`.
- `GET /api/leaderboard?range=day|week|month` — ranked, non-disqualified solves
  only, grouped by device, fastest per device per range, plus the month streak
  board.
- Practice: `POST /api/practice/start` picks a random word from a past day;
  `POST /api/practice/guess` validates but never touches rankings or streaks.
  Guesses against the current day's word are rejected in practice mode.

Admin, token-gated:

- `GET /admin` — schedule words, view attempts for a day, see suspicious and
  disqualified rows, rename a device, disqualify or reinstate an attempt, export
  CSV.
- `POST /api/admin/words` `{day?, word, hint?}`; `DELETE /api/admin/words/:id`.
- `GET /api/admin/attempts?day=`.
- `POST /api/admin/attempts/:id/disqualify` `{reason?}` and
  `POST /api/admin/attempts/:id/reinstate`.
- `POST /api/admin/devices/:id/name` `{name}`.
- `GET /api/admin/export.csv`.
- Auth: `ADMIN_TOKEN` (32+ random chars) in the environment, exchanged for an
  httpOnly cookie; every admin route checks it server-side.

## Word list and hints

The curated list is themed around college life: dorms, classes, dining, campus
weather, floor rituals, and DSU-adjacent references. A strong theme gives the
game its identity and makes it *feel* like Emry Hall rather than a generic
Wordle, which is the point.

Two guardrails keep the theme from becoming a strategy problem:

- Roughly 75% themed words and 25% ordinary five-letter words, so "it's always a
  dorm word" does not collapse the guessing game.
- Every curated word gets a hand-written one-line clue at authoring time,
  written to be indirect rather than explanatory, for example:
  - `SWIPE` — "a small motion with big consequences at dinner"
  - `BUNKS` — "the ceiling is closer to one of them"
  - `QUIET` — "the thing the hallway forgets after midnight"
  - `RAMEN` — "a broke student's best friend"
  - `JACKS` — "they live up north and love to gloat"
  - `CLASS` — "starts at eight whether you are ready or not"
  - `ALARM` — "the most hated sound on a Tuesday"
  - `FROST` — "why the walk across campus gets slippery"

Words from the bundled fallback dictionary have no authored hint, so tier one
falls back to a letter. The RA can add or edit a hint on any word from the admin
page.

## Daily word generation

- At 00:00 `America/Chicago` every day, the scheduler picks the word for the new
  day, automatically. No page visit, no RA action.
- Selection order:
  1. A word the RA explicitly scheduled for that date wins.
  2. Otherwise a random unused word from the RA's pool (`day IS NULL`).
  3. Otherwise a random word from the bundled five-letter answer dictionary, so
     the door always has a puzzle.
- Repeats are avoided within the last 180 days when any unused candidate exists.
  Only the date is unique, so a word may eventually come back — which is
  expected over months of play.
- The scheduler keeps an in-process timer aimed at the next local midnight and
  recomputes it after each fire. On boot, and on the first request of a day, a
  catch-up check assigns the word if the process was down at midnight. The
  assignment is a single transaction against the `day` unique index, so
  catch-up and the timer cannot produce two different words.
- The admin page shows a 14-day forward preview of assigned and pending days, so
  the RA can see exactly what is coming and can override any date.
- If both the pool and bundled dictionary are somehow empty, `GET /api/today`
  returns 200 with `{status: "no_word"}` and the page shows "No word today —
  poke your RA," rather than an error. This is a last-resort state, not a
  normal operating mode.

## Feedback and timing correctness

- Wordle feedback is computed server-side with correct two-pass duplicate
  handling (greens first, then yellows against remaining letters). The answer
  never leaves the server until the attempt is finished.
- The server is the only clock. The client displays a timer derived from
  `started_at` plus the server's current time, correcting for drift on each
  response.
- Sub-1.2-second solves are accepted but flagged `suspicious` rather than
  auto-rejected; fast humans and pasted answers look different in the guess log.
- Rate limits key on the device id: 60 guesses per minute, 10 session/start
  calls per minute. IP-based limits are deliberately not used, because
  Tailscale Funnel presents every request from localhost and dorm residents can
  share a NAT address; `X-Forwarded-For`, if present, is logged for diagnostics
  only.
- Names are limited to 1–20 characters from letters, digits, spaces, hyphens and
  apostrophes, and are stored parameterized. No HTML is echoed raw.

## Hall of Fame and month board

No separate archive table. Every board is derived from `attempts` at read time:

- Month view lists the current month's longest streaks, tie-broken by that
  month's fastest solve.
- When a month ends, its winner is still derivable, so "Hall of Fame" is simply
  the list of past months with their fastest solve and longest streak.
- Cross-month streaks are reported per month, so a streak that spans a month
  boundary counts its in-month portion on that month's board. The rule is stated
  on the board itself.

## Frontend experience

Screens are one page with three views: Play, Board, Admin (admin only).

- **First tap:** hall name, today's date, name field focused, one big Play
  button. If the device already played today, it opens on the result and the
  leaderboard instead.
- **Play:** 6×5 tile board, on-screen keyboard plus hardware keyboard support,
  flip animation on reveal (250 ms), shake on invalid or duplicate word, a Hint
  button that shows the 20-second cost, and a live timer that starts on the
  first keypress.
- **Finish:** solved or not, the result sheet shows the official time, today's
  standing, a copyable emoji grid plus time for the floor GroupMe, and buttons
  for Practice and Leaderboard.
- **Board:** three tabs — Today, This Week, This Month. Week shows the single
  fastest solve with hint marker and tie-break order; Month shows streaks and
  the derived Hall of Fame.
- Layout is `100dvh` with safe-area insets, no page scroll during play,
  thumb-sized keys, and system font stack. `prefers-reduced-motion` disables
  flips and confetti. Dark theme by default with a single accent color the RA
  can change in CSS.
- Web app manifest so the page can be added to a home screen. No service worker
  in v1, so a deploy is never masked by a stale cache.

## Performance approach

- No framework, no hydration, no external assets; system fonts.
- Server responses are JSON only; gzip/brotli enabled.
- Bottleneck on a guess is one round trip to a box on the same campus network,
  expected under 100 ms.
- The tile for a pressed key responds immediately; colors paint as soon as the
  response lands.
- Caching without a build step: `index.html` is `no-store`, and `app.js` /
  `app.css` are requested with a manual `?v=N` query the RA bumps after editing,
  served `immutable` for a year. No content hashes, no bundler.

## Deployment

1. On the Fujitsu: Node 22, `git`, build tools for `better-sqlite3`.
2. Clone the repo to `/opt/emry-wordle`, `npm ci --omit=dev`, create
   `/etc/emry-wordle.env` with `ADMIN_TOKEN` and paths.
3. `systemd` unit `emry-wordle.service` running as a dedicated user with
   `Restart=always`.
4. `tailscale funnel --bg 3000`, then verify from a phone on cellular, not the
   tailnet.
5. Reprogram the door's NFC sticker to the Funnel URL. Tag content is
   rewritable; if a vanity domain is added later, the sticker is updated once.
6. Nightly backup timer plus a health check that logs a failed HTTP response.

## Testing

- Unit: feedback algorithm including duplicate letters; name normalization;
  elapsed-time computation; tie-break ordering; word selection order
  (scheduled > pool > dictionary) and the 180-day repeat cooldown; hint
  validation rejects descriptions containing the answer or its stem.
- Integration: automatic midnight assignment advances exactly one day; DST
  spring-forward and fall-back nights fire at local midnight; server down at
  midnight assigns on boot; concurrent catch-up cannot create two words for one
  day; hint tier one returns the description then tier two a letter, with letter
  fallback when no description exists; start-on-keypress, refresh-resume, second
  ranked attempt refused, hint penalty, day rollover, practice excluded from
  rankings, practice cannot target today's word, `no_word` only when every
  source is empty, disqualify removes a row from boards without freeing the day,
  cookie-clear produces a new device flagged as suspicious.
- Manual: iPhone Safari and Android Chrome over cellular, keyboard behavior,
  6×5 fit on the smallest common screen, reduced motion.
- Load sanity: a few hundred simulated daily players against the box.

## Risks and mitigations

- **Dorm network blocks outbound or slows Tailscale:** verify Funnel from
  cellular before printing the sticker; fall back to Cloudflare Tunnel.
- **Prize disputes:** every attempt stores guesses, timestamps, hints and a
  suspicious flag; disqualification is a soft flag with a reason, kept as
  evidence.
- **Cookie clearing or a new device:** accepted cheat vector; new devices with
  fast solves are flagged for RA review.
- **Typo or duplicate display names:** harmless for ranking, since identity is
  the device; the RA can rename the device for a clean board.
- **Word list quality:** RA owns the curated list, the app ships a bundled
  five-letter dictionary as the automatic fallback, the 180-day cooldown keeps
  repeats rare, and the admin page previews the next 14 days so surprises are
  visible.

## Left to the builder

- Exact visual styling, accent color, and any hall-specific copy.
- Final curation of the themed seed list and its hints; a starter list is
  drafted with the build, and the RA adds floor inside jokes over time.
- Concrete UI polish for the result share text.
- Rate-limit numbers, suspicious-time threshold, and backup retention tuning.
- Seed data and migration/seed scripts.
- Whether the admin page is a separate HTML file or a section of the main page.
