/**
 * Unified diff renderer.
 *
 * TRACK C owns this file.
 *
 * Parses `git diff` output rather than asking the server for a structured form,
 * because the whole-worktree diff has to remain a real patch a human can copy
 * and apply. Restructuring it server-side would produce something that reads the
 * same and no longer applies.
 *
 * Line numbers come from the hunk headers, so an added line shows its position
 * in the NEW file and a removed line its position in the OLD one — which is what
 * you need when you're about to go fix it.
 */

interface Line {
  kind: 'file' | 'hunk' | 'meta' | 'add' | 'del' | 'ctx';
  text: string;
  num: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(diff: string): Line[] {
  const out: Line[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.length === 0) continue;

    if (raw.startsWith('diff --git ')) {
      // `diff --git a/x b/x` — the b-side is the name worth showing.
      const name = raw.slice(11).split(' b/').at(-1) ?? raw;
      out.push({ kind: 'file', text: name, num: '' });
      continue;
    }
    if (
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename from') ||
      raw.startsWith('rename to') ||
      raw.startsWith('Binary files')
    ) {
      out.push({ kind: 'meta', text: raw, num: '' });
      continue;
    }

    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: 'hunk', text: raw, num: '' });
      continue;
    }

    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw, num: String(newLine) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw, num: String(oldLine) });
      oldLine += 1;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      out.push({ kind: 'meta', text: raw, num: '' });
    } else {
      out.push({ kind: 'ctx', text: raw, num: String(newLine) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return out;
}

export function DiffView({ diff }: { diff: string }) {
  if (diff.trim().length === 0) {
    return <div className="c5-note">no changes against HEAD</div>;
  }
  const lines = parseDiff(diff);
  return (
    <div className="c5-diff">
      {lines.map((line, i) => (
        <div key={i} className={`c5-dline ${line.kind}`}>
          <span className="c5-dnum">{line.num}</span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
