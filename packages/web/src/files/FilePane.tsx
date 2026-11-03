/**
 * The file pane — rendered · raw · diff, and editing in place.
 *
 * TRACK C owns this file.
 *
 * Annotation 3 in the mockup: "diff and edit in the same view — correct a plan in
 * place instead of describing the correction in chat." That is the feature. The
 * agent is writing PLAN.md; you read it rendered, see what changed, fix the line
 * that is wrong, and the agent picks your text up from disk on its next read. No
 * round trip through a chat message that an agent then has to interpret.
 *
 * Two details that matter for that to be safe:
 *
 *  • The editor holds YOUR buffer, not the server's. While you are editing, an
 *    incoming `file_edit` for this path must not silently replace what you typed.
 *    It is surfaced as a conflict warning instead, and saving is your decision.
 *    The buffer lives in the tab store (useTabs.ts), not here, so switching tabs
 *    or screens doesn't throw it away (Amendment 29).
 *
 *  • `html` is inserted with dangerouslySetInnerHTML. That is safe *because* the
 *    daemon sanitises it (workspace/markdown.ts) and only because of that. The
 *    browser never renders markdown itself, so there is exactly one sanitizer in
 *    the system to audit.
 *
 * Links and images in that html point where the document meant them to (Amendment
 * 31): a relative href is the file's, not the app's, so the pane resolves it against
 * the file's folder (links.ts) and follows it as a Files deep link. It only rewrites
 * `href`, `src` and `target` on elements the sanitizer already let through — never
 * adds markup — so the sanitizer is still the one thing to audit.
 *
 * Rendered markdown fills the pane unless you ask for a reading column, and prints on
 * its own as a PDF (print.ts, Amendment 32).
 *
 * An HTML file renders too (Amendment 198), as the page it is, in a frame whose scripts
 * run sandboxed: `PAGE_SANDBOX` below, and the policy the daemon sends with it
 * (routes/workspace.ts, `pageCsp`). Its URL is a token the daemon mints for its root
 * (`usePageSrc`), so what it loads beside it is its own folder's and no other's. Its own
 * links and loads are its own, so nothing above rewrites them; the column and the PDF stay
 * markdown's.
 */

import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileContentResponse } from '@conductor/shared';
import { DiffView } from './DiffView.js';
import { headingSlugs, rawAround, resolveDocLink } from './links.js';
import { printRendered } from './print.js';
import type { View } from './tabs.js';
import { lineShown, putEdit, takeFocus, useEdit, useScrollMemory, useWantedLine } from './useTabs.js';
import { imageUrl, isImagePath, isPagePath, since, useFileRevision, usePageSrc, writeFile } from './useWorkspace.js';
import { errorText } from '../lib/errors.js';
import { hrefFor, navigate } from '../lib/nav.js';
import { SCREEN } from '../shell/nav.js';
import { drawMermaid, mermaidReason } from '../lib/mermaid.js';
import { useTheme } from '../shell/theme.js';

interface Props {
  /** The tab this pane draws, which is what its edit and scroll position belong to. */
  tabKey: string;
  /** The tab's root: a job's id, or a project directory's `dirRoot` (Amendment 39). */
  jobId: string;
  file: FileContentResponse;
  view: View;
  onView: (v: View) => void;
  role: string | undefined;
  now: number;
  onSaved: (file: FileContentResponse) => void;
  /** Whether the job's tree lists a file, once it has loaded — how a link picks its folder. */
  has?: (path: string) => boolean;
}

/** The href or src as the document wrote it, kept so a rewrite can be redone from it. */
const ORIGINAL = 'data-doc';

/**
 * Whether rendered markdown fills the pane or keeps to a reading column (Amendment 32).
 * One setting for every file, kept in the settings file (Amendment 46): it's about how
 * you read, not the file.
 */
const WIDTH_KEY = 'conductor.files.column';

/**
 * The frame's sandbox for an HTML page (Amendment 198): its scripts run, and nothing else
 * is let out. No `allow-same-origin`, so its origin is opaque and it can't touch the app's
 * DOM, storage or API (what it sends says `Origin: null`, and the guard refuses that). No
 * `allow-forms` or `allow-top-navigation`. No `allow-popups` either: the daemon's policy
 * leaves them out, and a window let out of the sandbox would open at the app's own origin.
 */
export const PAGE_SANDBOX = 'allow-scripts';

/** A short digest of a file's text, so a page whose text changed is a new `src`. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function FilePane({ tabKey, jobId, file, view, onView, role, now, onSaved, has }: Props) {
  const edit = useEdit(tabKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const rendered = useRef<HTMLDivElement | null>(null);
  /** Focus the editor when you start editing — not when a tab that was already editing comes back. */
  const started = useRef(false);
  const column = useSetting(WIDTH_KEY) === 'on';
  const setColumn = (next: boolean | ((c: boolean) => boolean)): void => {
    const v = typeof next === 'function' ? next(readSetting(WIDTH_KEY) === 'on') : next;
    writeSetting(WIDTH_KEY, v ? 'on' : 'off');
  };

  const editing = edit !== null;
  const draft = edit?.draft ?? file.raw;
  /** The server text the draft was based on — how a conflict is detected. */
  const base = edit?.base ?? file.raw;
  const dirty = editing && draft !== base;
  const conflicted = editing && file.raw !== base;

  const hasDiff = (file.diff ?? '').length > 0;
  const markdown = file.html !== undefined;
  // A page is drawn from disk, so a deleted one has only its source to show.
  const page = isPagePath(file.path) && !file.deleted;
  const renderable = markdown || page;
  // What the tab asked for, where the file can show it. A tab kept at `diff` whose
  // changes have since been committed, or at `rendered` for a file that isn't
  // markdown or a page, shows the text instead of an empty pane.
  const shown: View =
    view === 'rendered' && !renderable
      ? 'raw'
      : view === 'diff' && !hasDiff
        ? renderable
          ? 'rendered'
          : 'raw'
        : view;
  // The file's events and refreshes, as for an image, and its text: a page saved in a
  // project folder, which has no events, still reloads.
  const pageRev = useFileRevision(jobId, file.path);
  const framed = page && shown === 'rendered' && !editing && file.raw.length > 0;
  // Its token's URL (Amendment 198), minted for this page and asked again as the revision moves.
  const framedAt = usePageSrc(jobId, file.path, framed ? `${pageRev}.${digest(file.raw)}` : '', framed);

  useScrollMemory(body, tabKey, editing ? null : shown);

  /*
   * A line a link asked for (Amendment 141: `src/a.ts:12` clicked in a terminal). The text is
   * shown, the line marked and scrolled to the middle, once: after that the tab keeps its own
   * scroll again. Declared after useScrollMemory, so this runs after it has restored the tab.
   */
  const wanted = useWantedLine(tabKey);
  const [lit, setLit] = useState<number | null>(null);
  const litRef = useRef<HTMLElement | null>(null);
  useEffect(() => setLit(null), [tabKey]);
  useEffect(() => {
    if (wanted !== null && !editing && shown !== 'raw') onView('raw');
  }, [wanted, editing, shown]);
  useLayoutEffect(() => {
    if (wanted === null || editing || shown !== 'raw') return;
    setLit(wanted);
    lineShown(tabKey);
  }, [wanted, editing, shown, tabKey]);
  useLayoutEffect(() => {
    if (lit !== null) litRef.current?.scrollIntoView({ block: 'center' });
  }, [lit]);

  useEffect(() => {
    // `takeFocus`: a file just made from the tree opens with its editor already started
    // (Amendment 121), so the click that would have said "focus it" never happened.
    if (editing && (started.current || takeFocus(tabKey))) area.current?.focus();
    started.current = false;
  }, [editing, tabKey]);

  // A new copy of the file clears a failed save's message: it's about a file that has moved on.
  useEffect(() => setError(null), [file.raw]);

  /*
   * Point the rendered file's links and images where the document meant them. Done on
   * the elements rather than in the click alone so hovering shows the real target and
   * Cmd-click opens it in a new browser tab. Before paint, so a relative image is
   * already asking the daemon for itself rather than the dev server.
   */
  /*
   * Mermaid blocks, drawn (Amendment 60). The daemon marks them `md-mermaid` and keeps
   * their source; each gets its diagram before it and the source is hidden behind a
   * toggle. One that can't be drawn keeps its source, with the reason. Drawn again on a
   * theme change, so a dark diagram never sits on a light page.
   */
  const { theme } = useTheme();
  useEffect(() => {
    const el = rendered.current;
    if (!el) return;
    let live = true;
    for (const old of el.querySelectorAll('.md-diagram, .md-diagram-err, .md-diagram-toggle')) old.remove();
    for (const pre of el.querySelectorAll<HTMLElement>('pre.md-mermaid')) {
      pre.hidden = false;
      const source = pre.textContent ?? '';
      drawMermaid(source, theme).then(
        (svg) => {
          if (!live || !pre.isConnected) return;
          const box = document.createElement('div');
          box.className = 'md-diagram';
          box.innerHTML = svg;
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'md-diagram-toggle';
          toggle.textContent = 'source';
          toggle.onclick = () => {
            pre.hidden = !pre.hidden;
            toggle.textContent = pre.hidden ? 'source' : 'hide source';
          };
          pre.hidden = true;
          pre.before(box, toggle);
        },
        (err: unknown) => {
          if (!live || !pre.isConnected) return;
          const note = document.createElement('div');
          note.className = 'md-diagram-err';
          note.textContent = `Couldn't draw this diagram: ${mermaidReason(err)}`;
          pre.before(note);
        },
      );
    }
    return () => {
      live = false;
    };
  }, [file.html, shown, theme]);

  useLayoutEffect(() => {
    const el = rendered.current;
    if (!el) return;
    for (const a of el.querySelectorAll('a[href]')) {
      const raw = a.getAttribute(ORIGINAL) ?? a.getAttribute('href') ?? '';
      a.setAttribute(ORIGINAL, raw);
      const link = resolveDocLink(raw, file.path, has);
      if (link.kind === 'external') continue;
      // Everything that stays in this worktree stays in this browser tab.
      a.removeAttribute('target');
      if (link.kind === 'file') {
        a.setAttribute('href', hrefFor(SCREEN.files, { jobId, path: link.path }));
      } else if (link.kind === 'none') {
        a.removeAttribute('href');
        if (!a.hasAttribute('title')) a.setAttribute('title', "outside this job's worktree");
      }
    }
    for (const img of el.querySelectorAll('img[src]')) {
      const raw = img.getAttribute(ORIGINAL) ?? img.getAttribute('src') ?? '';
      img.setAttribute(ORIGINAL, raw);
      const link = resolveDocLink(raw, file.path, has);
      if (link.kind === 'file' && isImagePath(link.path)) {
        img.setAttribute('src', imageUrl(jobId, link.path, 0));
      }
    }
  }, [file.html, file.path, jobId, has, shown, editing]);

  /** A plain click on a link to another file opens it here, as a tab. */
  const follow = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as Element).closest('a');
    const raw = a?.getAttribute(ORIGINAL);
    if (!a || raw == null) return;
    const link = resolveDocLink(raw, file.path, has);
    if (link.kind === 'external') return;
    // A modified click is the browser's — new tab, new window — and the href says where.
    if (link.kind === 'file' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
    e.preventDefault();
    if (link.kind === 'file') {
      navigate(SCREEN.files, { jobId, path: link.path });
    } else if (link.kind === 'anchor') {
      const heads = [...(rendered.current?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])];
      const at = headingSlugs(heads.map((h) => h.textContent ?? '')).indexOf(link.slug.toLowerCase());
      heads[at]?.scrollIntoView({ block: 'start' });
    }
  };

  const startEditing = (): void => {
    started.current = true;
    putEdit(tabKey, { draft: file.raw, base: file.raw });
  };
  const stopEditing = (): void => putEdit(tabKey, null);
  const choose = (v: View): void => {
    stopEditing();
    onView(v);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await writeFile(jobId, file.path, draft);
      stopEditing();
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      stopEditing();
    }
  };

  const around = lit !== null ? rawAround(file.raw, lit) : null;
  const segments = file.path.split('/');
  const name = segments.pop() ?? file.path;

  return (
    <div className="c5-pane">
      <div className="c5-panehead">
        <span className="ui-crumb c5-crumb">
          {segments.map((s, i) => (
            <span key={`${i}:${s}`}>
              {s}
              <i>/</i>
            </span>
          ))}
          <b>{name}</b>
        </span>

        {file.deleted ? (
          <span className="c5-tag gone">deleted</span>
        ) : file.lastWriteAt ? (
          <span className="c5-tag live">
            ◉ written {since(file.lastWriteAt, now)} ago{role ? ` by ${role}` : ''}
          </span>
        ) : (
          <span className="c5-tag idle">unchanged this session</span>
        )}
        {dirty && <span className="c5-tag done">unsaved</span>}

        <div className="c5-actions">
          {renderable && (
            <button
              type="button"
              className={`c5-btn${shown === 'rendered' && !editing ? ' on' : ''}`}
              onClick={() => choose('rendered')}
            >
              rendered
            </button>
          )}
          <button
            type="button"
            className={`c5-btn${shown === 'raw' && !editing ? ' on' : ''}`}
            onClick={() => choose('raw')}
          >
            raw
          </button>
          <button
            type="button"
            className={`c5-btn${shown === 'diff' && !editing ? ' on' : ''}`}
            onClick={() => choose('diff')}
            disabled={!hasDiff}
            title={hasDiff ? 'unified diff against HEAD' : 'no changes against HEAD'}
          >
            ⑂ diff
          </button>

          {markdown && shown === 'rendered' && !editing && (
            <>
              <button
                type="button"
                className={`c5-btn${column ? ' on' : ''}`}
                aria-pressed={column}
                onClick={() => setColumn((c) => !c)}
                title={column ? 'fill the pane' : 'keep to a reading column'}
              >
                ¶ column
              </button>
              <button
                type="button"
                className="c5-btn"
                onClick={() => rendered.current && void printRendered(rendered.current, file.path)}
                title="print it, or save it as a PDF from the print dialog"
              >
                ⎙ PDF
              </button>
            </>
          )}

          {editing ? (
            <>
              <button
                type="button"
                className="c5-btn primary"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                {saving ? 'saving…' : 'save'} <kbd>⌘S</kbd>
              </button>
              <button type="button" className="c5-btn" onClick={stopEditing}>
                cancel <kbd>esc</kbd>
              </button>
            </>
          ) : file.deleted ? null : (
            <button type="button" className="c5-btn" onClick={startEditing}>
              ✎ edit
            </button>
          )}
        </div>
      </div>

      <div
        ref={body}
        className={`c5-panebody${shown === 'diff' && !editing ? ' flush' : ''}${framed ? ' flush c5-pagebody' : ''}`}
      >
        {file.deleted && !editing && (
          <div className={`c5-banner${shown === 'diff' ? ' inset' : ''}`}>
            Deleted from the worktree. This is git&rsquo;s last copy of it — what the
            agent removed, not something on disk.
          </div>
        )}
        {error && <div className="c5-error">{error}</div>}
        {conflicted && (
          <div className="c5-error">
            An agent rewrote this file while you were editing. Saving replaces its version
            with yours; cancel to take theirs.
          </div>
        )}

        {editing ? (
          <textarea
            ref={area}
            className="c5-editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => putEdit(tabKey, { draft: e.target.value, base })}
            onKeyDown={onKeyDown}
            aria-label={`edit ${file.path}`}
          />
        ) : shown === 'diff' ? (
          <DiffView diff={file.diff ?? ''} />
        ) : file.raw.length === 0 ? (
          // Nothing to render, and a blank pane reads as one that failed to load
          // (Amendment 121: a file made from the tree starts this way).
          <div className="c5-note c5-emptyfile">
            This file is empty.{!file.deleted && ' ✎ edit to write in it.'}
          </div>
        ) : framed ? (
          <>
            <div className="c5-pagenote">
              Runs sandboxed: its scripts run, but it can&rsquo;t reach Conductor, send
              requests, submit forms or open windows.
            </div>
            {framedAt.src ? (
              <iframe
                className="c5-page"
                src={framedAt.src}
                sandbox={PAGE_SANDBOX}
                referrerPolicy="no-referrer"
                title={`${file.path}, rendered`}
              />
            ) : (
              <div className="c5-note">{framedAt.error ? `Couldn’t open the page: ${framedAt.error}` : 'Opening the page…'}</div>
            )}
          </>
        ) : shown === 'rendered' && file.html !== undefined ? (
          // Sanitized server-side — see the note at the top of this file.
          <div
            ref={rendered}
            className={`c5-md${column ? ' column' : ''}`}
            onClick={follow}
            dangerouslySetInnerHTML={{ __html: file.html }}
          />
        ) : around ? (
          <div className="c5-raw">
            {around.before}
            <mark ref={litRef} className="c5-lit">
              {around.line}
            </mark>
            {around.after}
          </div>
        ) : (
          <div className="c5-raw">{file.raw}</div>
        )}
      </div>
    </div>
  );
}
