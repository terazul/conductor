/**
 * A mermaid diagram in an agent's reply (Amendment 60).
 *
 * Its own file so `markdown.tsx` keeps its promise: no `dangerouslySetInnerHTML` there.
 * This draws into a node it owns, from mermaid's strict, cleaned SVG (lib/mermaid.ts).
 * Until it is drawn, and if it can't be, the source shows as a code block — which is
 * also what a server render, and so the Node checks, see.
 */

import { useEffect, useRef, useState } from 'react';
import { drawMermaid, mermaidReason } from '../lib/mermaid.js';
import { useTheme } from '../shell/theme.js';

export function MermaidBlock({ source }: { source: string }) {
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'drawing' | 'drawn' | 'failed'>('drawing');
  const [why, setWhy] = useState('');
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let live = true;
    setState('drawing');
    drawMermaid(source, theme).then(
      (svg) => {
        if (!live || !box.current) return;
        box.current.innerHTML = svg;
        setState('drawn');
      },
      (err: unknown) => {
        if (!live) return;
        setWhy(mermaidReason(err));
        setState('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [source, theme]);

  return (
    <div className="md-mermaid-block">
      <div ref={box} className="md-diagram" hidden={state !== 'drawn'} />
      {state === 'drawn' && (
        <button type="button" className="md-diagram-toggle" onClick={() => setShowSource((s) => !s)}>
          {showSource ? 'hide source' : 'source'}
        </button>
      )}
      {state === 'failed' && <div className="md-diagram-err">Couldn't draw this diagram: {why}</div>}
      {(state !== 'drawn' || showSource) && (
        <pre className="lang-mermaid">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
