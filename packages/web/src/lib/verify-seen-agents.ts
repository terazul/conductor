/**
 * Validator checks for Amendment 105 (an agent's "finished" clears once you've opened it).
 *
 * lib/verify.ts section 34 covers the pure rules and source shapes. This file drives the
 * LIVE path the way the app does — settings arriving, the Notifier marking the open
 * agent, an agent finishing again — against the real `settings.ts` store, and checks the
 * navigator tree and the Agent screen's tab condition. No daemon: `writeSetting` only
 * updates the local map once settings have been received.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/lib/verify-seen-agents.ts
 */

import { readFileSync } from 'node:fs';
import type { Agent } from '@conductor/shared';
import { readSetting, receiveSettings, writeSetting } from './settings.js';
import {
  SEEN_AGENTS_KEY,
  SEEN_KEY,
  markAgentSeen,
  markJobsSeen,
  parseSeen,
  parseSeenAgents,
  serializeSeen,
  startSeenOnce,
  unseenDoneAgents,
} from './seen.js';
import { navTree } from '../shell/navtree.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const ag = (id: string, status: Agent['status'], endedAt: string | null, jobId = 'j1'): Agent =>
  ({
    id,
    jobId,
    projectId: 'p1',
    role: 'builder',
    model: 'm',
    sdkSessionId: null,
    status,
    blockMode: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    dependsOn: [],
    autonomy: 'normal',
    startedAt: T(0),
    endedAt,
  }) as unknown as Agent;
const seenAgents = () => parseSeenAgents(readSetting(SEEN_AGENTS_KEY));

console.log('\nA · first load: startSeenOnce waits for settings, then writes since once');
{
  startSeenOnce(); // settings not here yet: queued
  check('nothing is written before the daemon\'s settings arrive', readSetting(SEEN_AGENTS_KEY) === null);
  receiveSettings({});
  const a = seenAgents();
  const j = parseSeen(readSetting(SEEN_KEY));
  check('both keys are written on first arrival', a.since !== null && j.since !== null);
  check('both use the same instant', a.since === j.since, `${a.since} vs ${j.since}`);
  check('the agent map starts empty', Object.keys(a.agents).length === 0);
  const before = readSetting(SEEN_AGENTS_KEY);
  startSeenOnce(); // loaded: runs at once
  check('a second start does not rewrite an existing value', readSetting(SEEN_AGENTS_KEY) === before);
}

console.log('\nB · upgrade: seenJobs exists, seenAgents does not');
{
  // fresh module state is not available; emulate by removing the key (null removes it)
  writeSetting(SEEN_AGENTS_KEY, null);
  const jobsBefore = readSetting(SEEN_KEY);
  startSeenOnce();
  const a = seenAgents();
  check('seenAgents gets its own fresh since', a.since !== null);
  check('seenJobs is left exactly as it was', readSetting(SEEN_KEY) === jobsBefore);
}

console.log('\nC · an older tab rewriting seenJobs cannot touch the agent key');
{
  const keep = readSetting(SEEN_AGENTS_KEY);
  // What an old bundle does: rebuild {since, jobs} only and write it back.
  writeSetting(SEEN_KEY, serializeSeen({ since: T(1), jobs: { x: T(2) } }));
  markJobsSeen([], []);
  check('seenAgents is unchanged', readSetting(SEEN_AGENTS_KEY) === keep);
}

console.log('\nD · the lifecycle: finish → open → clear → finish again → show again');
{
  // Pin `since` to a known past instant so the test does not depend on the clock.
  writeSetting(SEEN_AGENTS_KEY, JSON.stringify({ since: T(10), agents: {} }));
  let agents = [ag('a1', 'working', null), ag('a2', 'done', T(5)), ag('a3', 'failed', T(21))];
  check('a working agent is not unseen', unseenDoneAgents(agents, seenAgents()).length === 0);

  agents = [ag('a1', 'done', T(20)), ag('a2', 'done', T(5)), ag('a3', 'failed', T(21))];
  check('a1 finishing makes it unseen', unseenDoneAgents(agents, seenAgents()).map((a) => a.id).join() === 'a1');

  markAgentSeen(undefined, agents);
  check('no open agent marks nothing', unseenDoneAgents(agents, seenAgents()).length === 1);
  markAgentSeen('a2', agents);
  check('opening a different agent (ended before since) writes nothing', !('a2' in seenAgents().agents));
  markAgentSeen('a3', agents);
  check('opening a failed agent writes nothing', !('a3' in seenAgents().agents));
  markAgentSeen('ghost', agents);
  check('an id that is not an agent writes nothing', !('ghost' in seenAgents().agents));
  check('and none of those changed anything else', unseenDoneAgents(agents, seenAgents()).map((a) => a.id).join() === 'a1');

  markAgentSeen('a1', agents);
  check('opening a1 marks it seen at its end time', seenAgents().agents['a1'] === T(20));
  check('so it is no longer unseen', unseenDoneAgents(agents, seenAgents()).length === 0);

  const raw = readSetting(SEEN_AGENTS_KEY);
  markAgentSeen('a1', agents);
  check('opening it again writes nothing', readSetting(SEEN_AGENTS_KEY) === raw);

  agents = [ag('a1', 'working', null), ag('a2', 'done', T(5)), ag('a3', 'failed', T(21))];
  check('re-run: working again is not unseen', unseenDoneAgents(agents, seenAgents()).length === 0);
  markAgentSeen('a1', agents);
  check('opening it while working does not mark it', seenAgents().agents['a1'] === T(20));

  agents = [ag('a1', 'done', T(40)), ag('a2', 'done', T(5)), ag('a3', 'failed', T(21))];
  check('finished again at a later time: unseen again', unseenDoneAgents(agents, seenAgents()).map((a) => a.id).join() === 'a1');
  markAgentSeen('a1', agents);
  check('and opening it clears it again', unseenDoneAgents(agents, seenAgents()).length === 0 && seenAgents().agents['a1'] === T(40));
}

console.log('\nE · two quick marks both land; gone agents drop out');
{
  writeSetting(SEEN_AGENTS_KEY, JSON.stringify({ since: T(10), agents: { gone: T(12) } }));
  const agents = [ag('b1', 'done', T(20)), ag('b2', 'done', T(21))];
  markAgentSeen('b1', agents);
  markAgentSeen('b2', agents);
  const s = seenAgents();
  check('both are seen', s.agents['b1'] === T(20) && s.agents['b2'] === T(21));
  check('an agent that no longer exists is dropped', !('gone' in s.agents));
}

console.log('\nF · a broken stored value');
{
  writeSetting(SEEN_AGENTS_KEY, '{not json');
  const agents = [ag('c1', 'done', T(20))];
  markAgentSeen('c1', agents);
  check('nothing is unseen and nothing is written over it', readSetting(SEEN_AGENTS_KEY) === '{not json');
  // Known limitation worth recording: startSeenOnce only writes when the key is null, so a
  // corrupted value is never repaired and no agent ever shows "finished" again.
  startSeenOnce();
  check('LIMITATION: startSeenOnce does not repair a broken value', readSetting(SEEN_AGENTS_KEY) === '{not json');
  writeSetting(SEEN_AGENTS_KEY, null);
}

console.log('\nG · navTree: only a done AND unseen agent row says finished');
{
  const proj = [{ id: 'p1', name: 'P', path: '/p', extraDirs: [] }];
  const agents = [
    ag('d1', 'done', T(20)),
    ag('d2', 'done', T(21)),
    ag('f1', 'failed', T(22)),
    ag('w1', 'working', null),
  ];
  const jobs = [{ id: 'j1', createdAt: T(0), prompt: 'x' }];
  const rows = (unseen: string[], finishedJobs: string[] = []) =>
    Object.fromEntries(navTree(proj, agents, [], [], jobs, new Set(finishedJobs), new Set(unseen))[0]!.agents.map((r) => [r.id, r.finished]));

  let r = rows(['d1', 'f1', 'w1', 'nope']);
  check('d1 (done, unseen) is finished', r['d1'] === true);
  check('d2 (done, seen) is not', r['d2'] === false);
  check('f1 and w1 are not even if their ids are in the set', r['f1'] === false && r['w1'] === false);

  r = Object.fromEntries(navTree(proj, agents, [], [], jobs)[0]!.agents.map((x) => [x.id, x.finished]));
  check('omitting the sets: nothing is finished (old callers)', Object.values(r).every((v) => v === false));

  const t = navTree(proj, agents, [], [], jobs, new Set(['j1']), new Set())[0]!;
  check('the job group keeps its own finished flag, independent of its agents', t.jobs[0]!.finished === true && t.jobs[0]!.agents.every((a) => !a.finished));
  const t2 = navTree(proj, agents, [], [], jobs, new Set(), new Set(['d1', 'd2']))[0]!;
  check('and agents finished does not light the job group', t2.jobs[0]!.finished === false);

  // A done agent that something waits on shows blocked, not done: no finished tag.
  const pend = [{ requestId: 'r1', agentId: 'd1', agentRole: 'builder', projectId: 'p1', createdAt: T(23) }] as never;
  const t3 = navTree(proj, agents, pend, [], jobs, new Set(), new Set(['d1']))[0]!;
  const d1 = t3.agents.find((x) => x.id === 'd1')!;
  check('a done agent that something waits on carries its status honestly', d1.finished === (d1.status === 'done'), `status=${d1.status}`);
}

console.log('\nH · the sources apply the same condition in both places');
{
  const nav = readFileSync(new URL('../shell/Navigator.tsx', import.meta.url), 'utf8');
  const agent = readFileSync(new URL('../agent/agent.tsx', import.meta.url), 'utf8');
  check('the navigator tag follows a.finished only', /\{a\.finished && <span className="sh-nav-tag is-done">finished<\/span>\}/.test(nav) && !/a\.status === 'done' && <span className="sh-nav-tag/.test(nav));
  check('the tab tag follows done AND unseen', /t\.status === 'done' && unseenAgents\.has\(t\.id\) && <span className="ag-tab-tag">finished<\/span>/.test(agent));
  const head = agent.slice(agent.indexOf('<Tag tone={key}>'), agent.indexOf('<Tag tone={key}>') + 120);
  check('the Agent header Tag is unchanged: still driven by status, not by seen', head.length > 0 && !/unseenAgents/.test(head));
  // Hook order: AgentScreen has an early return; the new hook must come before it.
  const hook = agent.indexOf('useUnseenAgents()');
  const early = agent.indexOf('return', agent.indexOf('const unseenAgents = useUnseenAgents()'));
  check('the hook sits before AgentScreen\'s first return (rules of hooks)', hook > 0 && hook < early);
  const fn = agent.slice(agent.indexOf('export function AgentScreen'));
  const firstEarly = fn.search(/\n {2}if \([^)]*\) return/);
  check('…and before any conditional early return in AgentScreen', firstEarly === -1 || fn.indexOf('useUnseenAgents()') < firstEarly, `early@${firstEarly} hook@${fn.indexOf('useUnseenAgents()')}`);
}

console.log(failures === 0 ? '\nseen-agents verify: PASS\n' : `\nseen-agents verify: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
