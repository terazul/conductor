/**
 * Which shell a terminal runs, and with what environment (Amendment 112).
 *
 * `$SHELL`, else `/bin/bash`, else `/bin/sh`, always as a login shell (`-l`): the daemon is
 * often started from the dock launcher or launchd, without the PATH your profile builds, and a
 * terminal that cannot find `node` or `git` is no terminal. Pure, so verify can test it.
 */

export interface ShellChoice {
  file: string;
  args: string[];
}

/** The shell to run: `$SHELL` if it is there, else bash, else sh. */
export function pickShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): ShellChoice {
  const wanted = env['SHELL'];
  if (wanted && exists(wanted)) return { file: wanted, args: ['-l'] };
  for (const file of ['/bin/bash', '/bin/sh']) if (exists(file)) return { file, args: ['-l'] };
  // Nothing found is still an attempt: the spawn reports what is wrong, in a sentence.
  return { file: '/bin/sh', args: ['-l'] };
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
