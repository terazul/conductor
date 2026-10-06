/**
 * Drawing mermaid diagrams (Amendment 60). The one place that loads the `mermaid`
 * library, and only when a page has a diagram to draw: it is large, and most pages have
 * none.
 *
 * Three layers make inserting its SVG safe. See docs/plans/mermaid-diagrams.md.
 *  1. `securityLevel: 'strict'`: no click handlers, and mermaid cleans its SVG.
 *  2. `htmlLabels: false`: labels are SVG text, not HTML in a foreignObject. Strict mode
 *     alone let an `<img>` in a label through — without its handler, but an image that
 *     can load any URL (found by checking in a real browser, Amendment 60).
 *  3. `scrubSvg`: whatever is left of script, iframe, img, image, foreignObject, `on…` attributes
 *     and `javascript:` links is removed before the SVG goes into the page.
 */

import type { Theme } from '../shell/theme.js';

/** A fence's language names mermaid: ```mermaid, whatever the case, options after it. */
export function isMermaid(lang: string | null | undefined): boolean {
  return (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';
}

type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
let seq = 0;

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

/** The mermaid theme for Conductor's. */
export const mermaidTheme = (theme: Theme): 'dark' | 'default' => (theme === 'dark' ? 'dark' : 'default');

/**
 * Draw one diagram. Resolves to its SVG, or rejects with mermaid's reason — which the
 * callers show beside the source they fall back to.
 */
export async function drawMermaid(source: string, theme: Theme): Promise<string> {
  const mermaid = await load();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: mermaidTheme(theme),
  });
  seq += 1;
  const { svg } = await mermaid.render(`cd-mermaid-${seq}`, source);
  return scrubSvg(svg);
}

const UNSAFE_TAGS = ['script', 'iframe', 'img', 'image', 'foreignobject', 'object', 'embed'];

/** Remove anything that could run or fetch from an SVG string. Browser only: it parses. */
export function scrubSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (UNSAFE_TAGS.includes(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      const external = (name === 'href' || name === 'xlink:href') && !a.value.startsWith('#');
      if (name.startsWith('on') || /^\s*javascript:/i.test(a.value) || external) el.removeAttribute(a.name);
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

/** The first line of a mermaid error: its parser writes several, the first says what. */
export function mermaidReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n').find((l) => l.trim())?.trim() ?? 'it could not be drawn';
}
