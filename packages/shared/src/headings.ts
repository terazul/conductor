/**
 * The headings a hand-off closes with (Amendment 162). Pure, and here so the daemon, which
 * checks an agent's `hand_off`, and the browser, whose hand-off card checks a person's draft,
 * read them the same way.
 *
 * A persona's system prompt closes with the headings the next agent reads (Amendment 126):
 * "End with: **Changed** (each file, one line), **How I checked** …". Those bold names are the
 * headings. They are read from the system prompt the agent was launched with, which its row
 * already keeps (Amendment 68), so they are what the agent was actually told, a persona edited
 * since changes nothing, and a restart keeps them. A prompt with no "End with:" line, or none in
 * bold on it, has none, and nothing is checked.
 */

/** The most headings read from one prompt, and the longest one. */
export const CLOSING_HEADINGS_MAX = 20;
export const CLOSING_HEADING_LEN_MAX = 80;

const words = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The bold names on the LAST line of `systemPrompt` that starts "End with:" (any case), in order,
 * each once, without a trailing colon. [] for no prompt, no such line, or nothing bold on it.
 */
export function closingHeadingsOf(systemPrompt: string | null | undefined): string[] {
  if (!systemPrompt) return [];
  const line = systemPrompt
    .split('\n')
    .filter((l) => /^\s*end with:/i.test(l))
    .at(-1);
  if (!line) return [];
  const out: string[] = [];
  for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) {
    const h = words(m[1]!).replace(/:$/, '').trim();
    if (h === '' || h.length > CLOSING_HEADING_LEN_MAX) continue;
    if (out.some((x) => x.toLowerCase() === h.toLowerCase())) continue;
    out.push(h);
    if (out.length === CLOSING_HEADINGS_MAX) break;
  }
  return out;
}

/**
 * The `headings` that `summary` has no heading for, in their order. [] when every one is there,
 * and for no headings at all.
 *
 * A heading is there when a line starts with it, as a word, case aside, in one of these forms:
 * a Markdown heading (`## Context`, `### Context and goals`), bold or italic (`**Context**`,
 * `**Context:**`, `- **Context** (a table)`, `_Context_`), or plain with a colon or on a line of
 * its own (`Context:`, `Context`). A list marker or a quote in front is skipped. The same word
 * opening a sentence ("Context is thin") or inside one is not a heading, and doesn't count.
 */
export function missingHeadings(summary: string, headings: readonly string[]): string[] {
  if (headings.length === 0) return [];
  const lines = summary.split('\n').map((raw) => {
    let l = raw.trim().replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+[.)])\s+/, '');
    const marked = /^#{1,6}\s/.test(l) || /^(\*{1,2}|_{1,2})\S/.test(l);
    l = l.replace(/^#{1,6}\s+/, '').replace(/^(\*{1,2}|_{1,2})/, '');
    return { text: words(l).toLowerCase(), marked };
  });
  const has = (heading: string): boolean => {
    const h = words(heading).toLowerCase();
    return lines.some(({ text, marked }) => {
      if (!text.startsWith(h)) return false;
      const rest = text.slice(h.length);
      if (rest === '' || rest.startsWith(':')) return true;
      // Marked as a heading: any break that isn't the word going on ("Plan" is not "Planning").
      return marked && !/^[\p{L}\p{N}]/u.test(rest);
    });
  };
  return headings.filter((h) => !has(h));
}
