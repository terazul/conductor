/**
 * Making a new file from the tree.  TRACK C.  (Amendment 121)
 *
 * The name is typed with the folder already in it, so a file is made where you were
 * looking, and a name with more folders in it (`docs/notes/x.md`) makes them. The daemon
 * is the gate: it refuses `..`, an absolute path and anything under `.git`, and it
 * refuses a name that is taken. These checks only say so before the round trip, in a
 * sentence, for the mistakes a person makes at a keyboard; they are not a second gate.
 */

/** What the box offers when you ask for a new file and have not typed anything. */
export const DEFAULT_NAME = 'untitled.md';

/** Most filesystems cap one name at 255 bytes. */
const MAX_SEGMENT_BYTES = 255;

/**
 * The text the box starts with, and which part of it to select so typing replaces the
 * name and keeps the folder. `dir` is a tree path: '' is the root.
 */
export function prefill(dir: string): { value: string; from: number; to: number } {
  const folder = dir.replace(/^\/+|\/+$/g, '');
  const prefix = folder.length > 0 ? `${folder}/` : '';
  const value = `${prefix}${DEFAULT_NAME}`;
  const dot = DEFAULT_NAME.lastIndexOf('.');
  return { value, from: prefix.length, to: prefix.length + (dot > 0 ? dot : DEFAULT_NAME.length) };
}

export type NameCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A typed name as the path to send, or the sentence that says what is wrong with it.
 * Empty segments (`a//b`) and `.` are dropped, so what is sent is what the daemon would
 * make of it anyway, and the tab that opens is under the path that was written.
 */
export function checkName(raw: string, kind: 'file' | 'folder' = 'file'): NameCheck {
  const typed = raw.trim();
  if (typed.length === 0) return { ok: false, reason: `Type a name for the ${kind}.` };
  if (/[\u0000-\u001f\u007f]/.test(typed)) {
    return { ok: false, reason: 'A name cannot hold control characters.' };
  }
  if (typed.includes('\\')) {
    return { ok: false, reason: 'Separate folders with /, not \\.' };
  }
  if (typed.startsWith('/') || /^[a-zA-Z]:\//.test(typed)) {
    return { ok: false, reason: 'A name is relative to the worktree. Drop the leading /.' };
  }
  if (typed.endsWith('/')) {
    return { ok: false, reason: 'That ends in /, which names a folder. Add a file name after it.' };
  }
  const segments = typed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return { ok: false, reason: `Type a name for the ${kind}.` };
  for (const s of segments) {
    if (s === '..') return { ok: false, reason: 'A name cannot use .. to climb out of the folder.' };
    if (s.toLowerCase() === '.git') {
      return { ok: false, reason: 'Writing under .git is off limits: a file there can run code.' };
    }
    if (new TextEncoder().encode(s).length > MAX_SEGMENT_BYTES) {
      return { ok: false, reason: `A name can be at most ${MAX_SEGMENT_BYTES} bytes long.` };
    }
  }
  return { ok: true, path: segments.join('/') };
}

// ── folders and renames (Amendment 138) ─────────────────────────────────────

/** What the box offers for a new folder. */
export const DEFAULT_FOLDER = 'new-folder';

/** `prefill` for a new folder: the folder's own name selected, as a file's is. */
export function prefillFolder(dir: string): { value: string; from: number; to: number } {
  const folder = dir.replace(/^\/+|\/+$/g, '');
  const prefix = folder.length > 0 ? `${folder}/` : '';
  return { value: `${prefix}${DEFAULT_FOLDER}`, from: prefix.length, to: prefix.length + DEFAULT_FOLDER.length };
}

/**
 * The box for a rename starts with the whole path, so a move to another folder is the
 * same box; the last name is selected, a file's without its extension, so typing renames
 * it and keeps both the folder it is in and the kind of file it is.
 */
export function prefillRename(path: string, type: 'file' | 'dir'): { value: string; from: number; to: number } {
  const from = path.lastIndexOf('/') + 1;
  const name = path.slice(from);
  const dot = type === 'file' ? name.lastIndexOf('.') : -1;
  return { value: path, from, to: from + (dot > 0 ? dot : name.length) };
}

/**
 * `checkName` for a folder: the same rules in the same words, except that a trailing `/`
 * is how people write a folder, so it is dropped rather than refused.
 */
export function checkFolderName(raw: string): NameCheck {
  return checkName(raw.trim().replace(/\/+$/, ''), 'folder');
}

// ── moving ─────────────────────────────────────────────────────────────

/**
 * Move to…'s box starts with the folder the entry sits in, all of it selected, so typing
 * names another; '' is the top, and starts the box empty.
 */
export function prefillMove(path: string): { value: string; from: number; to: number } {
  const value = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  return { value, from: 0, to: value.length };
}

/**
 * The folder typed for Move to…, as a tree path. An empty box, `.` or `/` is the top, and
 * a leading `/` is read from the top too, since that is what a person typing it means;
 * otherwise a folder's name, by `checkFolderName`'s rules.
 */
export function checkMoveFolder(raw: string): NameCheck {
  const typed = raw.trim().replace(/^\/+/, '');
  if (typed === '' || typed === '.') return { ok: true, path: '' };
  return checkFolderName(typed);
}
