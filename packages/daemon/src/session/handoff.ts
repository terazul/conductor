/**
 * What an agent is told about the agents it waited for.  TRACK A.  (Amendment 37)
 *
 * `dependsOn` used to be timing only: a reviewer started once the builder was done,
 * with the same job prompt and its own brief, and found the builder's work only because
 * they share a worktree. The files arrived; what the builder said about them did not —
 * the cause a debugger found, the tests a validator saw fail. So the first prompt of an
 * agent that waited now carries each upstream agent's final reply.
 *
 * Only the final reply, and only the first prompt. The final reply is where an agent
 * reports; the turns before it are working notes. It goes in once, at launch: a resume
 * continues a session that already has it.
 *
 * Pure, so session/verify.ts checks the wording directly.
 */

/** Past this, a reply is cut. A report this long is a document; the rest is in its transcript. */
export const HANDOFF_CAP = 8_000;

export interface Upstream {
  role: string;
  /** Its last prose, or null when it finished without writing any. */
  reply: string | null;
}

function body(u: Upstream): string {
  const reply = u.reply?.trim();
  if (!reply) return '(It finished without a written reply.)';
  if (reply.length <= HANDOFF_CAP) return reply;
  return (
    `${reply.slice(0, HANDOFF_CAP)}\n` +
    `… (cut at ${HANDOFF_CAP.toLocaleString('en')} of ${reply.length.toLocaleString('en')} characters)`
  );
}

/** The section to put in a first prompt, or '' when the agent waited for nobody. */
export function handoffSection(upstream: readonly Upstream[]): string {
  if (upstream.length === 0) return '';
  const who = upstream.length === 1 ? 'the agent' : 'the agents';
  return [
    `You started after ${who} before you finished. They worked in this same folder, so ` +
      `what they changed is already here. What each said last:`,
    ...upstream.map((u) => `\n[${u.role}]\n${body(u)}`),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrators and helpers (Amendment 51)
// ─────────────────────────────────────────────────────────────────────────────

/** What an orchestrator is told about the job it runs, on top of the prompt and brief. */
export function orchestratorSection(role: string, cap: number): string {
  return [
    `You orchestrate this ${role} work. You may start up to ${cap} helper agent${cap === 1 ? '' : 's'} with the ` +
      '`start_helper` tool, each with its own part of the task. They work in this same folder, at the same time, ' +
      'with the same model and permissions you have.',
    'Split the work into parts that can run in parallel without touching the same files, start a helper for each, ' +
      "and then end your turn. When they have all finished you'll be told what each one reported; then check their " +
      'work, combine it, and start more if something is left. `list_helpers` shows where they are. Do the parts ' +
      'that do not split yourself.',
  ].join('\n');
}

/** A helper's brief: its part, and what to hand back. */
export function helperBrief(orchestrator: string, task: string): string {
  return (
    `You are one of the ${orchestrator}'s helpers. Do only this part of the task: ${task.trim()}\n` +
    `Other helpers are working in this folder at the same time, so stay inside your part. When you are done, ` +
    `reply with what you changed and anything the ${orchestrator} must know.`
  );
}

/** What an orchestrator is told when its helpers have finished. */
export function helperReport(helpers: readonly (Upstream & { status: string })[]): string {
  const how = (s: string): string => (s === 'done' ? '' : ` — ${s}, so it may not have finished its part`);
  return [
    `Your helper${helpers.length === 1 ? ' has' : 's have'} finished. What each said last:`,
    ...helpers.map((h) => `\n[${h.role}${how(h.status)}]\n${body(h)}`),
    '\nCheck their work, combine it, and carry on. Start more helpers if something is left.',
  ].join('\n');
}
