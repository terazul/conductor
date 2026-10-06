/**
 * Links inside a rendered markdown file, resolved the way the file meant them.  TRACK C.
 * (Amendment 31)
 *
 * The daemon renders and sanitises the markdown (workspace/markdown.ts) and keeps a
 * relative href as the author wrote it. In the browser that href resolves against the
 * APP — `localhost:5173/Service-Mesh/x.md` — not against the file, so a link from one
 * document to another opened a blank tab, and a relative image never loaded. The pane
 * resolves them here instead, against the folder of the file it is showing.
 *
 * Only the path is worked out here. Whether the worktree allows it is still the
 * daemon's decision (`workspace/paths.ts`); a link that climbs out of the worktree is
 * simply not followed.
 *
 * Pure: no DOM, no store. `files/verify.ts` runs it under node.
 */

/** What a link in a rendered file is. */
export type DocLink =
  /** A file in this worktree, by its worktree-relative path. */
  | { kind: 'file'; path: string }
  /** `#section` — a heading in this file, by its slug. */
  | { kind: 'anchor'; slug: string }
  /** `https:`, `mailto:` — the web's, and left to the browser. */
  | { kind: 'external' }
  /** Nothing to follow: it leaves the worktree, or isn't a path at all. */
  | { kind: 'none' };

/**
 * Percent-decoded, because marked encodes the href it emits: a link to `my notes.md`
 * arrives as `my%20notes.md`, and the tree has the space. A `%` that isn't an escape
 * is kept as written.
 */
function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** A normalised worktree-relative path, or null if `segments` climb out of it. */
function normalise(segments: readonly string[]): string | null {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // climbed out
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * Where `href`, found in the file at `from`, points.
 *
 * `has` answers whether the worktree has a file, when the tree is known. It settles
 * one ambiguity: agents often write a link from `API-Gateway/a.md` to
 * `Service-Mesh/b.md` meaning the repo's `Service-Mesh/`, where the markdown rule is
 * the file's own folder. The file's folder wins, as it would anywhere else; the repo
 * root is tried only when the file's folder has no such file and the root does.
 * Without a tree, or with neither, the file's folder is the answer, and Files says
 * plainly if it isn't there.
 */
export function resolveDocLink(
  href: string,
  from: string,
  has?: (path: string) => boolean,
): DocLink {
  const h = href.trim();
  if (h.startsWith('#')) return { kind: 'anchor', slug: decode(h.slice(1)) };
  // Protocol-relative is another host; the sanitiser drops it, and so does this.
  if (h === '' || h.startsWith('//') || h.includes('\\')) return { kind: 'none' };
  if (/^[a-z][\w+.-]*:/i.test(h)) return { kind: 'external' };

  const bare = h.replace(/[?#].*$/, '');
  const parts = bare.split('/').map(decode);
  // A decoded separator would change which folder the rest of the path is in.
  if (parts.some((p) => p.includes('/') || p.includes('\\'))) return { kind: 'none' };

  const found = (path: string | null): DocLink =>
    path === null ? { kind: 'none' } : { kind: 'file', path };

  // A leading slash is the repo root, as it is on GitHub.
  if (bare.startsWith('/')) return found(normalise(parts));

  const dir = from.split('/').slice(0, -1);
  const local = normalise([...dir, ...parts]);
  if (has && dir.length > 0 && (local === null || !has(local))) {
    const rooted = normalise(parts);
    if (rooted !== null && has(rooted)) return found(rooted);
  }
  return found(local);
}

/**
 * The `#fragment` each heading answers to, in document order — GitHub's rule, so a
 * table of contents written for GitHub works here. Lower-cased, punctuation dropped,
 * spaces to hyphens; a repeat gets `-1`, `-2`.
 *
 * Computed when a link is clicked rather than written onto the headings as ids: the
 * sanitiser strips `id` on purpose, because an element id is also a global name the
 * page's own scripts can trip over.
 */
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = t
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
}
