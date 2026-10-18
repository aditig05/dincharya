import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }); // Vercel caps bodies at 4.5 MB

const BASE = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const CHAT_MODEL = 'sarvam-105b';
const STT_MODEL = 'saaras:v4';
const TTS_MODEL = 'bulbul:v3';
const TTS_SPEAKER = process.env.TTS_SPEAKER || 'priya';
const CATEGORIES = ['work', 'study', 'meal', 'break', 'exercise', 'sleep', 'commute', 'chores', 'social', 'leisure', 'personal', 'other'];

// Languages Bulbul can speak (Saaras understands 22 Indian languages + English for input).
const LANGUAGES = {
  'hi-IN': { name: 'Hindi', script: 'Devanagari' }, 'en-IN': { name: 'English', script: 'Latin' },
  'bn-IN': { name: 'Bengali', script: 'Bengali' }, 'ta-IN': { name: 'Tamil', script: 'Tamil' },
  'te-IN': { name: 'Telugu', script: 'Telugu' }, 'kn-IN': { name: 'Kannada', script: 'Kannada' },
  'ml-IN': { name: 'Malayalam', script: 'Malayalam' }, 'mr-IN': { name: 'Marathi', script: 'Devanagari' },
  'gu-IN': { name: 'Gujarati', script: 'Gujarati' }, 'pa-IN': { name: 'Punjabi', script: 'Gurmukhi' },
  'od-IN': { name: 'Odia', script: 'Odia' },
};
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
  const h = hits.get(req.ip);
  if (!h || h.reset < now) { hits.set(req.ip, { count: 1, reset: now + RATE_WINDOW_MS }); return next(); }
  if (++h.count > RATE_MAX) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  next();
}

class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
const fail = (res, e, fallback) => res.status(e.status || 500).json({ error: e.status ? e.message : fallback });

function requireKey() {
  if (!process.env.SARVAM_API_KEY) throw new ApiError('Server is missing SARVAM_API_KEY.', 500);
  return process.env.SARVAM_API_KEY;
}

async function callSarvam(url, init) {
  try { return await fetch(url, init); }
  catch { throw new ApiError('Could not reach Sarvam. Check the internet connection.', 502); }
}

async function sarvamError(r) {
  let msg = `Sarvam API returned ${r.status}`;
  try { const b = await r.json(); const d = b?.error?.message || b?.message; if (d) msg += `: ${d}`; } catch { /* not JSON */ }
  if (r.status === 429) msg = 'Sarvam rate limit or quota reached. Wait a moment and try again.';
  if (r.status === 401 || r.status === 403) msg = 'Sarvam rejected the API key. Check SARVAM_API_KEY.';
  return new ApiError(msg, 502);
}

// reasoning_effort: null turns off sarvam-105b's hidden thinking: ~0.5 s instead of 5-15 s,
// and plenty accurate for short extraction and summaries.
async function chat(messages, maxTokens = 1500, { reasoning = false } = {}) {
  const r = await callSarvam(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': requireKey() },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.1, max_tokens: maxTokens, ...(reasoning ? {} : { reasoning_effort: null }) }),
  });
  if (!r.ok) throw await sarvamError(r);
  const text = (await r.json())?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new ApiError('The model returned an empty answer. Please try again.');
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function speak(text, code) {
  const r = await callSarvam(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': requireKey() },
    body: JSON.stringify({ text: text.slice(0, 2500), language_code: code, model: TTS_MODEL, speaker: TTS_SPEAKER, output_audio_codec: 'mp3' }),
  });
  if (!r.ok) throw await sarvamError(r);
  return (await r.json())?.audios?.[0] || null;
}
const speakQuietly = (text, code) => speak(text, code).catch(() => null); // text still shows if voice fails

// ---------- speech -> text (Saaras) ----------
app.post('/api/transcribe', rateLimit, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file?.size) throw new ApiError('No audio received. Tap the mic, speak, then tap again.', 400);
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: (req.file.mimetype || 'audio/webm').split(';')[0] }), req.file.originalname || 'speech.webm');
    form.append('model', STT_MODEL);
    form.append('language_code', 'unknown'); // auto-detect Hindi, English, a mix, or any of 22 Indian languages
    const r = await callSarvam(`${BASE}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': requireKey() }, body: form });
    if (!r.ok) throw await sarvamError(r);
    const transcript = ((await r.json())?.transcript || '').trim();
    if (!transcript) throw new ApiError('Could not hear any speech. Try again closer to the mic.', 422);
    res.json({ transcript });
  } catch (e) { fail(res, e, 'Transcription failed.'); }
});

// ---------- what they said -> activity records ----------
// The model returns times as small specs ("now", "30 minutes ago", "at 14:00", "for 90 minutes");
// the browser turns them into real timestamps, so date arithmetic never depends on the model.
const mealAt = (min) => { const h = (((min % 1440) + 1440) % 1440) / 60; return h < 11 ? 'Breakfast' : h < 16 ? 'Lunch' : h < 19 ? 'Snacks' : 'Dinner'; };

const UNDERSTAND_SYSTEM = (now, weekday, current, code) => `You turn what a person says about their day into activity records. They speak English, Hindi, Hinglish or any Indian language; the text may come from speech recognition and have small mistakes.

Current local date and time: ${now} (${weekday}).
Current activity: ${current || 'none'}.
If they say they are eating now without naming the meal, it is "${/T\d\d:\d\d/.test(now) ? mealAt(Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16))) : 'Meal'}"; use that word in the title and the reply.

Reply with ONLY a JSON object:
{"action":"start|stop|log|unclear","activities":[{"title":"","category":"","start":{"type":"now|ago|at","minutes":0,"time":"HH:MM","day":"today|yesterday"},"end":{"type":"open|duration|at|now","minutes":0,"time":"HH:MM"},"note":""}],"reply":""}

Actions:
- "start": they are starting something now ("taking a break", "lunch kar rahi hoon", "ab 3 ghante DSA karungi", "going to the gym", "sone ja rahi hoon"). Exactly one activity. start.type is "now", unless they say they began earlier ("10 min pehle shuru kiya" = ago 10) or give a start clock time. end.type is "duration" if they give a length ("half an hour" = 30, "dedh ghanta" = 90, "3 hours" = 180, "15 min" = 15), "at" if they give an end time ("5 baje tak"), otherwise "open".
- "log": they describe something already finished ("2 se 5 tak DSA kiya", "subah 1 ghanta gym gayi thi", "had lunch from 1 to 1:30", "kal raat 11 se 7 tak soyi"). One or more activities with start "at"/"ago" and end "at"/"duration"/"now".
- "stop": they finished the current activity without starting something new ("done", "ho gaya", "break khatam", "back"). "activities" is [].
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

app.post('/api/understand', rateLimit, async (req, res) => {
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

    let action = ['start', 'stop', 'log', 'unclear'].includes(parsed.action) ? parsed.action : 'unclear';
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
    if (action === 'stop' || action === 'unclear') activities = [];
    let reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '';
    if (mealFix) reply = reply.replace(/\b(breakfast|lunch|dinner|snacks?)\b/gi, mealFix.toLowerCase());

    const audio = req.body?.speak && reply ? await speakQuietly(reply, code) : null;
    res.json({ action, activities, reply, audio });
  } catch (e) { fail(res, e, 'Could not understand that.'); }
});

// ---------- spoken summary of a day ----------
app.post('/api/summary', rateLimit, async (req, res) => {
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
    ], 800); // the browser computes every number, so no slow reasoning is needed
    res.json({ summary, audio: await speakQuietly(summary, code) });
  } catch (e) { fail(res, e, 'Could not summarise the day.'); }
});

// ---------- cloud sync (Postgres) ----------
// Single-user app: one passcode (SYNC_PASSCODE) unlocks the log. The browser keeps its own copy and
// syncs changes; each row carries updated_at (last write wins) and synced_at (server cursor).
const db = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
let schemaReady = null;
const ensureSchema = () => (schemaReady ??= db.query(`
  CREATE TABLE IF NOT EXISTS dincharya_entries (
    id text PRIMARY KEY,
    title text NOT NULL,
    category text NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz,
    note text NOT NULL DEFAULT '',
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS dincharya_entries_synced ON dincharya_entries (synced_at);
`).catch((e) => { schemaReady = null; throw e; }));

function requireSync(req) {
  if (!db) throw new ApiError('Cloud sync is not set up on the server.', 503);
  const want = process.env.SYNC_PASSCODE || '';
  const got = String(req.get('x-sync-passcode') || '');
  const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) throw new ApiError('Wrong passcode.', 401);
}

const ID_RE = /^[\w-]{8,64}$/;
const asDate = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; };

app.get('/api/sync/status', (req, res) => res.json({ cloud: !!db }));

// returns rows changed since the cursor (all rows on first sync)
app.get('/api/entries', async (req, res) => {
  try {
    requireSync(req);
    await ensureSchema();
    const since = asDate(req.query.since);
    const { rows } = await db.query(
      `SELECT id, title, category, start_at, end_at, note, deleted, updated_at, synced_at FROM dincharya_entries
       WHERE ($1::timestamptz IS NULL OR synced_at > $1) ORDER BY synced_at LIMIT 5000`,
      [since],
    );
    const cursor = rows.length ? rows[rows.length - 1].synced_at : since;
    res.json({
      cursor,
      entries: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, start: r.start_at, end: r.end_at,
        note: r.note, deleted: r.deleted, updatedAt: r.updated_at,
      })),
    });
  } catch (e) { fail(res, e, 'Could not load from the cloud.'); }
});

// upserts changed rows; an older edit never overwrites a newer one
app.post('/api/entries', async (req, res) => {
  try {
    requireSync(req);
    await ensureSchema();
    const list = (Array.isArray(req.body?.entries) ? req.body.entries : []).slice(0, 500);
    let saved = 0;
    for (const e of list) {
      const start = asDate(e?.start), updated = asDate(e?.updatedAt), end = e?.end ? asDate(e.end) : null;
      if (!ID_RE.test(String(e?.id)) || !start || !updated) continue;
      const r = await db.query(
        `INSERT INTO dincharya_entries (id, title, category, start_at, end_at, note, deleted, updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category, start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at, note = EXCLUDED.note, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at,
           synced_at = clock_timestamp()
         WHERE dincharya_entries.updated_at < EXCLUDED.updated_at`,
        [e.id, String(e.title || '').slice(0, 60) || 'Untitled', CATEGORIES.includes(e.category) ? e.category : 'other',
          start, end, String(e.note || '').slice(0, 200), !!e.deleted, updated],
      );
      saved += r.rowCount;
    }
    res.json({ saved });
  } catch (e) { fail(res, e, 'Could not save to the cloud.'); }
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
