import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';

const openDbs = [];
after(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  openDbs.push(db);
  return createApp({ db, now: () => Date.UTC(2026, 10, 17, 18, 0) });
}

test('serves the play page without caching', async () => {
  const app = makeApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /Emry Hall/);
});

test('serves app assets as immutable', async () => {
  const app = makeApp();
  for (const [path, type] of [
    ['/app.js?v=1', /javascript/],
    ['/share.js', /javascript/],
    ['/app.css?v=1', /text\/css/],
    ['/icon.svg', /image\/svg\+xml/],
    ['/manifest.webmanifest', /manifest\+json/],
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
    assert.match(res.headers.get('cache-control'), /max-age=31536000|max-age=3600/, path);
  }
});

test('the manifest is valid JSON with a name and icon', async () => {
  const app = makeApp();
  const manifest = JSON.parse(await (await app.request('/manifest.webmanifest')).text());
  assert.equal(manifest.short_name, 'Emry Wordle');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 1);
});

test('missing static assets return 404', async () => {
  const app = makeApp();
  const res = await app.request('/app.js.map');
  assert.equal(res.status, 404);
});

test('page assets reference each other with the cache-busting version', async () => {
  const app = makeApp();
  const html = await (await app.request('/')).text();
  assert.match(html, /\/app\.css\?v=\d+/);
  assert.match(html, /\/app\.js\?v=\d+/);
  assert.match(html, /rel="manifest"/);
});
