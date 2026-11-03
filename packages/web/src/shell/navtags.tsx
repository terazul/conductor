/**
 * A project's or a stack's headline in the navigator (Amendment 194)
 *
 * The Fleet card's own tags (`headlineTags`, fleet/rest.ts), drawn as the navigator's
 * `sh-nav-tag` chips in the same tones, so the panel and the grid can't disagree. One thing is
 * left out: **needs you**, where the row already has its amber count (`sh-nav-need`), which says
 * the same and how many. A row with no count, an agent blocked with nothing on the rail, keeps the
 * word. Its own file, with no stylesheet, so shell/verify.ts renders it under Node.
 */

import type { HeadTag } from '../fleet/rest.js';

/** The tags a row draws: all of them, but needs you when its count already says it. */
export function navTags(tags: readonly HeadTag[], needs: number): HeadTag[] {
  return needs > 0 ? tags.filter((t) => t.tone !== 'need') : [...tags];
}

/** The words a row's tooltip adds: "2 working, finished", with needs you left as the count says it. */
export function navTagWords(tags: readonly HeadTag[], needs: number): string {
  return navTags(tags, needs)
    .map((t) => t.word)
    .join(', ');
}

export function NavTags({ tags, needs }: { tags: readonly HeadTag[]; needs: number }) {
  return (
    <>
      {navTags(tags, needs).map((t) => (
        <span key={t.word} className={`sh-nav-tag is-${t.tone}`}>
          {t.word}
        </span>
      ))}
    </>
  );
}
