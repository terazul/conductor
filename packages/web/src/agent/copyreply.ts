/**
 * What every ⧉ copy on markdown does (Amendment 213): the reply's, a quote's and a message's.
 * The renderer (replycopy.tsx, with react-dom/server) is loaded when a copy button first shows,
 * so by the click the HTML can be made inside it and put on the clipboard as Cmd-C puts it
 * (`copyByEvent`), which keeps lists and their indents where they're pasted. Clicked before it
 * has loaded, or where the browser won't fire a copy event, it is `copyRich` as before.
 */

import { useEffect } from 'react';
import { copyByEvent, copyRich } from '../lib/clipboard.js';

type Renderer = typeof import('./replycopy.js');
type Prose = readonly { kind: string; text?: string }[];

let ready: Renderer | null = null;
let loading: Promise<Renderer> | null = null;

export function loadReplyCopy(): Promise<Renderer> {
  loading ??= import('./replycopy.js').then(
    (m) => (ready = m),
    (err: unknown) => {
      loading = null; // try again on the next copy
      throw err;
    },
  );
  return loading;
}

/** Load the renderer when a copy button mounts, so its click needn't wait. */
export function usePreloadReplyCopy(): void {
  useEffect(() => {
    loadReplyCopy().catch(() => undefined);
  }, []);
}

/** Copy `text` as `text/plain` and `blocks` drawn, colourless, as `text/html`. */
export function copyProse(text: string, blocks: Prose): Promise<void> {
  if (ready) {
    const { html } = ready.replyClipboard(blocks);
    if (copyByEvent(text, html)) return Promise.resolve();
    return copyRich(text, Promise.resolve(html));
  }
  return copyRich(text, loadReplyCopy().then((m) => m.replyClipboard(blocks).html));
}
