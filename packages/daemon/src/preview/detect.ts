/**
 * Dev-server detection from an agent's own shell commands.
 *
 * TRACK D OWNS THIS FILE.
 *
 * Track A emits a `tool_start` event for every Bash call (PLAN.md §1 finding A —
 * the async PreToolUse hook sees auto-approved calls too, so this fires even
 * under `acceptEdits`). We read those commands and guess whether one just
 * started a dev server, and on which port.
 *
 * Everything here is pure string work so it can be reasoned about and tested
 * without a daemon. The guess is deliberately allowed to be wrong: a candidate
 * port is worthless until `probe.ts` confirms something is actually listening,
 * and the proxy refuses to forward to an unconfirmed port. Detection proposes,
 * probing decides.
 */

/** A framework we recognise, with the port it listens on when not told otherwise. */
interface Launcher {
  kind: string;
  /** Matched against the normalised command string. */
  pattern: RegExp;
  /** Ports to probe when the command carries no explicit port. */
  defaults: number[];
}

/**
 * Order matters: the most specific launcher wins, so `next dev` is not reported
 * as a generic `npm`. Defaults are the framework's documented dev port.
 */
const LAUNCHERS: Launcher[] = [
  // 5174 is in the list because Conductor's own web dev server usually holds
  // 5173, so an agent's Vite steps up to the next free port.
  { kind: 'vite', pattern: /\bvite\b(?!\s+build)/i, defaults: [5173, 5174, 4173] },
  { kind: 'next', pattern: /\bnext\s+(dev|start)\b/i, defaults: [3000] },
  { kind: 'nuxt', pattern: /\bnuxt\s+(dev|start)\b/i, defaults: [3000] },
  { kind: 'astro', pattern: /\bastro\s+dev\b/i, defaults: [4321] },
  { kind: 'remix', pattern: /\bremix\s+(dev|vite:dev)\b/i, defaults: [3000] },
  { kind: 'gatsby', pattern: /\bgatsby\s+develop\b/i, defaults: [8000] },
  { kind: 'docusaurus', pattern: /\bdocusaurus\s+start\b/i, defaults: [3000] },
  { kind: 'storybook', pattern: /\b(storybook\s+dev|start-storybook)\b/i, defaults: [6006] },
  { kind: 'angular', pattern: /\bng\s+serve\b/i, defaults: [4200] },
  { kind: 'svelte', pattern: /\bsvelte-kit\s+dev\b/i, defaults: [5173] },
  { kind: 'webpack', pattern: /\bwebpack(-dev-server|\s+serve)\b/i, defaults: [8080] },
  { kind: 'parcel', pattern: /\bparcel\b(?!\s+build)/i, defaults: [1234] },
  { kind: 'serve', pattern: /\b(http-server|serve|live-server)\b/i, defaults: [3000, 8080, 5000] },
  { kind: 'rails', pattern: /\brails\s+(s|server)\b/i, defaults: [3000] },
  { kind: 'django', pattern: /\bmanage\.py\s+runserver\b/i, defaults: [8000] },
  { kind: 'flask', pattern: /\bflask\s+run\b/i, defaults: [5000] },
  { kind: 'uvicorn', pattern: /\buvicorn\b/i, defaults: [8000] },
  { kind: 'fastapi', pattern: /\bfastapi\s+dev\b/i, defaults: [8000] },
  { kind: 'python', pattern: /\bpython3?\s+-m\s+http\.server\b/i, defaults: [8000] },
  { kind: 'php', pattern: /\bphp\s+-S\b/i, defaults: [8000] },
  { kind: 'hugo', pattern: /\bhugo\s+server\b/i, defaults: [1313] },
  { kind: 'jekyll', pattern: /\bjekyll\s+serve\b/i, defaults: [4000] },
  { kind: 'dotnet', pattern: /\bdotnet\s+watch\b/i, defaults: [5000, 5001] },
  { kind: 'go', pattern: /\bair\b/i, defaults: [8080] },
  // Script runners come last: `pnpm dev` tells us nothing about the framework,
  // so we probe the ports the popular ones use.
  {
    kind: 'npm',
    pattern: /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(dev|start|serve|dev:\w+|start:\w+)\b/i,
    defaults: [3000, 5173, 8080, 4200, 8000],
  },
  { kind: 'make', pattern: /\bmake\s+(dev|serve|run)\b/i, defaults: [3000, 8080] },
];

/** Commands that mention a server but are definitely not starting one. */
const NEGATIVE = [
  /\bbuild\b/,
  /\b(test|vitest|jest|playwright|cypress)\b/,
  /\b--help\b/,
  /\bkill\b/,
  /\blsof\b/,
  /\bcurl\b/,
  /\bgrep\b/,
  /\binstall\b/,
  /\badd\b\s/,
  /\bnpx\s+tsc\b/,
  /\btypecheck\b/,
  /\blint\b/,
];

export interface DetectedLaunch {
  kind: string;
  /** Ports worth probing, most likely first. Never empty. */
  candidatePorts: number[];
  /** True when the command named a port outright — high confidence. */
  explicitPort: boolean;
  /** The command we matched, trimmed for display. */
  command: string;
}

/**
 * Strip the shell noise that would otherwise defeat the patterns: line
 * continuations, redirections, `nohup`, `&` backgrounding, `cd x &&` prefixes.
 */
function normalise(command: string): string {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/\r?\n/g, ' ; ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split on shell separators so `cd app && pnpm dev` is examined as `pnpm dev`
 * and a detached `pnpm dev &` loses its trailing ampersand. Quoted separators
 * are not handled — a dev-server launch inside a quoted string is not a case
 * worth the parser.
 */
function segments(command: string): string[] {
  return normalise(command)
    .split(/\s*(?:&&|\|\||;|\||&)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Ports we will never treat as a preview target — see `probe.ts`. */
function plausiblePort(n: number): boolean {
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

/**
 * Pull an explicit port out of a command. Handles the shapes that actually turn
 * up: `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000 cmd`,
 * `php -S localhost:8000`, `python -m http.server 8000`, `--host 0.0.0.0:3000`.
 */
export function extractPorts(segment: string): number[] {
  const found: number[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const n = Number(raw);
    if (plausiblePort(n) && !found.includes(n)) found.push(n);
  };

  // --port 3000 / --port=3000 / -p 3000 / --port:3000
  for (const m of segment.matchAll(/(?:--port|-p)[\s=:]+(\d{2,5})\b/gi)) push(m[1]);
  // PORT=3000 as a leading environment assignment
  for (const m of segment.matchAll(/\bPORT=(\d{2,5})\b/g)) push(m[1]);
  // host:port in an argument — php -S localhost:8000, --host 0.0.0.0:3000
  for (const m of segment.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/g)) {
    push(m[1]);
  }
  // Positional port: `python -m http.server 8000`, `rails s 3001`
  for (const m of segment.matchAll(/\b(?:http\.server|serve|server|s)\s+(\d{2,5})\b/g)) push(m[1]);

  return found;
}

/**
 * Does this Bash command look like it just started a dev server? Returns null
 * for the overwhelming majority of commands, which is the point — we are
 * looking for a handful of needles in an agent's whole shell history.
 */
export function detectLaunch(command: string): DetectedLaunch | null {
  for (const segment of segments(command)) {
    // The negative list is checked case-folded; the launcher patterns carry `i`
    // and match the raw segment, because some of them are case-sensitive in the
    // real world (`php -S`, and `-p` vs `-P` on other tools).
    if (NEGATIVE.some((re) => re.test(segment.toLowerCase()))) continue;

    const launcher = LAUNCHERS.find((l) => l.pattern.test(segment));
    if (!launcher) continue;

    const explicit = extractPorts(segment);
    if (explicit.length > 0) {
      return {
        kind: launcher.kind,
        candidatePorts: explicit,
        explicitPort: true,
        command: segment.slice(0, 300),
      };
    }

    return {
      kind: launcher.kind,
      candidatePorts: launcher.defaults,
      explicitPort: false,
      command: segment.slice(0, 300),
    };
  }
  return null;
}

/**
 * Pull the command string out of a Bash tool_start payload's `input`. The shape
 * is the SDK's, so render defensively — `input` is typed `unknown` in the
 * frozen contract for exactly this reason.
 */
export function commandFromToolInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const command = record['command'];
  return typeof command === 'string' && command.trim().length > 0 ? command : null;
}
