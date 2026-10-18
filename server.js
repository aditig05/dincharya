import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { ApiError, chat, transcribe, speakQuietly, providerKeys } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }); // Vercel caps bodies at 4.5 MB

const CATEGORIES = ['work', 'study', 'meal', 'break', 'exercise', 'sleep', 'commute', 'chores', 'social', 'leisure', 'personal', 'other'];

// The app works in Hindi and English only.
const LANGUAGES = { 'hi-IN': { name: 'Hindi', script: 'Devanagari' }, 'en-IN': { name: 'English', script: 'Latin' } };
const langCode = (l) => (LANGUAGES[l] ? l : 'en-IN');
const replyIn = (code) => (code === 'en-IN' ? 'simple English' : `simple ${LANGUAGES[code].name}, written entirely in ${LANGUAGES[code].script} script`);

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // local only; Vercel serves public/ from its CDN

// AI calls spend Sarvam credits, so cap each visitor (in memory, per instance: a speed bump, not a quota).
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_10_MIN) || 80;
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  if (hits.size > 5000) for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
  const who = req.user?.id || req.ip; // per account once signed in
  const h = hits.get(who);
  if (!h || h.reset < now) { hits.set(who, { count: 1, reset: now + RATE_WINDOW_MS }); return next(); }
  if (++h.count > RATE_MAX) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  next();
}

const fail = (res, e, fallback) => res.status(e.status || 500).json({ error: e.status ? e.message : fallback });

// AI calls (Sarvam first, free providers if it fails) live in ai.js.

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- speech -> text (Saaras, or Whisper on Groq) ----------
app.post('/api/transcribe', authed, rateLimit, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file?.size) throw new ApiError('No audio received. Tap the mic, speak, then tap again.', 400);
    const { transcript } = await transcribe(req.file);
    res.json({ transcript });
  } catch (e) { fail(res, e, 'Transcription failed.'); }
});

// ---------- what they said -> activity records ----------
// The model returns times as small specs ("now", "30 minutes ago", "at 14:00", "for 90 minutes");
// the browser turns them into real timestamps, so date arithmetic never depends on the model.
const mealAt = (min) => { const h = (((min % 1440) + 1440) % 1440) / 60; return h < 11 ? 'Breakfast' : h < 16 ? 'Lunch' : h < 19 ? 'Snacks' : 'Dinner'; };

const UNDERSTAND_SYSTEM = (now, weekday, current, code) => `You turn what a person says about their day into activity records. They speak English, Hindi or Hinglish; the text may come from speech recognition and have small mistakes.

Current local date and time: ${now} (${weekday}).
Current activity: ${current || 'none'}.
If they say they are eating now without naming the meal, it is "${/T\d\d:\d\d/.test(now) ? mealAt(Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16))) : 'Meal'}"; use that word in the title and the reply.

Reply with ONLY a JSON object:
{"action":"start|stop|log|question|unclear","activities":[{"title":"","category":"","start":{"type":"now|ago|at","minutes":0,"time":"HH:MM","day":"today|yesterday"},"end":{"type":"open|duration|at|now","minutes":0,"time":"HH:MM"},"note":""}],"reply":""}

Actions:
- "start": they are starting something now ("taking a break", "lunch kar rahi hoon", "ab 3 ghante DSA karungi", "going to the gym", "sone ja rahi hoon"). Exactly one activity. start.type is "now", unless they say they began earlier ("10 min pehle shuru kiya" = ago 10) or give a start clock time. end.type is "duration" if they give a length ("half an hour" = 30, "dedh ghanta" = 90, "3 hours" = 180, "15 min" = 15), "at" if they give an end time ("5 baje tak"), otherwise "open".
- "log": they describe something already finished ("2 se 5 tak DSA kiya", "subah 1 ghanta gym gayi thi", "had lunch from 1 to 1:30", "kal raat 11 se 7 tak soyi"). One or more activities with start "at"/"ago" and end "at"/"duration"/"now".
- "stop": they finished the current activity without starting something new ("done", "ho gaya", "break khatam", "back"). "activities" is [].
- "question": they are asking about their log rather than recording something ("kal maine kya kiya?", "is hafte gym kitni baar gayi?", "how much did I study today?", "aaj kitna break liya?"). "activities" is [] and "reply" is "".
- "unclear": it is not about their day, or no activity can be read. "activities" is [].

When one activity follows another ("phir", "then", "uske baad", "after that"), it starts when the previous one ended; never give an activity the same start and end.
Times are 24-hour "HH:MM". Infer am/pm from the current time and common sense: at 13:00, "2 se 5" means 14:00 to 17:00; "subah 7" is 07:00; "raat 11" is 23:00; "dopahar 2" is 14:00. Use day "yesterday" only when they say kal/yesterday about the past.
"title": a short name for the activity, 1 to 4 words, first letter capital, naming the activity rather than repeating their verb ("DSA karungi" -> "DSA practice", "so rahi hoon" -> "Sleep", "khana kha rahi hoon" -> the meal for that time of day (before 11:00 "Breakfast", 11:00-16:00 "Lunch", 16:00-19:00 "Snacks", after 19:00 "Dinner"), "meeting mein hoon" -> "Meeting"). Keep their own words for specific things (a subject, project or person).
"category": one of ${CATEGORIES.join(', ')}.
"note": extra detail they gave, or "".
"reply": one short, friendly sentence confirming what you recorded (or, for "unclear", asking them to try again with an example), in ${replyIn(code)}. No markdown, no emojis.`;

const GENERIC_MEALS = new Set(['breakfast', 'lunch', 'dinner', 'snacks', 'meal', 'khana', 'food', 'nashta', 'eating']);
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
function cleanSpec(spec, kind) {
  const type = String(spec?.type || '');
  const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(spec?.minutes) || 0)));
  const time = typeof spec?.time === 'string' && TIME_RE.test(spec.time.trim()) ? spec.time.trim().padStart(5, '0') : '';
  if (kind === 'start') {
    if (type === 'ago' && minutes) return { type, minutes };
    if (type === 'at' && time) return { type, time, day: spec?.day === 'yesterday' ? 'yesterday' : 'today' };
    return { type: 'now' };
  }
  if (type === 'duration' && minutes) return { type, minutes };
  if (type === 'at' && time) return { type, time };
  if (type === 'now') return { type };
  return { type: 'open' };
}

app.post('/api/understand', authed, rateLimit, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 600) : '';
    if (!text) throw new ApiError('Say or type what you are doing.', 400);
    const now = String(req.body?.now || '').slice(0, 16);
    const weekday = String(req.body?.weekday || '').slice(0, 12);
    const current = typeof req.body?.current === 'string' ? req.body.current.slice(0, 160) : '';
    const code = langCode(req.body?.language_code);

    const answer = await chat([
      { role: 'system', content: UNDERSTAND_SYSTEM(now, weekday, current, code) },
      { role: 'user', content: text },
    ]);
    let parsed;
    try { parsed = extractJson(answer); } catch { throw new ApiError('Could not understand that. Please say it again.', 502); }

    let action = ['start', 'stop', 'log', 'question', 'unclear'].includes(parsed.action) ? parsed.action : 'unclear';
    let activities = (Array.isArray(parsed.activities) ? parsed.activities : []).slice(0, 8).map((a) => ({
      title: String(a?.title || '').trim().slice(0, 60),
      category: CATEGORIES.includes(a?.category) ? a.category : 'other',
      start: cleanSpec(a?.start, 'start'),
      end: cleanSpec(a?.end, 'end'),
      note: String(a?.note || '').trim().slice(0, 200),
    })).filter((a) => a.title);
    let mealFix = '';
    // generic meal names follow the clock (the model isn't reliable about this)
    const nowMin = /T(\d\d):(\d\d)/.test(now) ? Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16)) : null;
    for (const a of activities) {
      if (a.category !== 'meal' || !GENERIC_MEALS.has(a.title.toLowerCase()) || nowMin == null) continue;
      const startMin = a.start.type === 'at' ? Number(a.start.time.slice(0, 2)) * 60 + Number(a.start.time.slice(3)) : a.start.type === 'ago' ? nowMin - a.start.minutes : nowMin;
      const fixed = mealAt(startMin);
      if (fixed !== a.title) { a.title = fixed; mealFix = fixed; }
    }
    if (action === 'start') activities = activities.slice(0, 1);
    if ((action === 'start' || action === 'log') && !activities.length) action = 'unclear';
    if (action === 'stop' || action === 'question' || action === 'unclear') activities = [];
    let reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '';
    if (mealFix) reply = reply.replace(/\b(breakfast|lunch|dinner|snacks?)\b/gi, mealFix.toLowerCase());

    const audio = req.body?.speak && reply ? await speakQuietly(reply, code) : null;
    res.json({ action, activities, reply, audio });
  } catch (e) { fail(res, e, 'Could not understand that.'); }
});

// ---------- questions about the log ----------
// The browser sends the last two weeks as compact lines plus totals it computed itself,
// so the model only has to look things up, never add up.
app.post('/api/ask', authed, rateLimit, async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 400) : '';
    if (!question) throw new ApiError('Ask something about your day.', 400);
    const code = langCode(req.body?.language_code);
    const log = String(req.body?.log || '').slice(0, 20000);
    const answer = await chat([
      {
        role: 'system',
        content: `You answer questions about a person's own activity log, like a helpful friend. Today is ${String(req.body?.today || '').slice(0, 40)}. Use ONLY the log and totals given. Quote durations and counts exactly as they appear in the totals; never add up or calculate new numbers. If the log does not contain the answer, say so plainly. Reply in 1 to 3 short sentences, easy to listen to, in ${replyIn(code)}. No markdown, no lists, no emojis.`,
      },
      { role: 'user', content: `${log}\n\nQuestion: ${question}` },
    ], { maxTokens: 800 });
    res.json({ answer, audio: await speakQuietly(answer, code) });
  } catch (e) { fail(res, e, 'Could not answer that.'); }
});

// ---------- spoken summary of a day ----------
app.post('/api/summary', authed, rateLimit, async (req, res) => {
  try {
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).slice(0, 120).map((l) => String(l).slice(0, 160));
    if (!lines.length) throw new ApiError('Nothing logged on this day yet.', 400);
    const code = langCode(req.body?.language_code);
    const summary = await chat([
      {
        role: 'system',
        content: `You review someone's day from their activity log and talk to them like a supportive friend. In 3 to 4 short sentences: what they spent the most time on, how much was breaks/meals vs focused work or study, anything notable (long gaps, late meals, very long sessions), and one small, practical suggestion for tomorrow. Quote numbers ONLY from the "Facts" section exactly as written; never add, subtract or combine durations yourself (the Facts already include the useful groupings). Base suggestions only on the log, and don't invent things that are not in it. Reply in ${replyIn(code)}. No markdown, no lists, no emojis.`,
      },
      { role: 'user', content: `Date: ${String(req.body?.date || '').slice(0, 30)}\nFacts:\n${String(req.body?.totals || '').slice(0, 800)}\nLog:\n${lines.join('\n')}` },
    ], { maxTokens: 800 }); // the browser computes every number, so no slow reasoning is needed
    res.json({ summary, audio: await speakQuietly(summary, code) });
  } catch (e) { fail(res, e, 'Could not summarise the day.'); }
});

// ---------- accounts: Sign in with Google ----------
// The browser gets an ID token from Google; we verify it against Google's public keys, then keep the
// user signed in with our own signed session cookie (30 days, httpOnly). No passwords are stored.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DEV_LOGIN = !process.env.VERCEL && process.env.DEV_LOGIN === '1'; // local testing only, never on Vercel
const SESSION_COOKIE = 'dc_session';
const SESSION_DAYS = 30;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const sessionKey = () => {
  if (SESSION_SECRET.length < 32) throw new ApiError('Server is missing SESSION_SECRET (32+ characters).', 500);
  return new TextEncoder().encode(SESSION_SECRET);
};

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSession(res, token, maxAgeSec) {
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

async function signIn(res, profile) {
  const user = { id: String(profile.sub), email: String(profile.email || ''), name: String(profile.name || profile.email || 'You').slice(0, 80), picture: String(profile.picture || '') };
  if (db) {
    await ensureSchema();
    await db.query(
      `INSERT INTO dincharya_users (id, email, name, picture) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, last_seen = now()`,
      [user.id, user.email, user.name, user.picture],
    );
  }
  const token = await new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(sessionKey());
  setSession(res, token, SESSION_DAYS * 86400);
  return user;
}

async function currentUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] });
    return { id: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
  } catch { return null; }
}

// every /api route except config and sign-in needs a signed-in user
async function authed(req, res, next) {
  try {
    req.user = await currentUser(req);
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    next();
  } catch (e) { fail(res, e, 'Could not check your sign-in.'); }
}

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_LOGIN, cloud: !!db, ai: providerKeys() }));

app.post('/api/auth/google', rateLimit, async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) throw new ApiError('Google sign-in is not set up on the server (GOOGLE_CLIENT_ID).', 500);
    const credential = String(req.body?.credential || '');
    let payload;
    try {
      ({ payload } = await jwtVerify(credential, googleKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: GOOGLE_CLIENT_ID }));
    } catch { throw new ApiError('Google sign-in could not be verified. Please try again.', 401); }
    if (payload.email && payload.email_verified === false) throw new ApiError('Please use a Google account with a verified email.', 401);
    res.json({ user: await signIn(res, payload) });
  } catch (e) { fail(res, e, 'Sign-in failed.'); }
});

if (DEV_LOGIN) {
  app.post('/api/auth/dev', async (req, res) => {
    try {
      const email = String(req.body?.email || 'dev@localhost').slice(0, 80);
      res.json({ user: await signIn(res, { sub: `dev-${email}`, email, name: email.split('@')[0] }) });
    } catch (e) { fail(res, e, 'Sign-in failed.'); }
  });
}

app.get('/api/auth/me', authed, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', (req, res) => { setSession(res, '', 0); res.json({ ok: true }); });

// ---------- each user's log (Postgres) ----------
// The browser keeps its own copy and syncs changes; each row carries updated_at (last write wins)
// and synced_at (the cursor for "what changed since I last looked").
const db = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
let schemaReady = null;
const ensureSchema = () => (schemaReady ??= db.query(`
  CREATE TABLE IF NOT EXISTS dincharya_users (
    id text PRIMARY KEY,
    email text NOT NULL DEFAULT '',
    name text NOT NULL DEFAULT '',
    picture text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS dincharya_activities (
    user_id text NOT NULL REFERENCES dincharya_users (id) ON DELETE CASCADE,
    id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz,
    note text NOT NULL DEFAULT '',
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS dincharya_activities_sync ON dincharya_activities (user_id, synced_at);
`).catch((e) => { schemaReady = null; throw e; }));

function requireDb() { if (!db) throw new ApiError('Cloud sync is not set up on the server.', 503); }
const ID_RE = /^[\w-]{8,64}$/;
const asDate = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; };

// rows of this user changed since the cursor (all rows on first sync)
app.get('/api/entries', authed, async (req, res) => {
  try {
    requireDb();
    await ensureSchema();
    const since = asDate(req.query.since);
    const { rows } = await db.query(
      `SELECT id, title, category, start_at, end_at, note, deleted, updated_at, synced_at FROM dincharya_activities
       WHERE user_id = $1 AND ($2::timestamptz IS NULL OR synced_at > $2) ORDER BY synced_at LIMIT 5000`,
      [req.user.id, since],
    );
    res.json({
      cursor: rows.length ? rows[rows.length - 1].synced_at : since,
      entries: rows.map((r) => ({ id: r.id, title: r.title, category: r.category, start: r.start_at, end: r.end_at, note: r.note, deleted: r.deleted, updatedAt: r.updated_at })),
    });
  } catch (e) { fail(res, e, 'Could not load from the cloud.'); }
});

// upserts this user's changed rows; an older edit never overwrites a newer one
app.post('/api/entries', authed, async (req, res) => {
  try {
    requireDb();
    await ensureSchema();
    await db.query(`INSERT INTO dincharya_users (id, email, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [req.user.id, req.user.email || '', req.user.name || '']);
    const list = (Array.isArray(req.body?.entries) ? req.body.entries : []).slice(0, 500);
    let saved = 0;
    for (const e of list) {
      const start = asDate(e?.start), updated = asDate(e?.updatedAt), end = e?.end ? asDate(e.end) : null;
      if (!ID_RE.test(String(e?.id)) || !start || !updated) continue;
      const r = await db.query(
        `INSERT INTO dincharya_activities (user_id, id, title, category, start_at, end_at, note, deleted, updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())
         ON CONFLICT (user_id, id) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category, start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at, note = EXCLUDED.note, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at,
           synced_at = clock_timestamp()
         WHERE dincharya_activities.updated_at < EXCLUDED.updated_at`,
        [req.user.id, e.id, String(e.title || '').slice(0, 60) || 'Untitled', CATEGORIES.includes(e.category) ? e.category : 'other',
          start, end, String(e.note || '').slice(0, 200), !!e.deleted, updated],
      );
      saved += r.rowCount;
    }
    res.json({ saved });
  } catch (e) { fail(res, e, 'Could not save to the cloud.'); }
});

// "Delete my account": removes the user and every activity (ON DELETE CASCADE), then signs out
app.delete('/api/account', authed, async (req, res) => {
  try {
    if (db) { await ensureSchema(); await db.query('DELETE FROM dincharya_users WHERE id = $1', [req.user.id]); }
    setSession(res, '', 0);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'Could not delete the account.'); }
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Recording is too large. Keep it under 30 seconds.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Dincharya running on http://localhost:${port}`));
}

export default app;
