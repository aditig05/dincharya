// Time logic: what "break for 30 min", "2 se 5 tak", "kal raat 11 se 7" turn into.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/core.js';

const { planActivities, resolveEnd, fmtDur, fmtClock, atTime, dayKey } = globalThis.DincharyaCore;
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const NOW = at(2026, 10, 18, 13, 10); // Sunday 1:10 pm
const hm = (d) => (d ? `${dayKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null);
const act = (start, end, title = 'X', category = 'other') => ({ title, category, start, end, note: '' });

test('"taking a break for half an hour" starts now and ends in 30 minutes', () => {
  const [b] = planActivities({ action: 'start', activities: [act({ type: 'now' }, { type: 'duration', minutes: 30 }, 'Break', 'break')] }, NOW);
  assert.equal(hm(b.start), '2026-10-18 13:10');
  assert.equal(hm(b.end), '2026-10-18 13:40');
});

test('"lunch" with no duration stays open', () => {
  const [l] = planActivities({ action: 'start', activities: [act({ type: 'now' }, { type: 'open' })] }, NOW);
  assert.equal(l.end, null);
});

test('"20 min pehle shuru kiya, 2 ghante karungi" started in the past and runs on', () => {
  const [d] = planActivities({ action: 'log', activities: [act({ type: 'ago', minutes: 20 }, { type: 'duration', minutes: 120 })] }, NOW);
  assert.equal(hm(d.start), '2026-10-18 12:50');
  assert.equal(hm(d.end), '2026-10-18 14:50');
});

test('"kal raat 11 se 7 tak soyi" said as "today" moves to last night', () => {
  const [s] = planActivities({ action: 'log', activities: [act({ type: 'at', time: '23:00', day: 'today' }, { type: 'at', time: '07:00' })] }, NOW);
  assert.equal(hm(s.start), '2026-10-17 23:00');
  assert.equal(hm(s.end), '2026-10-18 07:00');
});

test('"yesterday" is honoured for a past log', () => {
  const [w] = planActivities({ action: 'log', activities: [act({ type: 'at', time: '09:00', day: 'yesterday' }, { type: 'at', time: '10:00' })] }, NOW);
  assert.equal(hm(w.start), '2026-10-17 09:00');
});

test('a chained activity with a bad start begins where the previous one ended', () => {
  const made = planActivities({
    action: 'log',
    activities: [
      act({ type: 'at', time: '07:00', day: 'today' }, { type: 'at', time: '08:00' }, 'Gym'),
      act({ type: 'at', time: '08:30', day: 'today' }, { type: 'at', time: '08:30' }, 'Breakfast'), // model mistake
    ],
  }, NOW);
  assert.equal(hm(made[1].start), '2026-10-18 08:00');
  assert.equal(hm(made[1].end), '2026-10-18 08:30');
});

test('a morning end time before the start is a mistake, not an overnight activity', () => {
  const start = at(2026, 10, 18, 9, 0);
  const end = resolveEnd({ type: 'at', time: '08:00' }, start, NOW);
  assert.ok(end < start, 'should not wrap to the next day');
  const [fixed] = planActivities({ action: 'log', activities: [act({ type: 'at', time: '09:00', day: 'today' }, { type: 'at', time: '08:00' })] }, NOW);
  assert.equal(hm(fixed.end), '2026-10-18 09:30', 'falls back to half an hour');
});

test('an open activity in a list of past ones ends where the next starts', () => {
  const made = planActivities({
    action: 'log',
    activities: [
      act({ type: 'at', time: '08:00', day: 'today' }, { type: 'open' }, 'Breakfast'),
      act({ type: 'at', time: '08:30', day: 'today' }, { type: 'at', time: '09:00' }, 'Walk'),
    ],
  }, NOW);
  assert.equal(hm(made[0].end), '2026-10-18 08:30');
});

test('durations and countdowns read naturally', () => {
  assert.equal(fmtDur(45 * 60000), '45 min');
  assert.equal(fmtDur(90 * 60000), '1h 30m');
  assert.equal(fmtDur(120 * 60000), '2h');
  assert.equal(fmtClock(65 * 1000), '1:05');
  assert.equal(fmtClock(3725 * 1000), '1:02:05');
  assert.equal(hm(atTime(NOW, '07:05')), '2026-10-18 07:05');
});
