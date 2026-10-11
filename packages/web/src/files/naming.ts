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
export function checkName(raw: string): NameCheck {
  const typed = raw.trim();
  if (typed.length === 0) return { ok: false, reason: 'Type a name for the file.' };
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
  if (segments.length === 0) return { ok: false, reason: 'Type a name for the file.' };
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
