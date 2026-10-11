/**
 * The context windows the engines have reported.  TRACK A.  (Amendment 120)
 *
 * `handoffCap` (handoff.ts) is a quarter of the next model's window. It used to know only a
 * small table of floors, because nothing read a window from anywhere. The model lists do
 * carry one, and this is where it is kept:
 *
 *   OpenRouter   `context_length` on each model of its public list
 *   Copilot      `capabilities.limits.max_context_window_tokens` on each model of its list
 *   Claude       `max_input_tokens` on each model of the gateway's `GET /v1/models`, when the
 *                gateway says (Claude Code's own list has no window)
 *
 * It is written by whoever lists the models (`copilotModels`, `openRouterModels`, `catalog`),
 * by provider and exact id, and read by the supervisor when it builds a prompt. The list is
 * asked for when Spawn's picker, or anything else, asks for models; this holds what the
 * daemon has heard since it started, so right after a restart it is empty until a list is
 * asked for again, and the floors in handoff.ts stand in meanwhile.
 *
 * A Claude Code `[1m]` model is not looked up: the list gives the base model's window, and
 * `[1m]` is the 1,000,000 one, which the floors already say.
 */

const reported = new Map<string, number>();

const keyOf = (provider: string, id: string): string => `${provider}\u0000${id}`;

/** A window is a whole number of tokens above zero. Anything else a list says is ignored. */
export function validWindow(tokens: unknown): tokens is number {
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 1;
}

/** Keep what `provider`'s list said. Models with no usable window are skipped. Returns how many were kept. */
export function recordWindows(provider: string, models: Iterable<{ id: string; tokens?: unknown }>): number {
  let kept = 0;
  for (const m of models) {
    if (typeof m.id !== 'string' || !m.id || !validWindow(m.tokens)) continue;
    reported.set(keyOf(provider, m.id), Math.floor(m.tokens));
    kept += 1;
  }
  return kept;
}

/** The window `provider` reported for exactly `model`, in tokens, or undefined when it has not said. */
export function reportedWindow(provider: string, model: string): number | undefined {
  if (/\[1m\]$/i.test(model.trim())) return undefined;
  return reported.get(keyOf(provider, model.trim()));
}

/** Forget what was reported — verify.ts, between its fakes. */
export function forgetWindows(): void {
  reported.clear();
}
