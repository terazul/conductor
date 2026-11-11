/**
 * An agent's turn ending ends its process (Amendment 133).
 *
 * A Claude run ends at its first `result` and closes its input (`backends/claude.ts`), so
 * the Claude Code process behind it exits. Anything it started in the background goes with
 * it: a background subagent reports back by waking the main loop for another turn, and
 * nothing can wake a process that has gone. An architect that fans out builders "in the
 * background" and ends its turn to wait for them loses every one of them, with nothing
 * written (seen 7 Oct and again 12 Oct).
 *
 * So three things, all here so they are tested as one:
 *
 *   - every Claude agent is told, in its system prompt (`TURN_END_LINE`);
 *   - a background `Agent` call is run in the foreground instead (`foregroundInput`), from the
 *     PreToolUse hook, with a note to the model saying so. Several Agent calls in one message
 *     still run side by side; the turn just waits for them;
 *   - a `Workflow`, which only ever runs in the background, is declined with the reason
 *     (`declinedHere`), so the model does the same work with foreground agents.
 *
 * An agent that has to wait for something outside, such as a GitHub build, is told to block on it in the
 * foreground (the same line). Ending the turn "to wait" leaves it finished, with nothing to wake it.
 *
 * Background shell commands are left alone: a dev server started for this turn's tests is
 * meant to stop with it. The line says so.
 */

/** Said in every Claude agent's system prompt, after its persona's own. */
export const TURN_END_LINE =
  'You run inside Conductor. When your turn ends, your process ends, and anything you started in the ' +
  'background is killed with it: background subagents, workflows, background shell commands and scheduled ' +
  'wake-ups. Run subagents in the foreground (several Agent calls in one message still run in parallel) and ' +
  'wait for all of them before you end your turn. Conductor runs a background Agent call in the foreground ' +
  'for you, and declines workflows. Nothing can wake you once your turn has ended, so never end it to wait ' +
  'for something outside (a CI run, a deploy): wait in the foreground first, with a blocking command such as ' +
  '`gh run watch --exit-status`, repeating the call if it times out, and end your turn when it has finished.';

/** The names Claude Code has given its subagent tool. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** What the model is told when its background call was run in the foreground. */
export const FOREGROUND_NOTE =
  'Conductor ran this agent in the foreground: a background agent would be killed when your turn ends, ' +
  'because your process ends with it. Its answer is the result of this call.';

/**
 * The input to run instead, and the note to send with it, when `tool` is a subagent asked to run in the
 * background; null for anything else, which runs as asked.
 */
export function foregroundInput(
  tool: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; note: string } | null {
  if (!AGENT_TOOLS.has(tool) || input['run_in_background'] !== true) return null;
  return { input: { ...input, run_in_background: false }, note: FOREGROUND_NOTE };
}

/** Why `tool` is declined in a Conductor agent, or null when it isn't. */
export function declinedHere(tool: string): string | null {
  if (tool !== 'Workflow') return null;
  return (
    'Not run: a workflow runs in the background, and Conductor ends your process when your turn ends, ' +
    'which would kill it before it finished. Do the same work with Agent calls in the foreground: put ' +
    'several in one message to run them in parallel, and wait for them before ending your turn.'
  );
}

/**
 * How an agent hands you a message to send (Amendment 207): in a ```message block, which the
 * transcript shows as the message with a ⧉ copy of its own that copies only it. Agents had set a
 * draft apart with --- lines, which Conductor can't tell from the text around it, so the reply's
 * copy took the notes with it.
 */
export const MESSAGE_LINE =
  'When the user asks you to draft something for them to send (an email, a chat or Teams message, a reply, ' +
  'an announcement), put only the message itself in a fenced block marked message: a line with ```message, ' +
  'the message in markdown, and a line with ```. Keep your notes about it outside the block, before or after. ' +
  'Conductor shows the block as the message, with a copy button that copies only what is inside. One block per ' +
  'message; if the message itself holds a code block, open and close the message block with four backticks.';

/** Every agent's lines from Conductor: the turn-end line, then how to hand over a message. */
export const CONDUCTOR_LINES = `${TURN_END_LINE}\n\n${MESSAGE_LINE}`;

/** The system prompt to append: the persona's own, if any, then Conductor's lines. */
export function withTurnEndLine(systemPrompt: string | null | undefined): string {
  const own = systemPrompt?.trim();
  return own ? `${own}\n\n${CONDUCTOR_LINES}` : CONDUCTOR_LINES;
}
