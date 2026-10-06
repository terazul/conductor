/**
 * The "add a project" form's rules (Amendment 45). Pure, so lib/verify.ts checks them
 * under Node.
 *
 * A project is one MAIN folder, where agents work and worktrees are cut, and any number
 * of REFERENCED folders its agents can read and edit in place. The form collects all of
 * them before anything is sent, so the project arrives whole, or not at all.
 */

/** A folder as typed or picked, without the trailing separator completion leaves. */
export function tidyPath(path: string): string {
  const t = path.trim();
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

/** The name a project gets when none is typed: the main folder's last segment. */
export function nameFrom(main: string): string {
  const t = tidyPath(main);
  return t.split('/').filter(Boolean).pop() ?? '';
}

/**
 * The referenced list after adding `draft`. A blank, a repeat, or the main folder itself
 * leaves it as it was, and says why, so the field can explain instead of silently
 * dropping what was typed.
 */
export function addReferenced(
  list: string[],
  draft: string,
  main: string,
): { list: string[]; why: string | null } {
  const d = tidyPath(draft);
  if (!d) return { list, why: null };
  if (d === tidyPath(main)) return { list, why: 'That is the main folder already.' };
  if (list.includes(d)) return { list, why: 'Already in the list.' };
  return { list: [...list, d], why: null };
}

/** What to say once the daemon has answered. */
export function addedLine(name: string, referenced: number, existing: boolean): string {
  if (existing) {
    return `${name} already points at that main folder, so nothing was added. Its folders are on its card, under … → ▤ folders.`;
  }
  return referenced === 0
    ? `Added ${name}.`
    : `Added ${name}, with ${referenced} referenced folder${referenced === 1 ? '' : 's'}.`;
}
