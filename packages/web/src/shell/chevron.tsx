/**
 * Every fold's chevron.  TRACK B.
 *
 * Here, not in ui.tsx, so a transcript, the Files tree or a Fleet card can be rendered under
 * Node with it, where ui.tsx's stylesheet doesn't load (Amendment 196). ui.tsx re-exports it.
 */

/**
 * The open/closed triangle every fold uses: it points right when closed and turns down
 * when open. Since Amendment 196 it is the only one, and it sits on the left of what it
 * opens, wherever that is: the navigator, the composer's agent settings (Amendment 110), a
 * transcript's turns, tool rows and steps, the Files tree, a Fleet card's agents, the
 * Project screen's jobs. Styled by `.sh-nav-chev` (shell.css).
 */
export function Chevron({ open }: { open: boolean }) {
  return <i className={`sh-nav-chev${open ? ' is-open' : ''}`} aria-hidden="true" />;
}

/** The chevron's room, empty, for a row in a list of folds that has nothing to open. */
export function ChevronSpace() {
  return <i className="sh-nav-chev-sp" aria-hidden="true" />;
}
