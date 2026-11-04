/**
 * Validator checks for Amendment 114's web half: a failed agent whose folder is gone gets
 * "recreate folder and continue" first, and its reason reads as one.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/attention/verify-folder.ts
 */

import { readFileSync } from 'node:fs';
import type { Agent, Alert } from '@conductor/shared';
import { alertActions } from './alerts.js';
import { alertTitle, alertWord, failureSentence } from '../shell/describe.js';
import { ApiError, explain, folderPresent } from '../lib/errors.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const agent = { id: 'agt_a', jobId: 'job_a', projectId: 'p', role: 'architect', status: 'failed', sdkSessionId: 'sess', autonomy: { budgetUsd: null }, costUsd: 0 } as unknown as Agent;
const alert = (cause: string): Alert =>
  ({ id: `failed:agt_a:${cause}`, kind: 'failed', cause, projectId: 'p', jobId: 'job_a', agentIds: ['agt_a'], since: '' }) as Alert;

console.log('\n1 · a failed agent whose folder is gone');
{
  const acts = alertActions(alert('folder_gone'), [agent]);
  check('the first button recreates the folder, for its job and agent', acts[0]?.id === 'restore' && acts[0].jobId === 'job_a' && acts[0].agentId === 'agt_a', JSON.stringify(acts[0]));
  check('there is no plain continue, which would fail the same way', !acts.some((a) => a.id === 'continue'));
  check('open and dismiss stay', acts.some((a) => a.id === 'open') && acts.at(-1)?.id === 'dismiss');
  check('any other failure still continues', alertActions(alert('launch_failed'), [agent])[0]?.id === 'continue');
  check('its reason reads as a sentence', /lost its folder/.test(failureSentence('folder_gone')), failureSentence('folder_gone'));
  const card = readFileSync(new URL('./AlertCard.tsx', import.meta.url), 'utf8');
  check('the card recreates, then continues', /restoreAndContinue\(a\.jobId, agent\)/.test(card) && /'recreate folder and continue'/.test(card));
  const endpoints = readFileSync(new URL('../agent/endpoints.ts', import.meta.url), 'utf8');
  check('through POST /api/jobs/:id/folder', /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/folder`, \{ method: 'POST'/.test(endpoints));
}

console.log('\n2 · a done agent whose message was refused (Amendment 199)');
{
  const refused = new ApiError('POST', '/api/agents/agt_a/message', 409, {
    error: 'could not deliver message',
    detail: 'architect: its folder /x is gone — recreate folder brings it back on its branch, and its conversation is kept',
    code: 'folder_gone',
    jobId: 'job_a',
    restorable: true,
  });
  const n = explain('Sending a message', refused);
  check('the composer notice says the sentence, with recreate on it', n.tone === 'warn' && /is gone/.test(n.text) && n.action?.kind === 'restore' && n.action.jobId === 'job_a', JSON.stringify(n));
  const cannot = new ApiError('POST', '/x', 409, { error: 'e', detail: 'd', code: 'folder_gone', jobId: 'job_a', restorable: false });
  check('none when it cannot be recreated', explain('Sending a message', cannot).action === undefined);
  check('none for any other 409', explain('Sending a message', new ApiError('POST', '/x', 409, { error: 'busy' })).action === undefined);
  check('a folder there already counts as recreated', folderPresent(new ApiError('POST', '/x', 409, { error: 'e', code: 'folder_present', jobId: 'job_a', restorable: true })) && !folderPresent(refused));

  const done = { ...agent, status: 'done' } as Agent;
  const card = { id: 'folder_gone:agt_a:7', kind: 'folder_gone', cause: 'folder_gone', projectId: 'p', jobId: 'job_a', agentIds: ['agt_a'], since: '', detail: '/x' } as Alert;
  const acts = alertActions(card, [done]);
  check('its Needs You card recreates first, then open, then dismiss', acts[0]?.id === 'restore_only' && acts[0].jobId === 'job_a' && acts.some((a) => a.id === 'open') && acts.at(-1)?.id === 'dismiss', JSON.stringify(acts));
  check('and does not continue on its own', !acts.some((a) => a.id === 'continue' || a.id === 'restore'));
  check('it reads as the agent losing its folder, with the message kept', /lost its folder/.test(alertTitle(card, [done]).subject) && alertWord(card) === 'folder gone');
  const composer = readFileSync(new URL('../agent/composer.tsx', import.meta.url), 'utf8');
  check('the composer notice offers it, recreating then sending what is in the box', /notice\.action\?\.kind === 'restore'/.test(composer) && /'recreate folder and send'/.test(composer) && /restoreFolder\(jobId\)/.test(composer));
}

console.log(
  failures === 0
    ? '\nAmendment 114 web verify: PASS — a lost folder is recreated from Needs You, then the agent continues; a done agent\'s refused message offers it in the composer and Needs You (Amendment 199).'
    : `\nAmendment 114 web verify: FAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
