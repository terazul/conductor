/**
 * The bar across the top of the message box (Amendment 215): which project and agent you are
 * writing to, "conductor / developer", and the job's name when it has one, "· Nightly tests".
 *
 * Tinted with the project's colour, 18% of `--proj` over the box's `--surf` (agent.css), which
 * keeps `--ink` and the job's `--ink2` past 4.5:1 for every project colour in both themes
 * (lib/verify.ts §61). With no colour known it is plain, in the box's own colours.
 */

export interface ReplyBarWords {
  /** The project's name, which opens it; null until the project is known. */
  project: string | null;
  /** The agent's role (Amendment 184), as plain text. */
  agent: string;
  /** The job's name, in the quieter ink; null when it has none. */
  job: string | null;
}

export function replyBarWords(project: string | undefined, agent: string, job: string | undefined): ReplyBarWords {
  return { project: project?.trim() || null, agent, job: job?.trim() || null };
}

/** The bar as one line, for its title: "conductor / developer · Nightly tests". */
export function replyBarLine(w: ReplyBarWords): string {
  return `${w.project ? `${w.project} / ` : ''}${w.agent}${w.job ? ` · ${w.job}` : ''}`;
}
