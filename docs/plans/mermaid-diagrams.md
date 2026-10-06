# Plan: Mermaid diagrams in rendered markdown

**Status: done (Amendment 60).** One change from the plan: strict mode alone let an
`<img>` in a label through, so labels are SVG text (`htmlLabels: false`) and the SVG is
scrubbed before it goes in. A real-browser check, `packages/web/scripts/mermaid-browser-check.sh`,
proves both.

**Problem.** A ` ```mermaid ` block in a markdown file shows as code, not as the diagram.
The same happens in an agent's reply, which is where diagrams often come from.

**Outcome.** Wherever Conductor renders markdown, a mermaid block is drawn as a diagram.
The source is one click away, and a diagram that can't be drawn falls back to its source
with the reason.

## Where markdown is rendered

| Where | How | File |
|---|---|---|
| Files, a rendered `.md` | The daemon renders HTML with `marked`, cleans it with `sanitize-html`, and the page inserts it | `daemon/src/workspace/markdown.ts`, `web/src/files/FilePane.tsx` |
| Agent screen, a reply | The page builds React elements, never an HTML string | `web/src/agent/markdown.tsx` |

## Approach

1. **Draw with the `mermaid` library, in the browser.** There is no other way to draw every
   diagram type faithfully. It is a new web dependency, which CONTRACT §3 says to escalate;
   asked for directly ("execute on the plan"). It is **loaded only when a page has a
   diagram** (`import('mermaid')`), so it adds nothing to the page otherwise.
   **Rejected:** a rendering service such as mermaid.ink or Kroki, which would send your
   files' contents off the machine. Also rejected: rendering in the daemon, which needs a
   headless browser.
2. **Strict security.** `securityLevel: 'strict'`: no click handlers and no HTML in labels,
   and mermaid cleans its SVG with DOMPurify. A diagram can't run script, which matters
   because the page inserts the SVG it returns.
3. **Files.** The daemon marks a mermaid fence as `<pre class="md-code md-mermaid">`,
   still containing its escaped source, so an old page, a print or a failure still shows
   the code. `FilePane` draws every `.md-mermaid` after it renders, replacing each with the
   diagram and a **source** toggle.
4. **Replies.** `agent/markdown.tsx` hands a mermaid fence to a new `MermaidBlock`
   component, in its own file, so `markdown.tsx` keeps its promise of no
   `dangerouslySetInnerHTML`. The component draws into a node it owns, shows the source
   while drawing, and falls back to it on an error.
5. **Theme.** Drawn with mermaid's `dark` or `default` theme to match `data-theme`, and
   drawn again when the theme changes.
6. **Errors.** A block mermaid can't parse keeps its source, with one line saying why.
   An agent's half-written diagram is the common case.

## Checks

- Daemon: a mermaid fence is marked `md-mermaid` and its source escaped; other fences are
  unchanged; `sanitize-html` keeps the class (`workspace/verify.ts`).
- Web, under Node: fence detection (`mermaid`, `Mermaid`, with and without options);
  `markdown.tsx` routes a mermaid fence to `MermaidBlock`, and still has no
  `dangerouslySetInnerHTML`; `FilePane` draws `.md-mermaid` (`agent/verify.ts`,
  `files/verify.ts`).
- The bundle: `vite build` resolves `mermaid` as a separate, lazily loaded chunk.
- In the browser, by hand: a flowchart, a sequence diagram and a broken block, in a
  file and in a reply, in both themes.

## Not in this

- Editing a diagram visually.
- Exporting a diagram as an image apart from its page. It prints with the page (⎙ PDF).
