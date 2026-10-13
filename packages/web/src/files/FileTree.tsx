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
 *
 * The rest of the verbs (Amendment 138), when the screen passes `verbs`: a folder row
 * has **+/** (new folder) after its **+**, and every row on disk has **✎** (rename) and
 * **⌫** (delete). They are siblings of the row's button, as the + is, shown on hover and
 * focus. On a focused row F2 renames, and Delete (or ⌘⌫) deletes. A rename opens the name box in
 * the row's place; a delete's confirm (the screen's, `confirm`) sits under its row.
 */

import { useMemo } from 'react';
import type { FileNode } from '@conductor/shared';
import type { Folders } from './tabs.js';
import { NewFileForm } from './NewFileForm.js';
import { since, type Touch } from './useWorkspace.js';

/** New folder, rename and delete (Amendment 138). Held by the screen, as `adding` is. */
export interface TreeVerbs {
  /** The folder whose new-folder box is open ('' is the root), or null. */
  folderIn: string | null;
  onFolder: (dir: string) => void;
  /** Make the folder at this path. Rejects with the reason it could not. */
  onMakeFolder: (path: string) => Promise<void>;
  /** The entry whose rename box is open, or null. */
  renaming: string | null;
  onRename: (path: string) => void;
  /** Rename `from` to `to`. Rejects with the reason it could not. */
  onRenamed: (from: string, to: string) => Promise<void>;
  onDelete: (node: FileNode) => void;
  /** The entry a delete is asking about, or null; `confirm` is drawn under its row. */
  deleting: string | null;
  confirm: React.ReactNode;
  /** Put away the folder or rename box. */
  onCancel: () => void;
}

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
  /**
   * Making a new file (Amendment 121). Without `onAdd` the tree has no + at all.
   * `adding` is the folder whose name box is open ('' is the root), `onAdd` opens one,
   * `onCreate` makes the file at the path typed, rejecting with the reason it could not,
   * and `onCancelAdd` puts the box away.
   */
  adding?: string | null;
  onAdd?: (dir: string) => void;
  onCreate?: (path: string) => Promise<void>;
  onCancelAdd?: () => void;
  /** Without it the rows have only the + (Amendment 138). */
  verbs?: TreeVerbs;
}

/** Directories that contain a change, so the interesting paths open themselves. */
function dirsWithChanges(node: FileNode, acc = new Set<string>()): Set<string> {
  if (node.type !== 'dir') return acc;
  if (node.change && node.path.length > 0) acc.add(node.path);
  for (const kid of node.children ?? []) dirsWithChanges(kid, acc);
  return acc;
}

export function FileTree({
  root,
  selected,
  onSelect,
  folders,
  onToggle,
  touches,
  roles,
  now,
  adding = null,
  onAdd,
  onCreate,
  onCancelAdd,
  verbs,
}: Props) {
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
  const nodes = new Map<string, FileNode>();

  /** The name box for `dir`, sat where that folder's children are. */
  const form = (dir: string, depth: number): React.ReactNode =>
    onCreate && onCancelAdd ? (
      <NewFileForm
        key={`n:${dir}`}
        dir={dir}
        indent={8 + depth * 13}
        onCreate={onCreate}
        onCancel={onCancelAdd}
      />
    ) : null;

  /** The new-folder box for `dir`, where a new file's would be. */
  const folderForm = (dir: string, depth: number): React.ReactNode =>
    verbs ? (
      <NewFileForm
        key={`nd:${dir}`}
        kind="folder"
        dir={dir}
        indent={8 + depth * 13}
        onCreate={verbs.onMakeFolder}
        onCancel={verbs.onCancel}
      />
    ) : null;

  /** The rename box, in the row's own place. */
  const renameForm = (node: FileNode, depth: number): React.ReactNode =>
    verbs ? (
      <NewFileForm
        key={`r:${node.path}`}
        kind={node.type === 'dir' ? 'rename-dir' : 'rename-file'}
        dir={node.path}
        indent={8 + depth * 13}
        onCreate={(to) => verbs.onRenamed(node.path, to)}
        onCancel={verbs.onCancel}
      />
    ) : null;

  /** Rename and delete, and for a folder new folder, beside a row. */
  const actions = (node: FileNode): React.ReactNode =>
    verbs ? (
      <>
        {node.type === 'dir' && (
          <button
            type="button"
            className="c5-iconbtn c5-act"
            onClick={() => verbs.onFolder(node.path)}
            title={`New folder in ${node.path}/`}
            aria-label={`New folder in ${node.path}`}
          >
            +/
          </button>
        )}
        <button
          type="button"
          className="c5-iconbtn c5-act"
          onClick={() => verbs.onRename(node.path)}
          title={`Rename ${node.path} (F2)`}
          aria-label={`Rename ${node.path}`}
        >
          ✎
        </button>
        <button
          type="button"
          className="c5-iconbtn c5-act c5-del"
          onClick={() => verbs.onDelete(node)}
          title={`Delete ${node.path} (Delete)`}
          aria-label={`Delete ${node.path}`}
        >
          ⌫
        </button>
      </>
    ) : null;

  /** The delete's confirm, under the row it is about. */
  const confirmFor = (path: string): void => {
    if (verbs && verbs.deleting === path && verbs.confirm) {
      rows.push(
        <div key={`x:${path}`} className="c5-delrow">
          {verbs.confirm}
        </div>,
      );
    }
  };

  // The root's boxes are the first thing in the tree.
  const rootForm = adding === '' ? form('', 0) : null;
  if (rootForm) rows.push(rootForm);
  const rootFolder = verbs?.folderIn === '' ? folderForm('', 0) : null;
  if (rootFolder) rows.push(rootFolder);

  const walk = (node: FileNode, depth: number): void => {
    for (const kid of node.children ?? []) {
      const indent = { paddingLeft: 8 + depth * 13 };
      nodes.set(kid.path, kid);

      if (kid.type === 'dir') {
        const open = isOpen(kid.path);
        if (verbs?.renaming === kid.path) {
          rows.push(renameForm(kid, depth));
        } else {
          // The + is a sibling of the row's button, not inside it: a button in a button is
          // not valid, and the row's click is the folder opening.
          rows.push(
            <div key={`d:${kid.path}`} className="c5-dirrow">
              <button
                type="button"
                className="c5-row dir"
                style={indent}
                onClick={() => toggle(kid.path)}
                aria-expanded={open}
                data-path={kid.path}
              >
                <span className="c5-caret">{open ? '▾' : '▸'}</span>
                <span className="c5-name">{kid.name}/</span>
                {/* A nested clone or submodule's branch, as a quiet mark (Amendment 94). */}
                {kid.repo && <span className="c5-repo">⑂ {kid.repo.branch ?? 'detached'}</span>}
                {kid.change && (kid.change.added > 0 || kid.change.removed > 0) ? (
                  <span className="c5-badge">
                    {kid.change.added > 0 && <b className="c5-pos">+{kid.change.added}</b>}
                    {kid.change.removed > 0 && <b className="c5-neg">−{kid.change.removed}</b>}
                  </span>
                ) : null}
              </button>
              {onAdd && (
                <button
                  type="button"
                  className="c5-iconbtn c5-add"
                  onClick={() => onAdd(kid.path)}
                  title={`New file in ${kid.path}/`}
                  aria-label={`New file in ${kid.path}`}
                >
                  +
                </button>
              )}
              {actions(kid)}
            </div>,
          );
        }
        confirmFor(kid.path);
        // Under its own row, open or not: asking for a name on a folded folder still
        // has to show the box. Opening the file then opens the folder.
        const own = adding === kid.path ? form(kid.path, depth + 1) : null;
        if (own) rows.push(own);
        const ownFolder = verbs?.folderIn === kid.path ? folderForm(kid.path, depth + 1) : null;
        if (ownFolder) rows.push(ownFolder);
        if (open) walk(kid, depth + 1);
        continue;
      }

      const touch = touches.get(kid.path);
      const at = touch?.at ?? kid.change?.at;
      const role = touch?.agentId ? roles.get(touch.agentId) : undefined;
      // Listed because it changed, not because it's there: git knows it went, and
      // what it held can still be opened from git's copy (Amendment 29).
      const gone = kid.change?.deleted === true;

      if (verbs?.renaming === kid.path && !gone) {
        rows.push(renameForm(kid, depth));
        continue;
      }

      const row = (
        <button
          key={`f:${kid.path}`}
          type="button"
          className={`c5-row${kid.path === selected ? ' on' : ''}${gone ? ' gone' : ''}`}
          style={indent}
          onClick={() => onSelect(kid.path)}
          aria-current={kid.path === selected}
          title={gone ? `${kid.path} was deleted — opens git's last copy` : undefined}
          data-path={kid.path}
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
        </button>
      );
      // A deleted file is not on disk to rename or delete, so it keeps the bare row.
      rows.push(
        verbs && !gone ? (
          <div key={`f:${kid.path}`} className="c5-filerow">
            {row}
            {actions(kid)}
          </div>
        ) : (
          row
        ),
      );
      confirmFor(kid.path);
    }
  };

  walk(root, 0);

  /**
   * Arrow keys move between rows. The tree is built from real <button>s so Tab
   * already works; this is the pattern a file tree is expected to answer to, and
   * CONTRACT.md §5.3 asks for keyboard first rather than keyboard eventually.
   * F2 on a row renames it, and Delete or ⌘⌫ deletes it (Amendment 138), as in most file trees.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // ⌘⌫ too: a Mac keyboard's delete key is Backspace, and Finder deletes with ⌘⌫.
    const del = e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey);
    if (verbs && (e.key === 'F2' || del)) {
      const path = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('button.c5-row')?.dataset['path'];
      const node = path === undefined ? undefined : nodes.get(path);
      if (!node || node.change?.deleted) return;
      e.preventDefault();
      if (e.key === 'F2') verbs.onRename(node.path);
      else verbs.onDelete(node);
      return;
    }
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
