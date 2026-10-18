// Dincharya: a voice-first log of your day.
// Everything is saved in this browser first (instant, works offline) and synced to the signed-in
// account in the server's database, so a refresh, a cleared browser or a new phone loses nothing.
const KEYS = { owner: 'dincharya.owner', nudges: 'dincharya.nudges', nudged: 'dincharya.nudged', installNo: 'dincharya.install-no', entries: 'dincharya.entries.v1', dirty: 'dincharya.dirty.v1', cursor: 'dincharya.cursor.v1', lang: 'dincharya.lang', voice: 'dincharya.voice', alerts: 'dincharya.alerts', resume: 'dincharya.resume' };
const MAX_SECONDS = 28; // Sarvam REST speech-to-text accepts up to 30 s
const CATS = {
  work: 'Work', study: 'Study', meal: 'Meal', break: 'Break', exercise: 'Exercise', sleep: 'Sleep',
  commute: 'Commute', chores: 'Chores', social: 'Social', leisure: 'Leisure', personal: 'Personal', other: 'Other',
};
const MIN = 60 * 1000;

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) node.append(k);
  return node;
}
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const catVar = (c) => `var(--c-${CATS[c] ? c : 'other'})`;

// ---------- time helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const atTime = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(day); x.setHours(h, m, 0, 0); return x; };
const fmtTime = (d) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(' ', ' ');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
function fmtClock(ms) { // 12:05 / 1:02:09 countdowns
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
const localNow = () => { const d = new Date(); return `${dayKey(d)}T${hhmm(d)}`; };

// ---------- data ----------
let entries = store.get(KEYS.entries, []);
if (!Array.isArray(entries)) entries = [];
entries = entries.filter((e) => e && e.id && e.start && e.title);
let dirty = new Set(store.get(KEYS.dirty, []));
let selectedDay = dayKey(new Date());
const live = () => entries.filter((e) => !e.deleted);

function save() {
  store.set(KEYS.entries, entries);
  store.set(KEYS.dirty, [...dirty]);
  scheduleSync();
}
function touch(e) { e.updatedAt = new Date().toISOString(); dirty.add(e.id); }

// the activity happening now: started, and not yet ended
function current(now = Date.now()) {
  return live()
    .filter((e) => new Date(e.start).getTime() <= now && (!e.end || new Date(e.end).getTime() > now))
    .sort((a, b) => new Date(b.start) - new Date(a.start))[0] || null;
}
// the most recent planned activity that has just run out (for "Break is over" + "back to …")
function justEnded(now = Date.now()) {
  const e = live()
    .filter((x) => x.planned && x.end && new Date(x.end).getTime() <= now && now - new Date(x.end).getTime() < 30 * MIN)
    .sort((a, b) => new Date(b.end) - new Date(a.end))[0];
  if (!e) return null;
  // only if nothing has been logged since it ended (otherwise the user has moved on)
  const after = live().some((x) => x.id !== e.id && new Date(x.start) >= new Date(e.end) && new Date(x.start).getTime() <= now);
  return after ? null : e;
}

// ---------- undo: every change records what it touched ----------
let lastChange = null;
function beginChange() { return { before: new Map(), created: [] }; }
function remember(change, e) { if (!change.before.has(e.id)) change.before.set(e.id, { ...e }); }
function commitChange(change, message) {
  save(); render();
  lastChange = change;
  toast(message, () => undoChange(change));
}
function undoChange(change) {
  for (const id of change.created) {
    const e = entries.find((x) => x.id === id);
    if (e) { e.deleted = true; touch(e); }
  }
  for (const [id, old] of change.before) {
    const i = entries.findIndex((x) => x.id === id);
    if (i >= 0) { entries[i] = { ...old }; touch(entries[i]); }
  }
  lastChange = null;
  save(); render();
  toast('Undone.');
}

// ---------- turning what the model understood into entries ----------
function resolveStart(spec, now) {
  if (spec.type === 'ago') return new Date(now.getTime() - spec.minutes * MIN);
  if (spec.type === 'at') return atTime(spec.day === 'yesterday' ? addDays(now, -1) : now, spec.time);
  return new Date(now);
}
function resolveEnd(spec, start, now) {
  if (spec.type === 'duration') return new Date(start.getTime() + spec.minutes * MIN);
  if (spec.type === 'now') return new Date(now);
  if (spec.type === 'at') {
    let end = atTime(start, spec.time);
    // ran past midnight (sleep 23:00 → 07:00); only evening starts wrap, anything else is a bad end time
    if (end <= start && start.getHours() >= 17 && addDays(end, 1) - start <= 16 * 60 * MIN) end = addDays(end, 1);
    return end;
  }
  return null; // open: ends when the next thing starts
}

function applyUnderstanding(data) {
  const now = new Date();
  const change = beginChange();
  const cur = current(now.getTime());

  if (data.action === 'stop') {
    if (!cur) return { ok: false, message: 'Nothing is running right now.' };
    remember(change, cur);
    cur.end = now.toISOString();
    cur.planned = false;
    touch(cur);
    commitChange(change, `Stopped ${cur.title}.`);
    return { ok: true };
  }

  const made = [];
  for (const a of data.activities) {
    let start = resolveStart(a.start, now);
    let end = resolveEnd(a.end, start, now);
    // "gym 7 se 8, phir 8:30 tak nashta": a chained activity starts where the previous one ended
    const prev = made[made.length - 1];
    if (end && end <= start && prev?.end && new Date(prev.end) < end) start = new Date(prev.end);
    if (end && end <= start) end = new Date(start.getTime() + 30 * MIN); // still nonsense: assume half an hour, editable
    // a finished activity can't start in the future: "11 se 7 tak soyi" said at 1 pm means last night
    if (data.action === 'log' && start > now) {
      start = addDays(start, -1);
      if (end) end = addDays(end, -1);
    }
    const e = {
      id: newId(), title: a.title, category: a.category, start: start.toISOString(), end: end ? end.toISOString() : null,
      note: a.note || '', deleted: false, planned: !!end && end > now,
    };
    touch(e);
    made.push(e);
  }

  // in a list of past activities, one left open ends where the next one starts
  if (data.action === 'log') {
    made.sort((x, y) => new Date(x.start) - new Date(y.start));
    made.forEach((e, i) => { if (!e.end && made[i + 1]) e.end = made[i + 1].start; });
  }

  // whatever covers "now" becomes the current activity and ends the one before it
  const running = made.find((e) => new Date(e.start) <= now && (!e.end || new Date(e.end) > now));
  if (running && cur && new Date(cur.start) < new Date(running.start)) {
    remember(change, cur);
    if (!cur.end || new Date(cur.end) > new Date(running.start)) {
      // remember what a break/meal interrupted, to offer "Back to …" afterwards
      if (['break', 'meal'].includes(running.category) && !['break', 'meal'].includes(cur.category)) {
        store.set(KEYS.resume, { title: cur.title, category: cur.category, after: running.id });
      }
      cur.end = running.start;
      cur.planned = false;
      if (new Date(running.start) - new Date(cur.start) < MIN) cur.deleted = true; // switched within a minute: a slip, not an activity
      touch(cur);
    }
  }

  entries.push(...made);
  change.created.push(...made.map((e) => e.id));
  // jump to the day of what was just logged
  selectedDay = dayKey(new Date(made[0].start));
  const msg = made.length === 1 ? `Logged ${made[0].title}${made[0].end ? ` · ${fmtTime(new Date(made[0].start))}–${fmtTime(new Date(made[0].end))}` : ` from ${fmtTime(new Date(made[0].start))}`}.` : `Logged ${made.length} activities.`;
  commitChange(change, msg);
  if (made.some((e) => e.planned)) maybeAskAlertPermission();
  return { ok: true };
}

// quick actions from the Now card, no AI needed
function startQuick(title, category, minutes) {
  applyUnderstanding({ action: 'start', activities: [{ title, category, start: { type: 'now' }, end: minutes ? { type: 'duration', minutes } : { type: 'open' }, note: '' }] });
}
function extend(e, minutes) {
  const change = beginChange();
  remember(change, e);
  const base = Math.max(Date.now(), new Date(e.end).getTime());
  e.end = new Date(base + minutes * MIN).toISOString();
  e.planned = true;
  touch(e);
  commitChange(change, `${e.title} extended to ${fmtTime(new Date(e.end))}.`);
}

// ---------- API ----------
async function api(path, options = {}) {
  let res;
  try { res = await fetch(path, options); }
  catch { throw Object.assign(new Error('You seem to be offline.'), { offline: true }); }
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && signedIn && !path.startsWith('/api/auth/')) showSignin('Your session ended. Please sign in again.');
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function setReply(msg, isError = false) { $('reply').textContent = msg; $('reply').classList.toggle('error', isError); }
function busy(btn, on) { btn.disabled = on; btn.classList.toggle('is-busy', on); }

let replyAudio = null;
// audio is a data: URI from the server; without one (all voice services failed) the phone reads the text itself
function play(audio, text) {
  if (!$('voice').checked) return;
  replyAudio?.pause();
  window.speechSynthesis?.cancel();
  if (audio) {
    replyAudio = new Audio(audio);
    replyAudio.play().catch(() => { /* autoplay blocked */ });
  } else if (text && window.speechSynthesis) {
    const pick = phoneVoice(text, $('lang').value);
    if (!pick) { toast('This phone has no Hindi voice. Switch replies to English in Settings to hear them.'); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = pick.lang;
    if (pick.voice) u.voice = pick.voice;
    speechSynthesis.speak(u);
  }
}

// Pick a phone voice for the reply. Devanagari needs a Hindi voice; Hinglish/English text can use an English one.
function phoneVoice(text, lang) {
  const voices = speechSynthesis.getVoices();
  const hindi = voices.find((v) => v.lang?.toLowerCase().startsWith('hi'));
  const english = voices.find((v) => v.lang?.toLowerCase() === 'en-in') || voices.find((v) => v.lang?.toLowerCase().startsWith('en'));
  const devanagari = /[\u0900-\u097F]/.test(text);
  if (devanagari) return hindi ? { voice: hindi, lang: 'hi-IN' } : null;
  if (lang === 'hi-IN' && hindi) return { voice: hindi, lang: 'hi-IN' };
  return { voice: english || null, lang: 'en-IN' };
}


function describeCurrent() {
  const cur = current();
  if (!cur) return '';
  const s = new Date(cur.start);
  return `${cur.title} (${cur.category}) since ${hhmm(s)}${cur.end ? `, planned until ${hhmm(new Date(cur.end))}` : ''}`;
}

async function understand(text) {
  text = text.trim();
  if (!text) { setReply('Say or type what you are doing.', true); return; }
  busy($('say-go'), true);
  setReply('Got it, writing it down…');
  try {
    const data = await api('/api/understand', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, now: localNow(), weekday: new Date().toLocaleDateString('en-IN', { weekday: 'long' }),
        current: describeCurrent(), language_code: $('lang').value, speak: $('voice').checked,
      }),
    });
    if (data.action === 'question') { await askLog(text); return; }
    if (data.action === 'unclear') { setReply(data.reply || 'Try: “taking a 15 minute break”.', true); play(data.audio, data.reply); return; }
    const result = applyUnderstanding(data);
    if (!result.ok) { setReply(result.message, true); return; }
    setReply(data.reply || '');
    play(data.audio, data.reply);
    $('say-text').value = '';
  } catch (e) {
    setReply(e.offline ? 'You are offline, so I can’t understand speech or sentences right now. Use the quick buttons or “Add manually”.' : e.message, true);
  } finally {
    busy($('say-go'), false);
  }
}

$('say-form').onsubmit = (ev) => { ev.preventDefault(); understand($('say-text').value); };
document.querySelectorAll('.chip').forEach((c) => { c.onclick = () => understand(c.dataset.text); });

// ---------- recording ----------
let recorder = null, chunks = [], micStream = null, micTick = null;
function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { setReply('This browser cannot record audio. Type instead.', true); return; }
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { setReply('Microphone blocked. Allow mic access, or type instead.', true); return; }
  chunks = [];
  const mimeType = pickMime();
  recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  recorder.onstop = onRecorded;
  recorder.start();
  const started = Date.now();
  $('mic').setAttribute('aria-pressed', 'true');
  setReply('Listening… tap the mic again when done.');
  micTick = setInterval(() => { if (Date.now() - started > MAX_SECONDS * 1000) stopRecording(); }, 250);
}
function stopRecording() {
  clearInterval(micTick);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  micStream?.getTracks().forEach((t) => t.stop());
  $('mic').setAttribute('aria-pressed', 'false');
}
async function onRecorded() {
  const type = recorder.mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type });
  if (blob.size < 1500) { setReply('That was too short. Tap, speak, then tap again.', true); return; }
  const form = new FormData();
  form.append('audio', blob, `speech.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`);
  $('mic').disabled = true;
  setReply('Listening to that…');
  try {
    const { transcript } = await api('/api/transcribe', { method: 'POST', body: form });
    $('say-text').value = transcript;
    await understand(transcript);
  } catch (e) {
    setReply(e.offline ? 'You are offline. Type instead or use the quick buttons.' : e.message, true);
  } finally {
    $('mic').disabled = false;
  }
}
$('mic').onclick = () => (recorder && recorder.state === 'recording' ? stopRecording() : startRecording());

// ---------- Now card ----------
let alerted = new Set();
function renderNow() {
  const box = $('now-body');
  const card = $('now');
  const now = Date.now();
  const cur = current(now);
  box.replaceChildren();
  card.classList.remove('overdue');

  if (cur) {
    card.style.setProperty('--c', catVar(cur.category));
    const start = new Date(cur.start).getTime();
    box.append(el('p', { className: 'now-title' }, cur.title, el('span', { className: 'cat', textContent: CATS[cur.category] || 'Other' })));
    const actions = el('div', { className: 'now-actions' });
    if (cur.end) {
      const end = new Date(cur.end).getTime();
      const left = end - now;
      box.append(el('p', { className: 'now-meta' }, `${fmtTime(new Date(start))} – ${fmtTime(new Date(end))} · `, el('b', { textContent: fmtClock(left) }), ' left'));
      const bar = el('div', { className: 'bar' }, el('span'));
      bar.firstChild.style.width = `${Math.min(100, ((now - start) / (end - start)) * 100)}%`;
      box.append(bar);
      actions.append(button('+10 min', () => extend(cur, 10)));
    } else {
      box.append(el('p', { className: 'now-meta' }, `Since ${fmtTime(new Date(start))} · `, el('b', { textContent: fmtClock(now - start) })));
      if (now - start > 4 * 60 * MIN) box.append(el('p', { className: 'hint tight', textContent: 'Running for a long time. Forgot to stop it?' }));
    }
    actions.append(button('Done', () => applyUnderstanding({ action: 'stop', activities: [] }), 'primary'));
    if (!['break', 'meal'].includes(cur.category)) actions.append(button('Break 15m', () => startQuick('Break', 'break', 15)));
    box.append(actions);
    return;
  }

  const ended = justEnded(now);
  if (ended) {
    card.style.setProperty('--c', catVar(ended.category));
    card.classList.add('overdue');
    box.append(el('p', { className: 'now-title', textContent: `${ended.title} is over` }));
    box.append(el('p', { className: 'now-meta' }, `Ended ${fmtDur(now - new Date(ended.end).getTime())} ago at ${fmtTime(new Date(ended.end))}.`));
    const actions = el('div', { className: 'now-actions' });
    const resume = store.get(KEYS.resume, null);
    if (resume && resume.after === ended.id) {
      actions.append(button(`Back to ${resume.title}`, () => { store.set(KEYS.resume, null); startQuick(resume.title, resume.category, 0); }, 'primary'));
    }
    actions.append(button('+10 min', () => extend(ended, 10)));
    box.append(actions);
    return;
  }

  card.style.setProperty('--c', 'var(--line)');
  box.append(el('p', { className: 'now-idle', textContent: 'Nothing running. What are you doing?' }));
}
function button(label, onClick, cls = '') {
  const b = el('button', { className: 'btn ' + cls, type: 'button', textContent: label });
  b.onclick = onClick;
  return b;
}

// when a planned activity runs out: sound + (optional) system notification, once
function checkAlerts() {
  const e = justEnded();
  if (!e || alerted.has(e.id) || Date.now() - new Date(e.end).getTime() > 2 * MIN) return;
  alerted.add(e.id);
  chime();
  if ($('alerts').checked) notify(`${e.title} is over`, 'Tap to log what you do next.', e.id);
}
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.25;
      o.frequency.value = f; g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* no sound */ }
}
function maybeAskAlertPermission() {
  if (!$('alerts').checked || !('Notification' in window) || Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => {});
}

// ---------- day view ----------
function dayBounds(key) { const s = fromDayKey(key); return [s.getTime(), addDays(s, 1).getTime()]; }
function entriesOn(key) {
  const [s, e] = dayBounds(key);
  const now = Date.now();
  return live()
    .filter((x) => new Date(x.start).getTime() < e && (x.end ? new Date(x.end).getTime() : Math.max(now, new Date(x.start).getTime())) > s)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function renderDay() {
  const today = dayKey(new Date());
  const d = fromDayKey(selectedDay);
  const label = selectedDay === today ? 'Today' : selectedDay === dayKey(addDays(new Date(), -1)) ? 'Yesterday' : d.toLocaleDateString('en-IN', { weekday: 'long' });
  $('day-h').textContent = label;
  $('date-pick').value = selectedDay;
  $('date-pick').max = today;
  $('next-day').disabled = selectedDay >= today;

  const list = entriesOn(selectedDay);
  const [ds, de] = dayBounds(selectedDay);
  const now = Date.now();
  const clip = (x) => {
    const s = Math.max(ds, new Date(x.start).getTime());
    const e = Math.min(de, x.end ? new Date(x.end).getTime() : now);
    return Math.max(0, Math.min(e, now) - s); // time not yet happened doesn't count
  };

  // totals per category
  const totals = new Map();
  for (const x of list) totals.set(x.category, (totals.get(x.category) || 0) + clip(x));
  const sorted = [...totals].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  const all = sorted.reduce((s, [, ms]) => s + ms, 0);
  const tbox = $('totals');
  tbox.replaceChildren();
  if (all > 0) {
    const stack = el('div', { className: 'stack', title: 'Time by type' });
    const legend = el('div', { className: 'legend' });
    for (const [cat, ms] of sorted) {
      const seg = el('span');
      seg.style.setProperty('--c', catVar(cat));
      seg.style.flex = String(ms);
      stack.append(seg);
      const item = el('span', {}, el('i'), CATS[cat] || 'Other', ' ', el('b', { textContent: fmtDur(ms) }));
      item.style.setProperty('--c', catVar(cat));
      legend.append(item);
    }
    tbox.append(stack, legend, el('div', { className: 'tracked', textContent: `${fmtDur(all)} logged` }));
  }

  // timeline
  const ol = $('timeline');
  ol.replaceChildren();
  let prevEnd = null;
  for (const x of list) {
    const s = new Date(x.start), e = x.end ? new Date(x.end) : null;
    const running = s.getTime() <= now && (!e || e.getTime() > now);
    if (prevEnd && s.getTime() - prevEnd > 15 * MIN && s.getTime() > ds) {
      ol.append(el('li', { className: 't-item' }, el('span'), el('div', { className: 't-gap', textContent: `not logged · ${fmtDur(s.getTime() - prevEnd)}` })));
    }
    const card = el('button', { className: 't-card', type: 'button', title: 'Edit' });
    card.style.setProperty('--c', catVar(x.category));
    card.append(
      el('div', { className: 't-head' }, el('span', { className: 't-title', textContent: x.title }),
        el('span', { className: 't-dur', textContent: e ? fmtDur(e - s) : fmtDur(now - s) })),
      el('div', { className: 't-sub' },
        el('span', { className: 'cat', textContent: CATS[x.category] || 'Other' }),
        running ? el('span', { className: 't-live', textContent: '● now' }) : null,
        x.note ? el('span', { textContent: x.note }) : null),
    );
    card.style.setProperty('--c', catVar(x.category));
    card.querySelector('.cat').style.setProperty('--c', catVar(x.category));
    card.onclick = () => openEdit(x);
    const time = el('div', { className: 't-time' }, el('b', { textContent: fmtTime(s) }), e ? `to ${fmtTime(e)}` : running ? 'now' : '');
    ol.append(el('li', { className: 't-item' }, time, card));
    prevEnd = Math.max(prevEnd || 0, e ? e.getTime() : now);
  }
  $('day-empty').hidden = list.length > 0;
  $('summary-box').hidden = $('summary-box').dataset.day !== selectedDay;
}

// numbers for the AI summary, computed here so the model never has to do arithmetic
function dayFacts(key) {
  const [ds, de] = dayBounds(key);
  const now = Date.now();
  const list = entriesOn(key);
  const spans = list.map((x) => ({ x, s: Math.max(ds, new Date(x.start).getTime()), e: Math.min(de, now, x.end ? new Date(x.end).getTime() : now) })).filter((p) => p.e > p.s);
  const by = new Map();
  for (const p of spans) by.set(p.x.category, (by.get(p.x.category) || 0) + (p.e - p.s));
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  let gap = 0, gapAt = '';
  for (let i = 1; i < spans.length; i++) {
    const g = spans[i].s - Math.max(...spans.slice(0, i).map((p) => p.e));
    if (g > gap) { gap = g; gapAt = `${fmtTime(new Date(spans[i].s - g))}–${fmtTime(new Date(spans[i].s))}`; }
  }
  const longest = spans.reduce((m, p) => (p.e - p.s > (m ? m.e - m.s : 0) ? p : m), null);
  return [
    `Time by type (within this day): ${[...by].sort((a, b) => b[1] - a[1]).map(([c, ms]) => `${CATS[c] || c} ${fmtDur(ms)}`).join(', ')}`,
    `Total logged: ${fmtDur(total)}`,
    `Focused (work + study): ${fmtDur((by.get('work') || 0) + (by.get('study') || 0))}`,
    `Meals and breaks together: ${fmtDur((by.get('meal') || 0) + (by.get('break') || 0))}`,
    `Exercise: ${fmtDur(by.get('exercise') || 0)}`,
    `Sleep (within this day): ${fmtDur(by.get('sleep') || 0)}`,
    longest ? `Longest single activity: ${longest.x.title}, ${fmtDur(longest.e - longest.s)}` : '',
    gap >= 30 * MIN ? `Longest stretch with nothing logged: ${fmtDur(gap)} (${gapAt})` : 'No long unlogged gaps',
  ].filter(Boolean).join('\n');
}

function render() { renderNow(); renderDay(); renderWeek(); }

$('prev-day').onclick = () => { selectedDay = dayKey(addDays(fromDayKey(selectedDay), -1)); renderDay(); };
$('next-day').onclick = () => { selectedDay = dayKey(addDays(fromDayKey(selectedDay), 1)); renderDay(); };
$('date-pick').onchange = () => { if ($('date-pick').value) { selectedDay = $('date-pick').value; renderDay(); } };

// ---------- add / edit ----------
let editing = null;
for (const [v, label] of Object.entries(CATS)) $('e-cat').append(el('option', { value: v, textContent: label }));

function openEdit(entry) {
  editing = entry || null;
  $('edit-title').textContent = entry ? 'Edit activity' : 'Add activity';
  $('e-delete').hidden = !entry;
  $('edit-error').hidden = true;
  const s = entry ? new Date(entry.start) : atTime(fromDayKey(selectedDay), hhmm(new Date()));
  $('e-title').value = entry?.title || '';
  $('e-cat').value = entry?.category || 'work';
  $('e-date').value = dayKey(s);
  $('e-start').value = hhmm(s);
  $('e-end').value = entry?.end ? hhmm(new Date(entry.end)) : '';
  $('e-note').value = entry?.note || '';
  $('edit').showModal();
}
$('add-btn').onclick = () => openEdit(null);
$('e-cancel').onclick = () => $('edit').close();
$('edit-form').onsubmit = (ev) => {
  ev.preventDefault();
  const title = $('e-title').value.trim();
  if (!title || !$('e-date').value || !$('e-start').value) return;
  const start = atTime(fromDayKey($('e-date').value), $('e-start').value);
  let end = $('e-end').value ? atTime(start, $('e-end').value) : null;
  if (end && end <= start) end = addDays(end, 1);
  if (!end && start > new Date()) { $('edit-error').textContent = 'A future activity needs an end time.'; $('edit-error').hidden = false; return; }
  const change = beginChange();
  let e = editing;
  if (e) remember(change, e);
  else { e = { id: newId(), deleted: false }; entries.push(e); change.created.push(e.id); }
  Object.assign(e, { title, category: $('e-cat').value, start: start.toISOString(), end: end ? end.toISOString() : null, note: $('e-note').value.trim(), planned: !!end && end > new Date() });
  touch(e);
  $('edit').close();
  selectedDay = dayKey(start);
  commitChange(change, editing ? 'Saved.' : `Added ${title}.`);
};
$('e-delete').onclick = () => {
  if (!editing) return;
  const change = beginChange();
  remember(change, editing);
  editing.deleted = true;
  touch(editing);
  $('edit').close();
  commitChange(change, `Deleted ${editing.title}.`);
};

// ---------- spoken day summary ----------
$('summary-btn').onclick = async () => {
  const list = entriesOn(selectedDay);
  if (!list.length) { toast('Nothing logged on this day yet.'); return; }
  const lines = list.map((x) => `${fmtTime(new Date(x.start))}–${x.end ? fmtTime(new Date(x.end)) : 'now'} ${x.title} (${x.category})${x.note ? ' – ' + x.note : ''}`);
  const totals = dayFacts(selectedDay);
  busy($('summary-btn'), true);
  try {
    const data = await api('/api/summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: fromDayKey(selectedDay).toDateString(), lines, totals, language_code: $('lang').value }),
    });
    $('summary-text').textContent = data.summary;
    const audio = $('summary-audio');
    audio.hidden = !data.audio;
    if (data.audio) { audio.src = data.audio; if ($('voice').checked) audio.play().catch(() => {}); }
    else play(null, data.summary);
    $('summary-box').dataset.day = selectedDay;
    $('summary-box').hidden = false;
  } catch (e) {
    toast(e.offline ? 'You are offline. Summaries need the internet.' : e.message);
  } finally {
    busy($('summary-btn'), false);
  }
};

// ---------- sync with the server database ----------
// Signed-in users only: the session cookie identifies the account, so no passcode is needed.
let cloud = false, signedIn = false, syncTimer = null, syncing = false, syncAgain = false;
function syncState(state, text) { $('sync').dataset.state = state; $('sync-text').textContent = text; }

function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 600); }

async function syncNow() {
  if (!signedIn) return;
  if (!cloud) { syncState('local', 'This device only'); return; }
  if (!navigator.onLine) { syncState('offline', 'Offline · saved here'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  syncState('saving', 'Syncing…');
  const headers = { 'Content-Type': 'application/json' };
  try {
    // push local changes
    const ids = [...dirty];
    if (ids.length) {
      const batch = entries.filter((e) => dirty.has(e.id)).map(({ id, title, category, start, end, note, deleted, updatedAt }) => ({ id, title, category, start, end, note, deleted, updatedAt }));
      await api('/api/entries', { method: 'POST', headers, body: JSON.stringify({ entries: batch }) });
      ids.forEach((id) => dirty.delete(id));
    }
    // pull what changed on other devices
    const cursor = store.get(KEYS.cursor, null);
    const data = await api('/api/entries' + (cursor ? `?since=${encodeURIComponent(cursor)}` : ''), { headers });
    let changed = false;
    for (const remote of data.entries) {
      const i = entries.findIndex((e) => e.id === remote.id);
      if (i < 0) { entries.push({ ...remote, planned: !!remote.end && new Date(remote.end) > new Date() }); changed = true; continue; }
      const local = entries[i];
      if (new Date(remote.updatedAt) > new Date(local.updatedAt) && !dirty.has(local.id)) {
        entries[i] = { ...local, ...remote };
        changed = true;
      }
    }
    if (data.cursor) store.set(KEYS.cursor, data.cursor);
    store.set(KEYS.entries, entries);
    store.set(KEYS.dirty, [...dirty]);
    if (changed) render();
    syncState('synced', 'Synced');
  } catch (e) {
    if (e.offline) syncState('offline', 'Offline · saved here');
    else if (e.status !== 401) syncState('error', 'Sync failed');
  } finally {
    syncing = false;
    store.set(KEYS.dirty, [...dirty]);
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
window.addEventListener('online', scheduleSync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && signedIn) { render(); syncNow(); } });
setInterval(syncNow, 60 * 1000);

// ---------- sign in with Google ----------
let config = {};
function wipeLocal() {
  for (const k of [KEYS.entries, KEYS.dirty, KEYS.cursor, KEYS.owner, KEYS.resume, KEYS.nudged]) { try { localStorage.removeItem(k); } catch { /* blocked */ } }
}

function showSignin(message) {
  signedIn = false;
  $('app').hidden = true;
  $('top-tools').hidden = true;
  $('signin').hidden = false;
  $('signin-error').hidden = !message;
  $('signin-error').textContent = message || '';
  $('dev-login').hidden = !config.devLogin;
  $('gbtn').hidden = !config.googleClientId;
  if (!config.googleClientId) {
    if (!config.devLogin) { $('signin-error').textContent = 'Sign-in is not set up on this server yet.'; $('signin-error').hidden = false; }
    return;
  }
  // the Google script loads asynchronously
  const ready = () => {
    if (!window.google?.accounts?.id) { setTimeout(ready, 150); return; }
    google.accounts.id.initialize({ client_id: config.googleClientId, callback: onGoogleCredential, auto_select: true, cancel_on_tap_outside: true });
    google.accounts.id.renderButton($('gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
    google.accounts.id.prompt(); // One Tap, when the browser allows it
  };
  ready();
}

async function onGoogleCredential(resp) {
  try {
    const { user } = await api('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) });
    startApp(user);
  } catch (e) { showSignin(e.message); }
}
$('dev-login').onclick = async () => {
  try {
    const { user } = await api('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tester@localhost' }) });
    startApp(user);
  } catch (e) { showSignin(e.message); }
};

function startApp(user) {
  // this browser's copy belongs to one account; switching accounts starts fresh
  const owner = store.get(KEYS.owner, null);
  if (owner && owner !== user.id) {
    wipeLocal();
    entries = []; dirty = new Set();
  } else if (!owner) {
    entries.forEach((e) => dirty.add(e.id)); // anything logged here before signing in moves into the account
  }
  store.set(KEYS.owner, user.id);
  store.set(KEYS.dirty, [...dirty]);
  signedIn = true;
  $('signin').hidden = true;
  $('app').hidden = false;
  $('top-tools').hidden = false;
  const letter = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  for (const [img, src] of [[$('avatar'), user.picture], [$('acc-pic'), user.picture]]) { img.hidden = !src; if (src) img.src = src; }
  $('avatar-letter').textContent = user.picture ? '' : letter;
  $('acc-name').textContent = user.name || '';
  $('acc-email').textContent = user.email || '';
  $('sync-help').textContent = cloud
    ? 'Your log is saved to your account and is the same on every device you sign in on.'
    : 'Cloud sync is not set up on this server yet, so your log is saved only in this browser. Download a copy now and then.';
  render();
  syncNow();
  checkNudges();
}

async function boot() {
  try { config = await api('/api/config'); } catch { config = {}; }
  cloud = !!config.cloud;
  try {
    const { user } = await api('/api/auth/me');
    startApp(user);
  } catch (e) {
    // offline but signed in before: open the local copy; it syncs when the connection is back
    if (e.offline && store.get(KEYS.owner, null)) { startApp({ id: store.get(KEYS.owner, null), name: '' }); syncState('offline', 'Offline · saved here'); return; }
    showSignin();
  }
}

$('logout-btn').onclick = async () => {
  busy($('logout-btn'), true);
  await syncNow(); // don't leave unsynced changes behind
  if (dirty.size && !confirm('Some changes have not synced yet and will be lost on this device. Sign out anyway?')) { busy($('logout-btn'), false); return; }
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  try { google.accounts.id.disableAutoSelect(); } catch { /* script not loaded */ }
  wipeLocal(); // the log stays in the account; this device forgets it
  location.reload();
};
$('delete-btn').onclick = async () => {
  if (!confirm('Delete your account and your whole log? This cannot be undone.')) return;
  busy($('delete-btn'), true);
  try {
    await api('/api/account', { method: 'DELETE' });
    try { google.accounts.id.disableAutoSelect(); } catch { /* script not loaded */ }
    wipeLocal();
    location.reload();
  } catch (e) { toast(e.message); busy($('delete-btn'), false); }
};

// ---------- settings ----------
$('lang').value = store.get(KEYS.lang, 'en-IN');
$('voice').checked = store.get(KEYS.voice, true);
$('alerts').checked = store.get(KEYS.alerts, false);
$('nudges').checked = store.get(KEYS.nudges, true);
$('settings-btn').onclick = () => $('settings').showModal();
$('account-btn').onclick = () => $('settings').showModal();
$('sync').onclick = () => $('settings').showModal();
$('settings-save').onclick = () => {
  store.set(KEYS.lang, $('lang').value);
  store.set(KEYS.voice, $('voice').checked);
  store.set(KEYS.alerts, $('alerts').checked);
  store.set(KEYS.nudges, $('nudges').checked);
  checkNudges();
  if ($('alerts').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  $('settings').close();
};
$('export-btn').onclick = () => {
  const blob = new Blob([JSON.stringify(live(), null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `dincharya-log-${dayKey(new Date())}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};


// ---------- per-day numbers (shared by week view, questions and nudges) ----------
function dayStats(key) {
  const [ds, de] = dayBounds(key);
  const now = Date.now();
  const by = new Map(), count = new Map();
  for (const x of entriesOn(key)) {
    const s = Math.max(ds, new Date(x.start).getTime());
    const e = Math.min(de, now, x.end ? new Date(x.end).getTime() : now);
    if (e <= s) continue;
    by.set(x.category, (by.get(x.category) || 0) + (e - s));
    if (new Date(x.start).getTime() >= ds) count.set(x.category, (count.get(x.category) || 0) + 1); // count where it started
  }
  return { by, count, total: [...by.values()].reduce((a, b) => a + b, 0) };
}
const statLine = (st) => [...st.by].sort((a, b) => b[1] - a[1]).map(([c, ms]) => `${CATS[c] || c} ${fmtDur(ms)}${st.count.get(c) ? ` (${st.count.get(c)}×)` : ''}`).join(', ') || 'nothing logged';

// ---------- ask your log ----------
function logForQuestions() {
  const today = new Date();
  const lines = [];
  const week = { by: new Map(), count: new Map() }, last7 = { by: new Map(), count: new Map() };
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i), key = dayKey(d);
    const st = dayStats(key);
    const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : '';
    const acts = entriesOn(key).filter((x) => dayKey(new Date(x.start)) === key)
      .map((x) => `${hhmm(new Date(x.start))}-${x.end ? hhmm(new Date(x.end)) : 'now'} ${x.title} (${x.category})`);
    if (acts.length || st.total) lines.push(`${d.toDateString()}${label ? ` [${label}]` : ''}: ${acts.join('; ') || '-'} | totals: ${statLine(st)}`);
    for (const [target, ok] of [[week, d >= monday], [last7, i < 7]]) {
      if (!ok) continue;
      for (const [c, ms] of st.by) target.by.set(c, (target.by.get(c) || 0) + ms);
      for (const [c, n] of st.count) target.count.set(c, (target.count.get(c) || 0) + n);
    }
  }
  // how many times each named activity happened, e.g. "Gym 4×"
  const named = (from) => {
    const m = new Map();
    for (const x of live()) {
      const s = new Date(x.start);
      if (s < from || s > today) continue;
      const k = x.title.trim().toLowerCase();
      const v = m.get(k) || { title: x.title.trim(), n: 0, ms: 0 };
      v.n++; v.ms += Math.max(0, (x.end ? new Date(x.end) : today) - s);
      m.set(k, v);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).map((v) => `${v.title} ${v.n}× (${fmtDur(v.ms)})`).join(', ') || 'none';
  };
  const mondayStart = fromDayKey(dayKey(monday)), weekAgo = fromDayKey(dayKey(addDays(today, -6)));
  return `Log for the last 14 days:\n${lines.join('\n') || '(empty)'}\n\nThis week so far (since Monday), by type: ${statLine(week)}\nThis week so far, by activity: ${named(mondayStart)}\nLast 7 days, by type: ${statLine(last7)}\nLast 7 days, by activity: ${named(weekAgo)}`;
}

async function askLog(question) {
  setReply('Looking through your days…');
  const data = await api('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, log: logForQuestions(), today: new Date().toDateString(), language_code: $('lang').value }),
  });
  setReply(data.answer);
  play(data.audio, data.answer);
  $('say-text').value = '';
}

// ---------- week view ----------
let view = 'day';
let weekStart = (() => { const t = fromDayKey(dayKey(new Date())); return addDays(t, -((t.getDay() + 6) % 7)); })(); // Monday
const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1s1 3.5-1.5 6.5C9.6 10.4 8 12 8 15a4 4 0 0 0 8 0c0-1.5-.6-2.8-1.3-3.9 2.6 1.1 4.3 3.4 4.3 6.4A7 7 0 0 1 5 17.5C5 9 13.5 7 13.5 1Z"/></svg>';

function setView(v) {
  view = v;
  $('tab-day').setAttribute('aria-selected', String(v === 'day'));
  $('tab-week').setAttribute('aria-selected', String(v === 'week'));
  $('day-view').hidden = v !== 'day';
  $('week-view').hidden = v !== 'week';
  if (v === 'week') { const d = fromDayKey(selectedDay); weekStart = addDays(d, -((d.getDay() + 6) % 7)); renderWeek(); }
}
$('tab-day').onclick = () => setView('day');
$('tab-week').onclick = () => setView('week');
$('prev-week').onclick = () => { weekStart = addDays(weekStart, -7); renderWeek(); };
$('next-week').onclick = () => { weekStart = addDays(weekStart, 7); renderWeek(); };

// consecutive days (ending today, or yesterday if today has none yet) with at least 15 min of a type
function streaks() {
  const out = [];
  for (const cat of Object.keys(CATS)) {
    if (['sleep', 'meal', 'break', 'other', 'commute', 'chores', 'leisure'].includes(cat)) continue;
    let n = 0;
    const has = (i) => (dayStats(dayKey(addDays(new Date(), -i))).by.get(cat) || 0) >= 15 * MIN;
    let i = has(0) ? 0 : 1;
    while (i < 366 && has(i)) { n++; i++; }
    if (n >= 2) out.push([cat, n]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

function renderWeek() {
  if (view !== 'week') return;
  const todayKey = dayKey(new Date());
  const thisMonday = (() => { const t = fromDayKey(todayKey); return addDays(t, -((t.getDay() + 6) % 7)); })();
  const end = addDays(weekStart, 6);
  $('week-h').textContent = dayKey(weekStart) === dayKey(thisMonday) ? 'This week' : dayKey(weekStart) === dayKey(addDays(thisMonday, -7)) ? 'Last week' : 'Week';
  $('week-range').textContent = `${weekStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  $('next-week').disabled = weekStart >= thisMonday;

  // streaks only make sense for the current week
  const sbox = $('streaks');
  sbox.replaceChildren();
  if (dayKey(weekStart) === dayKey(thisMonday)) {
    for (const [cat, n] of streaks()) {
      const chip = el('span', { className: 'streak' });
      chip.innerHTML = FLAME;
      chip.append(`${CATS[cat]} streak: ${n} days`);
      sbox.append(chip);
    }
  }

  const days = [...Array(7)].map((_, i) => { const d = addDays(weekStart, i); return { d, key: dayKey(d), st: dayStats(dayKey(d)) }; });
  const week = new Map(), counts = new Map();
  for (const { st } of days) {
    for (const [c, ms] of st.by) week.set(c, (week.get(c) || 0) + ms);
    for (const [c, n] of st.count) counts.set(c, (counts.get(c) || 0) + n);
  }
  const sorted = [...week].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  const all = sorted.reduce((a, [, ms]) => a + ms, 0);
  const tbox = $('week-totals');
  tbox.replaceChildren();
  if (all) {
    const stack = el('div', { className: 'stack' });
    const legend = el('div', { className: 'legend' });
    for (const [cat, ms] of sorted) {
      const seg = el('span'); seg.style.setProperty('--c', catVar(cat)); seg.style.flex = String(ms); stack.append(seg);
      const item = el('span', {}, el('i'), CATS[cat], ' ', el('b', { textContent: fmtDur(ms) }));
      item.style.setProperty('--c', catVar(cat)); legend.append(item);
    }
    tbox.append(stack, legend);
  }

  const max = Math.max(...days.map((x) => x.st.total), 1);
  const ol = $('week-days');
  ol.replaceChildren();
  for (const { d, key, st } of days) {
    const btn = el('button', { className: 'wd' + (key === todayKey ? ' today' : ''), type: 'button', title: 'Open this day' });
    const bar = el('div', { className: 'wd-bar' });
    bar.style.width = `${Math.max(2, (st.total / max) * 100)}%`;
    for (const [cat, ms] of [...st.by].sort((a, b) => b[1] - a[1])) { const seg = el('span'); seg.style.setProperty('--c', catVar(cat)); seg.style.flex = String(ms); bar.append(seg); }
    btn.append(
      el('span', { className: 'wd-name' }, d.toLocaleDateString('en-IN', { weekday: 'short' }), el('small', { textContent: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) })),
      el('div', {}, bar),
      el('span', { className: 'wd-total', textContent: st.total ? fmtDur(st.total) : key > todayKey ? '' : '–' }),
    );
    btn.disabled = key > todayKey;
    btn.onclick = () => { selectedDay = key; setView('day'); renderDay(); };
    ol.append(el('li', {}, btn));
  }

  const facts = $('week-facts');
  facts.replaceChildren();
  const fact = (...parts) => facts.append(el('li', {}, ...parts));
  if (!all) { fact('Nothing logged this week yet.'); return; }
  const focused = (week.get('work') || 0) + (week.get('study') || 0);
  const logged = days.filter((x) => x.st.total > 0).length;
  if (focused) fact('Focused (work + study): ', el('b', { textContent: fmtDur(focused) }), ` · about ${fmtDur(focused / logged)} a day on days you logged`);
  if (counts.get('break')) fact('Breaks: ', el('b', { textContent: `${counts.get('break')}` }), ` · average ${fmtDur((week.get('break') || 0) / counts.get('break'))}`);
  if (counts.get('exercise')) fact('Exercise: ', el('b', { textContent: `${counts.get('exercise')} ${counts.get('exercise') === 1 ? 'time' : 'times'}` }), `, ${fmtDur(week.get('exercise'))} in total`);
  const best = days.reduce((m, x) => { const f = (x.st.by.get('work') || 0) + (x.st.by.get('study') || 0); return f > m.f ? { f, d: x.d } : m; }, { f: 0, d: null });
  if (best.f) fact('Most focused day: ', el('b', { textContent: best.d.toLocaleDateString('en-IN', { weekday: 'long' }) }), ` (${fmtDur(best.f)})`);
  if (week.get('sleep')) fact('Sleep logged: ', el('b', { textContent: fmtDur(week.get('sleep')) }));
}

// ---------- gentle nudges ----------
// Checked once a minute while the app is open. Each nudge fires once (remembered per day).
function nudgeKey(id) { return `${dayKey(new Date())}:${id}`; }
function findNudge(now = new Date()) {
  const t = now.getTime(), h = now.getHours() + now.getMinutes() / 60;
  const cur = current(t);
  const today = dayKey(now);
  const st = dayStats(today);
  const loggedToday = st.total > 0;
  if (cur) {
    const ran = t - new Date(cur.start).getTime();
    if (cur.category === 'break' && !cur.end && ran > 45 * MIN) return { id: `long-break-${cur.id}`, text: `You've been on a break for ${fmtDur(ran)}. Ready to get back?`, actions: ['done'] };
    if (cur.category === 'meal' && !cur.end && ran > 75 * MIN) return { id: `long-meal-${cur.id}`, text: `${cur.title} has been running for ${fmtDur(ran)}. Finished?`, actions: ['done'] };
    if (['work', 'study'].includes(cur.category) && ran > 2 * 60 * MIN) {
      const hrs = Math.floor(ran / (60 * MIN));
      return { id: `long-focus-${cur.id}-${hrs}`, text: `${fmtDur(ran)} of ${cur.title} without a break. A 10-minute break?`, actions: ['break10'] };
    }
  }
  const meals = entriesOn(today).filter((x) => x.category === 'meal');
  const mealBetween = (a, b) => meals.some((x) => { const mh = new Date(x.start).getHours(); return mh >= a && mh < b; });
  if (loggedToday && h >= 14.5 && h < 17 && !mealBetween(11, 17)) return { id: 'no-lunch', text: 'No lunch logged yet today. Eaten something?', actions: ['lunch'] };
  if (loggedToday && h >= 21.5 && !mealBetween(18, 24)) return { id: 'no-dinner', text: 'No dinner logged yet tonight.', actions: ['dinner'] };
  if (!cur && loggedToday && h >= 9 && h < 23) {
    const lastEnd = Math.max(...live().map((x) => (x.end ? new Date(x.end).getTime() : t)).filter((v) => v <= t));
    if (Number.isFinite(lastEnd) && t - lastEnd > 2 * 60 * MIN) return { id: `gap-${Math.floor(lastEnd / MIN)}`, text: `Nothing logged since ${fmtTime(new Date(lastEnd))}. What have you been up to?`, actions: ['log'] };
  }
  return null;
}
const NUDGE_ACTIONS = {
  done: ['Done', () => applyUnderstanding({ action: 'stop', activities: [] })],
  break10: ['Break 10m', () => startQuick('Break', 'break', 10)],
  lunch: ['Log lunch', () => $('say-text').focus()],
  dinner: ['Log dinner', () => $('say-text').focus()],
  log: ['Log it', () => $('say-text').focus()],
};
function checkNudges() {
  if (!$('nudges').checked) { $('nudge').hidden = true; return; }
  const n = findNudge();
  const done = new Set(store.get(KEYS.nudged, []));
  if (!n || done.has(nudgeKey(n.id))) { if (!n) $('nudge').hidden = true; return; }
  $('nudge-text').textContent = n.text;
  const box = $('nudge-actions');
  box.replaceChildren();
  const close = () => { done.add(nudgeKey(n.id)); store.set(KEYS.nudged, [...done].slice(-60)); $('nudge').hidden = true; };
  for (const a of n.actions) { const [label, fn] = NUDGE_ACTIONS[a]; box.append(button(label, () => { close(); fn(); }, 'primary')); }
  box.append(button('Dismiss', close));
  if ($('nudge').hidden) { // first time this nudge shows
    $('nudge').hidden = false;
    if ($('alerts').checked) notify('Dincharya', n.text, n.id);
  }
}

// ---------- install on the home screen + notifications ----------
let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
}
function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'icon-192.png', badge: 'icon-192.png' };
  if (swReg?.showNotification) swReg.showNotification(title, opts).catch(() => {});
  else { try { new Notification(title, opts); } catch { /* not supported here */ } }
}
let installEvent = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installEvent = ev;
  if (!store.get(KEYS.installNo, false)) $('install').hidden = false;
});
$('install-btn').onclick = async () => {
  $('install').hidden = true;
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
};
$('install-close').onclick = () => { $('install').hidden = true; store.set(KEYS.installNo, true); };
window.addEventListener('appinstalled', () => { $('install').hidden = true; });

// ---------- toast ----------
let toastTimer = null;
function toast(msg, undo) {
  clearTimeout(toastTimer);
  $('toast-text').textContent = msg;
  $('toast-undo').hidden = !undo;
  $('toast-undo').onclick = () => { $('toast').hidden = true; undo(); };
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 6000 : 3000);
}

// ---------- start ----------
boot();
let lastMinute = new Date().getMinutes();
setInterval(() => {
  renderNow();
  checkAlerts();
  const m = new Date().getMinutes();
  if (m !== lastMinute) { lastMinute = m; renderDay(); renderWeek(); checkNudges(); } // once a minute
  if (selectedDay !== dayKey(new Date()) && selectedDay === dayKey(addDays(new Date(), -1)) && new Date().getHours() === 0 && new Date().getMinutes() === 0) {
    selectedDay = dayKey(new Date()); renderDay(); // roll over at midnight
  }
}, 1000);
