// Dincharya core: pure date/time logic, shared by the app (browser) and the tests (Node).
// No DOM, no storage, no network: everything here takes inputs and returns values.
(function (root) {
  const MIN = 60 * 1000;
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const atTime = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(day); x.setHours(h, m, 0, 0); return x; };
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

  // The model describes times as small specs; these turn them into real dates.
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

  // Turns an understood sentence ({action, activities}) into activities with real start/end dates.
  function planActivities(data, now) {
    const made = [];
    for (const a of data.activities || []) {
      let start = resolveStart(a.start, now);
      let end = resolveEnd(a.end, start, now);
      // "gym 7 se 8, phir 8:30 tak nashta": a chained activity starts where the previous one ended
      const prev = made[made.length - 1];
      if (end && end <= start && prev?.end && prev.end < end) start = new Date(prev.end);
      if (end && end <= start) end = new Date(start.getTime() + 30 * MIN); // still nonsense: assume half an hour, editable
      // a finished activity can't start in the future: "11 se 7 tak soyi" said at 1 pm means last night
      if (data.action === 'log' && start > now) {
        start = addDays(start, -1);
        if (end) end = addDays(end, -1);
      }
      made.push({ title: a.title, category: a.category, start, end, note: a.note || '' });
    }
    // in a list of past activities, one left open ends where the next one starts
    if (data.action === 'log') {
      made.sort((x, y) => x.start - y.start);
      made.forEach((e, i) => { if (!e.end && made[i + 1]) e.end = made[i + 1].start; });
    }
    return made;
  }

  const api = { MIN, pad, dayKey, fromDayKey, addDays, atTime, hhmm, fmtDur, fmtClock, resolveStart, resolveEnd, planActivities };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DincharyaCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
