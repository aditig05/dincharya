// API tests against the real Express app, with a fake Sarvam server (no AI credits used).
// Database tests run when TEST_DATABASE_URL points at a throwaway Postgres (CI provides one).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

// a fake Sarvam: replies with whatever the current test queued
let nextChat = '{}';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: nextChat } }] }));
    if (req.url.startsWith('/text-to-speech')) return res.end(JSON.stringify({ audios: ['AAAA'] }));
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => fake.listen(0, r));

// environment must be set before the app is imported (dotenv never overrides what is already set)
Object.assign(process.env, {
  NO_LISTEN: '1', DEV_LOGIN: '1', AI_PROVIDER: 'sarvam', SARVAM_API_KEY: 'test', GROQ_API_KEY: '', GEMINI_API_KEY: '',
  SARVAM_BASE_URL: `http://127.0.0.1:${fake.address().port}`, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: process.env.TEST_DATABASE_URL || '', RATE_LIMIT_PER_10_MIN: '1000',
});
delete process.env.VERCEL;
const { default: app, CSP } = await import('../server.js');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fake.close(); });

const req = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(BASE + path, {
  method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
async function signIn(email) {
  const r = await req('/api/auth/dev', { method: 'POST', body: { email } });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  return set.split(';')[0];
}
// unique per run, so a reused test database never mixes runs
const RUN = Date.now().toString(36);
let alice;
before(async () => { alice = await signIn(`alice-${RUN}@test`); });

test('config is public and names the Google client', async () => {
  const d = await (await req('/api/config')).json();
  assert.equal(d.googleClientId, 'test-client.apps.googleusercontent.com');
  assert.equal(d.devLogin, true);
});

test('AI and data routes refuse requests without sign-in', async () => {
  for (const [path, method] of [['/api/understand', 'POST'], ['/api/ask', 'POST'], ['/api/summary', 'POST'], ['/api/entries', 'GET'], ['/api/auth/me', 'GET']]) {
    const r = await req(path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, path);
  }
});

test('a forged or tampered session cookie is rejected', async () => {
  const r = await req('/api/auth/me', { cookie: alice.slice(0, -4) + 'abcd' });
  assert.equal(r.status, 401);
});

test('a signed-in user can see who they are', async () => {
  const d = await (await req('/api/auth/me', { cookie: alice })).json();
  assert.equal(d.user.email, `alice-${RUN}@test`);
});

test('cross-site POSTs are blocked', async () => {
  const r = await req('/api/understand', { method: 'POST', body: { text: 'x' }, cookie: alice, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('security headers are set, and match vercel.json', async () => {
  const r = await req('/api/config');
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
  const staticCsp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.equal(staticCsp, CSP, 'vercel.json CSP is out of date: regenerate it from server.js');
});

test('understand: model output is cleaned before it reaches the app', async () => {
  nextChat = JSON.stringify({
    action: 'start',
    activities: [{ title: 'Khana', category: 'meal', start: { type: 'now' }, end: { type: 'duration', minutes: 99999 } }, { title: 'Extra', category: 'x' }],
    reply: 'Logged your dinner.',
  });
  const d = await (await req('/api/understand', { method: 'POST', cookie: alice, body: { text: 'khana kha rahi hoon', now: '2026-10-18T08:30', language_code: 'en-IN' } })).json();
  assert.equal(d.action, 'start');
  assert.equal(d.activities.length, 1, 'start keeps one activity');
  assert.equal(d.activities[0].title, 'Breakfast', 'generic meal follows the clock');
  assert.equal(d.activities[0].end.minutes, 24 * 60, 'duration is capped');
  assert.equal(d.reply, 'Logged your breakfast.', 'reply matches the corrected meal');
});

test('understand: a broken model reply becomes a clear error', async () => {
  nextChat = 'sorry, no json here';
  const r = await req('/api/understand', { method: 'POST', cookie: alice, body: { text: 'hmm', now: '2026-10-18T10:00' } });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Could not understand/);
});

test('sign-out clears the session cookie', async () => {
  const r = await req('/api/auth/logout', { method: 'POST', cookie: alice });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

const dbTest = process.env.TEST_DATABASE_URL ? test : test.skip;

dbTest('sync: entries round-trip, newer edits win, and users never see each other', async () => {
  const bob = await signIn(`bob-${RUN}@test`);
  const e = { id: `entry-${RUN}`, title: 'DSA', category: 'study', start: '2026-10-18T04:00:00Z', end: '2026-10-18T06:00:00Z', note: '', deleted: false, updatedAt: '2026-10-18T06:00:00Z' };
  assert.equal((await (await req('/api/entries', { method: 'POST', cookie: alice, body: { entries: [e] } })).json()).saved, 1);
  // an older edit must not overwrite
  await req('/api/entries', { method: 'POST', cookie: alice, body: { entries: [{ ...e, title: 'old', updatedAt: '2026-10-18T05:00:00Z' }] } });
  const mine = await (await req('/api/entries', { cookie: alice })).json();
  assert.equal(mine.entries.find((x) => x.id === e.id).title, 'DSA');
  const theirs = await (await req('/api/entries', { cookie: bob })).json();
  assert.equal(theirs.entries.length, 0, 'bob sees none of alice\'s entries');
  // cursor: nothing new since the last pull
  const again = await (await req(`/api/entries?since=${encodeURIComponent(mine.cursor)}`, { cookie: alice })).json();
  assert.equal(again.entries.length, 0);
});

dbTest('settings are saved per user', async () => {
  const r = await req('/api/settings', { method: 'PUT', cookie: alice, body: { settings: { goals: { study: 240 } } } });
  assert.equal(r.status, 200);
  const d = await (await req('/api/settings', { cookie: alice })).json();
  assert.equal(d.settings.goals.study, 240);
});

dbTest('deleting the account removes everything', async () => {
  const carol = await signIn(`carol-${RUN}@test`);
  await req('/api/entries', { method: 'POST', cookie: carol, body: { entries: [{ id: `entry-carol-${RUN}`, title: 'Walk', category: 'exercise', start: '2026-10-18T01:00:00Z', end: null, note: '', deleted: false, updatedAt: '2026-10-18T01:00:00Z' }] } });
  assert.equal((await req('/api/account', { method: 'DELETE', cookie: carol })).status, 200);
  const again = await signIn(`carol-${RUN}@test`);
  const d = await (await req('/api/entries', { cookie: again })).json();
  assert.equal(d.entries.length, 0);
});
