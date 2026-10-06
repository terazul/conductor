/**
 * The file tree, with per-file change badges.
 *
 * TRACK C owns this file.
 *
 * The badges are the reason this screen exists. Annotation 2 in the mockup:
 * "green badges show exactly which files each agent has touched, and how
 * recently." So each changed file carries three facts, in the order they matter:
 *
 *   NEW / +18 −4   what happened to it      (--done / --fail, from git)
 *   8s             how long ago             (--live, from the event log)
 *   BUILDER        which agent did it       (--ink3, from Track A's attribution)
 *
 * Directories show a rolled-up count, so a collapsed `src/` still tells you
 * something moved underneath it. Folders containing changes start expanded —
 * a tree you have to click open to find the new work is a tree that failed.
 */

import { useMemo } from 'react';
import type { FileNode } from '@conductor/shared';
import type { Folders } from './tabs.js';
import { since, type Touch } from './useWorkspace.js';

interface Props {
  root: FileNode;
  selected: string | null;
  onSelect: (path: string) => void;
  /**
   * What you opened and closed, held by the screen's tab store rather than here, so
   * it survives leaving the screen (Amendment 29). Opening a file un-collapses its
   * folders there too, which is what keeps the selected row visible.
   */
  folders: Folders | undefined;
  /** `open` is whether the folder is open now. */
  onToggle: (path: string, open: boolean) => void;
  touches: Map<string, Touch>;
  roles: Map<string, string>;
  now: number;
}

/** Directories that contain a change, so the interesting paths open themselves. */
function dirsWithChanges(node: FileNode, acc = new Set<string>()): Set<string> {
  if (node.type !== 'dir') return acc;
  if (node.change && node.path.length > 0) acc.add(node.path);
  for (const kid of node.children ?? []) dirsWithChanges(kid, acc);
  return acc;
}

export function FileTree({ root, selected, onSelect, folders, onToggle, touches, roles, now }: Props) {
  const autoOpen = useMemo(() => dirsWithChanges(root), [root]);
  const collapsed = useMemo(() => new Set(folders?.collapsed), [folders]);
  const openedByUser = useMemo(() => new Set(folders?.opened), [folders]);

  const isOpen = (path: string): boolean => {
    if (collapsed.has(path)) return false;
    // Top level and anything with changes underneath is open by default.
    return path.split('/').length === 1 || autoOpen.has(path) || openedByUser.has(path);
  };

  const toggle = (path: string): void => onToggle(path, isOpen(path));

  const rows: React.ReactNode[] = [];

  const walk = (node: FileNode, depth: number): void => {
    for (const kid of node.children ?? []) {
      const indent = { paddingLeft: 8 + depth * 13 };

      if (kid.type === 'dir') {
        const open = isOpen(kid.path);
        rows.push(
          <button
            key={`d:${kid.path}`}
            type="button"
            className="c5-row dir"
            style={indent}
            onClick={() => toggle(kid.path)}
            aria-expanded={open}
          >
            <span className="c5-caret">{open ? '▾' : '▸'}</span>
            <span className="c5-name">{kid.name}/</span>
            {kid.change && (kid.change.added > 0 || kid.change.removed > 0) ? (
              <span className="c5-badge">
                {kid.change.added > 0 && <b className="c5-pos">+{kid.change.added}</b>}
                {kid.change.removed > 0 && <b className="c5-neg">−{kid.change.removed}</b>}
              </span>
            ) : null}
          </button>,
        );
        if (open) walk(kid, depth + 1);
        continue;
      }

      const touch = touches.get(kid.path);
      const at = touch?.at ?? kid.change?.at;
      const role = touch?.agentId ? roles.get(touch.agentId) : undefined;
      // Listed because it changed, not because it's there: git knows it went, and
      // what it held can still be opened from git's copy (Amendment 29).
      const gone = kid.change?.deleted === true;

      rows.push(
        <button
          key={`f:${kid.path}`}
          type="button"
          className={`c5-row${kid.path === selected ? ' on' : ''}${gone ? ' gone' : ''}`}
          style={indent}
          onClick={() => onSelect(kid.path)}
          aria-current={kid.path === selected}
          title={gone ? `${kid.path} was deleted — opens git's last copy` : undefined}
        >
          <span className="c5-caret" />
          <span className="c5-name">{kid.name}</span>
          {kid.change ? (
            <span className="c5-badge">
              {gone ? (
                <>
                  <b className="c5-gone">deleted</b>
                  {kid.change.removed > 0 && <b className="c5-neg">−{kid.change.removed}</b>}
                </>
              ) : kid.change.created ? (
                <b className="c5-new">new</b>
              ) : (
                <>
                  {kid.change.added > 0 && <b className="c5-pos">+{kid.change.added}</b>}
                  {kid.change.removed > 0 && <b className="c5-neg">−{kid.change.removed}</b>}
                </>
              )}
              {role && <b className="c5-who">{role}</b>}
              {at && <b className="c5-age">{since(at, now)}</b>}
            </span>
          ) : null}
        </button>,
      );
    }
  };

  walk(root, 0);

  /**
   * Arrow keys move between rows. The tree is built from real <button>s so Tab
   * already works; this is the pattern a file tree is expected to answer to, and
   * CONTRACT.md §5.3 asks for keyboard first rather than keyboard eventually.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.c5-row')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    const target = buttons[next < 0 ? 0 : next];
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  return (
    <div
      className="c5-tree"
      role="tree"
      aria-label="worktree files"
      onKeyDown={onKeyDown}
    >
      {rows.length > 0 ? rows : <div className="c5-note">no files</div>}
    </div>
  );
}
