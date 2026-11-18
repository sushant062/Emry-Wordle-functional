# Emry Wordle

The daily word game for Emry Hall 1st floor. One word a day, one ranked attempt per
device, server-timed, with a weekly prize for the fastest solve and a monthly bonus
for the longest streak.

Stack: Node 22+ (tested on Node 24), Hono, better-sqlite3, and a dependency-free
vanilla frontend. No build step.

## Rules the server enforces

- One ranked attempt per device per day. A device is an httpOnly cookie; the name
  typed each game is just a display label.
- The clock starts on the first letter and stops when the puzzle finishes. Elapsed
  time is computed on the server, so a paused or reloaded tab resumes the real
  clock.
- Two hints per ranked puzzle, +20 seconds each. Tier 1 is a curated clue; tier 2
  reveals one unknown correctly placed letter.
- Weekly winner is the fastest single solve Monday–Sunday (America/Chicago); ties
  break on fewer hints, then earlier finish. Monthly longest streak earns the
  bonus. Practice attempts never rank.
- Guesses after midnight Central are refused; the next word is assigned
  automatically at 00:00.

## Run it locally

The fastest path is the dev script — it builds a fresh in-memory database, seeds
the themed pool, and picks today's word for you:

```sh
npm ci
npm run dev
```

Open <http://localhost:3999>. The admin page is at
<http://localhost:3999/admin> (token `devtoken`; override with
`ADMIN_TOKEN=... npm run dev` or change the port with `PORT=...`).

To run against a persistent database the way production does:

```sh
npm ci
ADMIN_TOKEN=dev-token DB_PATH=:memory: PORT=3000 npm start
```

Open <http://localhost:3000>. The admin page is at <http://localhost:3000/admin>;
use the token you set. `DB_PATH=:memory:` starts from an empty database — run
`node scripts/seed.js` first (with the same `DB_PATH`) if you want the themed
words available.

Run the tests with `npm test` (Node's built-in runner; no extra dependencies).

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_PATH` | `/var/lib/emry-wordle/emry.db` | SQLite file (use `:memory:` for a throwaway run) |
| `ADMIN_TOKEN` | *(required in production)* | 32+ random characters; gates `/admin` and `/api/admin/*` |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; keep localhost so only Tailscale exposes it |
| `NODE_ENV` | *(unset)* | `production` makes the boot checks strict and cookies `Secure` |

Generate a token with `openssl rand -hex 32`. Rotating it logs every admin out.

## Deploy on the Fujitsu box

These steps assume Debian, Tailscale already installed, and the repo at
<https://github.com/sushant062/Emry-Wordle-functional>.

**Shortcut:** `sudo bash deploy/setup.sh` does steps 1–9 below idempotently —
installs Node 22 if needed, creates the user and directories, clones or updates
the code, writes `/etc/emry-wordle.env` with a fresh token if none exists,
seeds the pool, installs the systemd unit, health-checks it, sets up the nightly
backup, and enables Funnel. Re-running it after a `git push` is the update path.
Set `SKIP_FUNNEL=1` to leave Funnel alone.

The individual steps, if you want to do them by hand:

1. **Install Node 22 or newer** (NodeSource or the distro package):

   ```sh
   node --version   # must be >= 22
   ```

2. **Create the service user and directories.**

   ```sh
   sudo useradd --system --home /opt/emry-wordle --shell /usr/sbin/nologin emry
   sudo mkdir -p /opt/emry-wordle /var/lib/emry-wordle
   sudo chown -R emry:emry /opt/emry-wordle /var/lib/emry-wordle
   ```

3. **Clone and install production dependencies.**

   ```sh
   sudo -u emry git clone https://github.com/sushant062/Emry-Wordle-functional.git /opt/emry-wordle
   cd /opt/emry-wordle
   sudo -u emry npm ci --omit=dev
   ```

4. **Write the environment file** (mode `600`, owned by root so the token is not
   readable by the game process beyond its own environment):

   ```sh
   sudo install -m 600 -o root -g root /dev/null /etc/emry-wordle.env
   sudo tee /etc/emry-wordle.env >/dev/null <<EOF
   NODE_ENV=production
   ADMIN_TOKEN=$(openssl rand -hex 32)
   DB_PATH=/var/lib/emry-wordle/emry.db
   PORT=3000
   EOF
   ```

5. **Seed the themed word pool** and assign today's word.

   ```sh
   sudo -u emry env DB_PATH=/var/lib/emry-wordle/emry.db node /opt/emry-wordle/scripts/seed.js
   ```

   Re-running the script is safe: it skips words already in the pool.

6. **Install the systemd unit.**

   ```sh
   sudo cp /opt/emry-wordle/systemd/emry-wordle.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now emry-wordle
   systemctl status emry-wordle --no-pager
   curl -s localhost:3000/api/today
   ```

   The unit keeps the process on `127.0.0.1`, restarts on failure, and only lets
   it write under `/var/lib/emry-wordle`.

7. **Expose it through Tailscale Funnel.**

   ```sh
   sudo tailscale funnel --bg 3000
   tailscale funnel status
   ```

   Use the printed `https://<machine>.<tailnet>.ts.net` URL. No domain purchase is
   needed. Funnel gives you a public HTTPS URL; the game itself still has no
   passwords beyond the device cookie.

8. **Verify from a phone on cellular** (not the dorm Wi-Fi), then program the NFC
   sticker with that URL using NFC Tools or the built-in Android/iOS writer.
   Tapping the sticker opens the game directly.

9. **Back it up.** The database is a single SQLite file in WAL mode. A nightly
   online backup is enough:

   ```sh
   sudo mkdir -p /var/backups/emry-wordle
   sudo crontab -e
   ```

   Add:

   ```cron
   0 4 * * * sqlite3 /var/lib/emry-wordle/emry.db ".backup '/var/backups/emry-wordle/emry-$(date +\%F).db'"
   ```

   Copy those files off the box occasionally with `scp` or `rsync`; a backup on
   the same disk is not a backup.

### Updating

```sh
cd /opt/emry-wordle
sudo -u emry git pull --ff-only
sudo -u emry npm ci --omit=dev
sudo systemctl restart emry-wordle
```

The frontend assets are served `immutable` with a `?v=N` query string. After
editing `public/app.css`, `public/app.js`, or `/share.js`, bump the matching
`?v=N` in `public/index.html` (and the import in `public/app.js`) before pushing,
or phones will keep the old file.

## Admin

`/admin` is a single page: unlock with `ADMIN_TOKEN`, then schedule words for a
day (or add them to the pool), preview the next two weeks, review attempts for a
day, disqualify or reinstate a solve, rename a device, and export CSV.

- Disqualifying keeps the row and the day locked; the solve disappears from every
  leaderboard.
- Deleting a word that has already been played is refused.
- Clues that contain the answer are rejected with `hint_leaks`.

## Layout

```
src/app.js          Hono app: public API, static files, admin mount
src/admin.js        admin routes, token cookie, CSV export
src/attempts.js     ranked attempt lifecycle, guesses, hints
src/leaderboard.js  day/week/month boards, streaks, Hall of Fame
src/words.js        word assignment, pool, scheduler, clue checks
src/server.js       boot, environment, signal handling
src/share.js        shared result-text formatter (also served at /share.js)
public/             phone-first UI, admin page, manifest, icon
data/               seed words/clues, answer and allowed dictionaries
scripts/seed.js     idempotent pool seeding
scripts/dev.js      in-memory dev server (`npm run dev`)
systemd/            service unit
test/               node:test suites
```

## Performance

The server gzips responses (Hono's `compress` middleware), so phones download the
small numbers below. Measured with `curl -H 'Accept-Encoding: gzip'` against
`npm start` on the development machine; the Fujitsu box and Tailscale Funnel will
add a little network time. Combined gzipped frontend: **≈ 10.5 KB** (target was
under 30 KB). `/api/today` is **≈ 7 ms warm** locally (target was under 100 ms).

| Resource | Size (gzip) | Time |
| --- | --- | --- |
| `/` | 848 B | 64 ms cold, then fast |
| `/app.js` | 7.2 KB | 30 ms cold |
| `/app.css` | 2.4 KB | 8 ms |
| `/share.js` | 463 B | 8 ms |
| `/api/today` | 123 B | 7 ms warm |

Re-run the same numbers on the deployed box with:

```sh
for p in / /app.js /app.css /api/today; do
  curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w "$p %{size_download} %{time_total}\n" "http://localhost:3000$p"
done
```
