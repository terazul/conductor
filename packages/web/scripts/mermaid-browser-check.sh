#!/bin/bash
# Draws real diagrams with src/lib/mermaid.ts in headless Chrome and checks the SVG is
# safe to insert (Amendment 60). Not in `make test`: it needs Chrome. Run it after
# upgrading mermaid.  usage: bash packages/web/scripts/mermaid-browser-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
ESB=$(ls -d ../../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/entry.ts" <<EOF
import { drawMermaid, scrubSvg } from '$(pwd)/src/lib/mermaid.ts';
(async () => {
  const r: string[] = [];
  const probe = async (name: string, src: string, want: string) => {
    try {
      const svg = await drawMermaid(src, 'dark');
      const h = document.createElement('div'); h.innerHTML = svg;
      const bad = Array.from(h.querySelectorAll('*')).filter((e) => ['img','script','iframe','foreignobject'].includes(e.localName.toLowerCase()) || Array.from(e.attributes).some((a) => a.name.toLowerCase().startsWith('on') || /javascript:/i.test(a.value))).length;
      r.push(name + '=' + (bad === 0 && (h.textContent ?? '').includes(want) ? 'ok' : 'FAIL'));
    } catch { r.push(name + '=refused'); }
  };
  await probe('flowchart', 'graph TD; A[Start]-->B[End]', 'Start');
  await probe('sequence', 'sequenceDiagram\n Alice->>Bob: hi', 'Alice');
  await probe('hostile', 'graph TD; A["<img src=x onerror=alert(1)>"]-->B; click A href "javascript:alert(1)"', 'img');
  await probe('broken', 'graph TD; A-->', '');
  // The last layer on its own: whatever mermaid might let through one day.
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://x.test/a.png"/><foreignObject><img src="x"/></foreignObject><a href="javascript:alert(1)"><text onclick="alert(1)">t</text></a><use href="#ok"/></svg>';
  const clean = scrubSvg(dirty);
  r.push('scrub=' + (!/script|<image|foreignObject|<img|javascript:|onclick/i.test(clean) && clean.includes('href="#ok"') ? 'ok' : 'FAIL'));
  document.getElementById('out')!.textContent = r.join(' ');
})();
EOF
"$ESB" "$D/entry.ts" --bundle --format=iife --outfile="$D/app.js" --log-level=error
echo '<!doctype html><html><body><pre id="out">pending</pre><script src="app.js"></script></body></html>' > "$D/t.html"
OUT=$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=20000 --allow-file-access-from-files --dump-dom "file://$D/t.html" 2>/dev/null | grep -o '<pre id="out">[^<]*' | sed 's/<pre id="out">//')
echo "$OUT"
[ "$OUT" = "flowchart=ok sequence=ok hostile=ok broken=refused scrub=ok" ]
