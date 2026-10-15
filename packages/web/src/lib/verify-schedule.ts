/**
 * Validator checks for Amendment 111's web half: times in your own zone, the store keeping
 * scheduled messages, and the controls wired where they should be.
 *
 * Pure functions are run; the components are read as source, as the other verify files do.
 * Run: pnpm --filter @conductor/web exec tsx src/lib/verify-schedule.ts
 */

import { readFileSync } from 'node:fs';
import type { ScheduledMessage, Snapshot } from '@conductor/shared';
import { PAUSE_UNTIL_KEY } from '@conductor/shared';
import { store } from './store.js';
import { fmtIn, fmtWhen, fromLocalInput, nextHour, toLocalInput, tomorrowMorning, whenProblem } from './when.js';
import { activePause } from '../shell/pauseall.js';
import { slotWaits, whenDoneRefusal, whenDoneWaits } from '../agent/scheduled.js';
import { SLOT_WAIT_TEXT, sentText } from '../agent/endpoints.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

console.log('\n1 · local times');
{
  const at = new Date(2026, 9, 9, 18, 5); // 9 Oct 2026, 18:05 local
  check('a date goes into datetime-local as local time', toLocalInput(at) === '2026-10-09T18:05', toLocalInput(at));
  check('and comes back as the same instant, in ISO', fromLocalInput('2026-10-09T18:05') === at.toISOString(), String(fromLocalInput('2026-10-09T18:05')));
  check('seconds are allowed', fromLocalInput('2026-10-09T18:05:30') === new Date(2026, 9, 9, 18, 5, 30).toISOString());
  check('what is not one is null', fromLocalInput('') === null && fromLocalInput('tomorrow') === null && fromLocalInput('2026-10-09') === null);
  check('the picker starts on the next whole hour', toLocalInput(nextHour(new Date(2026, 9, 9, 17, 10))) === '2026-10-09T18:00');
  check('at least half an hour away', toLocalInput(nextHour(new Date(2026, 9, 9, 17, 40))) === '2026-10-09T19:00');
  check('across midnight', toLocalInput(nextHour(new Date(2026, 9, 9, 23, 45))) === '2026-10-10T01:00');
  check('tomorrow morning is 09:00 the next day', toLocalInput(tomorrowMorning(new Date(2026, 9, 31, 22, 0))) === '2026-11-01T09:00');

  const now = new Date(2026, 9, 9, 12, 0);
  const iso = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
  check('today reads as the time alone', /^18:00\b/.test(fmtWhen(iso(2026, 9, 9, 18), now)), fmtWhen(iso(2026, 9, 9, 18), now));
  check('tomorrow says so', /^tomorrow 09:00\b/.test(fmtWhen(iso(2026, 9, 10, 9), now)), fmtWhen(iso(2026, 9, 10, 9), now));
  const later = fmtWhen(iso(2026, 9, 14, 9, 30), now);
  check('another day has its weekday and date', /14/.test(later) && /09:30/.test(later) && !/2026/.test(later), later);
  check('another year has the year', /2027/.test(fmtWhen(iso(2027, 0, 5, 9), now)));
  check('the zone is named, so it is never read as UTC', /\d\d:\d\d \S+/.test(fmtWhen(iso(2026, 9, 9, 18), now)), fmtWhen(iso(2026, 9, 9, 18), now));
  check('something that is not a time comes back as it was', fmtWhen('soon', now) === 'soon');

  check('a time that has passed is refused', whenProblem('2026-10-09T11:00', now) === 'that time has passed');
  check('more than a year ahead is refused', whenProblem('2027-12-01T09:00', now) === 'more than a year ahead');
  check('nothing chosen says to choose', whenProblem('', now) === 'choose a date and time');
  check('an hour ahead is fine', whenProblem('2026-10-09T13:00', now) === null);

  check('how long: minutes', fmtIn(iso(2026, 9, 9, 12, 20), now) === 'in 20 min');
  check('hours and minutes', fmtIn(iso(2026, 9, 9, 15, 30), now) === 'in 3 h 30 min');
  check('whole hours', fmtIn(iso(2026, 9, 9, 14), now) === 'in 2 h');
  check('days', fmtIn(iso(2026, 9, 14, 12), now) === 'in 5 days');
  check('past is now', fmtIn(iso(2026, 9, 9, 11), now) === 'now');
}

console.log('\n2 · the pause setting');
{
  const now = Date.parse('2026-10-09T12:00:00Z');
  check('a time ahead is on', activePause('2026-10-09T18:00:00Z', now) === '2026-10-09T18:00:00Z');
  check('a time past is off, before the daemon has removed it', activePause('2026-10-09T11:00:00Z', now) === null);
  check('absent or not a time is off', activePause(null, now) === null && activePause('soon', now) === null);
  check('the setting is the shared key', PAUSE_UNTIL_KEY === 'conductor.pauseUntil');
}

console.log('\n3 · the store keeps the scheduled messages');
{
  const msg = (id: string, agentId: string): ScheduledMessage => ({
    id, agentId, at: '2026-10-10T09:00:00.000Z', trigger: 'at', text: `hello ${id}`, createdAt: '2026-10-09T12:00:00.000Z', error: null,
  });
  const snap: Snapshot = {
    projects: [], jobs: [], agents: [], pending: [], servers: [], alerts: [], seq: 0,
    slots: { used: 0, total: 7 }, costToday: 0, scheduled: [msg('s1', 'a1')],
  };
  store.apply({ type: 'hello', seq: 0, snapshot: snap });
  check('from the snapshot', store.select('sch1', (s) => s.scheduled.map((m) => m.id).join()) === 's1');
  store.apply({ type: 'scheduled', scheduled: [msg('s1', 'a1'), msg('s2', 'a2')] });
  check('a scheduled frame replaces the list', store.select('sch2', (s) => s.scheduled.map((m) => m.id).join()) === 's1,s2');
  store.apply({ type: 'scheduled', scheduled: [] });
  check('and empties it when the last is sent', store.select('sch3', (s) => s.scheduled.length) === 0);
  const { scheduled: _, ...old } = snap;
  store.apply({ type: 'hello', seq: 0, snapshot: old });
  check('a daemon from before sends none, and that is an empty list', store.select('sch4', (s) => s.scheduled.length) === 0);
}

console.log('\n4 · wired where it should be');
{
  const shell = src('../shell/shell.tsx');
  check('the status bar has the pause control, on every screen', /<span className="sh-right">\s*<PauseAll \/>/.test(shell));
  const pause = src('../shell/pauseall.tsx');
  check('pausing writes the setting as an ISO instant, resume now removes it', /writeSetting\(PAUSE_UNTIL_KEY, iso\)/.test(pause) && /writeSetting\(PAUSE_UNTIL_KEY, null\)/.test(pause));
  check('it picks a local date and time', /type="datetime-local"/.test(pause) && /fromLocalInput\(value\)/.test(pause));
  const comp = src('../agent/composer.tsx');
  check('the composer has "later" beside send', /⏲ later/.test(comp) && /<LaterRow/.test(comp));
  check('scheduling sends what is typed, at the time picked', /scheduleMessage\(agent\.id, at, body\)/.test(comp));
  check('and keeps the text unless it was scheduled', /if \(ok\) \{\s*setText\(''\);\s*setLater\(false\);/.test(comp));
  check("this agent's waiting messages show above the box", /<ScheduledList agentId=\{agent\.id\} \/>/.test(comp));
  const list = src('../agent/scheduled.tsx');
  check('each can be cancelled, and a failure shows its reason', /cancelScheduled\(m\.id\)/.test(list) && /couldn't send: \$\{m\.error\}/.test(list));
  const shellCss = src('../shell/shell.css');
  const agentCss = src('../agent/agent.css');
  const css = shellCss + agentCss;
  // Only this amendment's own sections: each runs to the end of its file.
  const ours =
    shellCss.slice(shellCss.indexOf('/* Pause everything until a time (Amendment 111)')) +
    agentCss.slice(agentCss.indexOf('/* Send later, and what waits (Amendment 111)'));
  check('their CSS is tokens only', !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(ours.replace(/\/\*[\s\S]*?\*\//g, '')) && /var\(--fail\)/.test(css));
  check('--need is not used for it: a pause is not you being needed', !/--need/.test(ours.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n5 · a message queued until the agent is done (Amendment 157)');
{
  check('offered while a turn can still end: working, queued, blocked, failed, paused', (['working', 'queued', 'blocked', 'failed', 'paused'] as const).every((s) => whenDoneRefusal(s) === null));
  check('not for one already done, or stopped: send it now', /send the message now/.test(whenDoneRefusal('done') ?? '') && /stopped/.test(whenDoneRefusal('stopped') ?? ''));
  check('the first waits for this turn', whenDoneWaits('working', true) === 'when this turn ends');
  check('it shows that it is waiting on a failure, a pause or a question', /failed/.test(whenDoneWaits('failed', true)) && /paused/.test(whenDoneWaits('paused', true)) && /asked you/.test(whenDoneWaits('blocked', true)));
  check('the ones behind it wait their turn, one per turn', whenDoneWaits('working', false) === 'after the one before it');
  const comp = src('../agent/composer.tsx');
  check('the composer has "when done" beside "later"', /⏲ later[\s\S]*⏲ when done/.test(comp));
  check('it queues what is typed', /queueWhenDone\(agent\.id, body\)/.test(comp));
  check('and is off when no turn of its would end', /disabled=\{[^}]*doneRefused !== null\}/.test(comp));
  const ends = src('../agent/endpoints.ts');
  check("it posts trigger 'done', no time", /\{ trigger: 'done', text \}/.test(ends));
  const list = src('../agent/scheduled.tsx');
  check('the list shows it as "when done", with what it waits on', /m\.trigger === 'done' \? '⏲ when done'/.test(list) && /whenDoneWaits\(status, m\.id === firstDone\)/.test(list));
}

console.log('\n6 · a message that waits for a slot (Amendment 168)');
{
  check('sent with every slot taken, the notice says it waits for one', sentText({ ok: true, delivery: 'queued' }) === SLOT_WAIT_TEXT && /slot/.test(SLOT_WAIT_TEXT));
  check('sent or resumed, it says nothing new', sentText({ ok: true, delivery: 'resumed' }) === '' && sentText({ ok: true, delivery: 'sent' }, 'sent') === 'sent');
  const comp = src('../agent/composer.tsx');
  check('the composer reads the answer', /sendMessage\(agent\.id, \{ text: body \}\), \(r\) => sentText\(r\)\)/.test(comp));
  check('so does the reply in Needs You', /sentText\(r, 'sent — it works again/.test(src('../attention/HandOff.tsx')));
  check('the first goes when one frees; the ones behind it after it', slotWaits('queued', true) === 'goes when one frees' && slotWaits('queued', false) === 'after the one before it');
  check('it shows a pause or a question it waits through', /paused/.test(slotWaits('paused', true)) && /asked you/.test(slotWaits('blocked', true)));
  const list = src('../agent/scheduled.tsx');
  check('the list shows it as "waiting for a slot", with what it waits on', /m\.trigger === 'slot' \? '⏲ waiting for a slot'/.test(list) && /slotWaits\(status, m\.id === firstSlot\)/.test(list));
}

console.log(
  failures === 0
    ? '\nAmendment 111 web verify: PASS — local times in and out, the pause setting, the store keeping scheduled messages, and the controls in the status bar and the composer; and (Amendment 157) "⏲ when done"; and (Amendment 168) "⏲ waiting for a slot".'
    : `\nAmendment 111 web verify: FAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
