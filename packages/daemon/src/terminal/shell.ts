/**
 * Which shell a terminal runs, and with what environment (Amendment 112).
 *
 * `$SHELL`, else `/bin/bash`, else `/bin/sh`, always as a login shell (`-l`): the daemon is
 * often started from the dock launcher or launchd, without the PATH your profile builds, and a
 * terminal that cannot find `node` or `git` is no terminal. Pure, so verify can test it.
 *
 * Amendment 141: Settings can name another of the shells this machine has
 * (`conductor.terminal.shell`). `findShells` is that list: `$SHELL`, then `/etc/shells`, then
 * the usual three, each only if it is there. A setting naming one that is not (it was
 * uninstalled, or the settings file came from another machine) is passed over for the default.
 */

import { basename } from 'node:path';
import type { TermShell } from '@conductor/shared';

export interface ShellChoice {
  file: string;
  args: string[];
}

/**
 * The shell to run: the one Settings names if it is one of `found`, else `$SHELL` if it is
 * there, else bash, else sh.
 */
export function pickShell(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  wanted?: string | null,
  found?: readonly TermShell[],
): ShellChoice {
  if (wanted && found?.some((s) => s.path === wanted) && exists(wanted)) return { file: wanted, args: ['-l'] };
  const own = env['SHELL'];
  if (own && exists(own)) return { file: own, args: ['-l'] };
  for (const file of ['/bin/bash', '/bin/sh']) if (exists(file)) return { file, args: ['-l'] };
  // Nothing found is still an attempt: the spawn reports what is wrong, in a sentence.
  return { file: '/bin/sh', args: ['-l'] };
}

/**
 * The shells on this machine, `$SHELL` first. `etcShells` is the text of `/etc/shells` (empty
 * when there is none); comments and blank lines are skipped, and only absolute paths are
 * taken, so nothing in it is ever run as a command line.
 */
export function findShells(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, etcShells: string): TermShell[] {
  const listed = etcShells
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.startsWith('/'));
  const paths: string[] = [];
  for (const p of [env['SHELL'] ?? '', ...listed, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (p.startsWith('/') && !paths.includes(p) && exists(p)) paths.push(p);
  }
  const names = paths.map((p) => basename(p));
  return paths.map((path, i) => {
    const name = names[i]!;
    return { path, label: names.filter((n) => n === name).length > 1 ? `${name} · ${path}` : name };
  });
}

/**
 * The shell's environment: the daemon's own, with Conductor's credential taken out (as the
 * command runner does), colour switched on rather than off, and a real terminal type.
 */
export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  delete out['CONDUCTOR_TOKEN'];
  delete out['NO_COLOR'];
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  return out;
}
