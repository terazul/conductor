/**
 * Validator checks for Amendment 114's web half: a failed agent whose folder is gone gets
 * "recreate folder and continue" first, and its reason reads as one.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/attention/verify-folder.ts
 */

import { readFileSync } from 'node:fs';
import type { Agent, Alert } from '@conductor/shared';
import { alertActions } from './alerts.js';
import { failureSentence } from '../shell/describe.js';

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
  const alerts = readFileSync(new URL('./alerts.ts', import.meta.url), 'utf8');
  check('through POST /api/jobs/:id/folder', /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/folder`, \{ method: 'POST'/.test(alerts));
}

console.log(
  failures === 0
    ? '\nAmendment 114 web verify: PASS — a lost folder is recreated from Needs You, then the agent continues.'
    : `\nAmendment 114 web verify: FAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
