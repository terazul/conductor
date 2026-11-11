/**
 * Who made an agent's model, for the small lettered square beside its dot (Amendment 208).
 *
 * The engine an agent runs on (Claude, Copilot, OpenRouter) is not who made its model:
 * Copilot runs OpenAI's and Anthropic's, OpenRouter runs nearly everyone's. The mark is the
 * maker, read from the model id, and its title says the engine too: "OpenAI gpt-5 · via
 * Copilot". An id no rule knows gets its engine's mark, so a mark is never a guess.
 *
 * Pure: no DOM, no React. lib/verify.ts checks it under Node.
 */

import type { Agent } from '@conductor/shared';
import { shortModel } from './models.js';
import { CLAUDE, providerLabel, providerOf } from './providers.js';

/** Each has a `--src-<key>` token (tokens.css) in both themes. */
export const SOURCE_KEYS = [
  'claude',
  'openai',
  'google',
  'meta',
  'mistral',
  'xai',
  'deepseek',
  'qwen',
  'copilot',
  'openrouter',
  'other',
] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export interface Source {
  key: SourceKey;
  /** One or two letters, the square's text. */
  mark: string;
  /** The maker's name: "Claude", "OpenAI". For an id no rule knows, the engine's. */
  label: string;
  /** The engine it runs on: "Claude", "Copilot", "OpenRouter". */
  engine: string;
}

const MAKERS: Record<SourceKey, { mark: string; label: string }> = {
  claude: { mark: 'C', label: 'Claude' },
  openai: { mark: 'O', label: 'OpenAI' },
  google: { mark: 'G', label: 'Google' },
  meta: { mark: 'M', label: 'Meta' },
  mistral: { mark: 'Mi', label: 'Mistral' },
  xai: { mark: 'x', label: 'xAI' },
  deepseek: { mark: 'D', label: 'DeepSeek' },
  qwen: { mark: 'Q', label: 'Qwen' },
  copilot: { mark: 'Cp', label: 'Copilot' },
  openrouter: { mark: 'OR', label: 'OpenRouter' },
  other: { mark: '?', label: 'Unknown' },
};

/** OpenRouter's `maker/model`: the part before the slash decides. */
const PREFIXES: Record<string, SourceKey> = {
  anthropic: 'claude',
  openai: 'openai',
  google: 'google',
  'meta-llama': 'meta',
  mistralai: 'mistral',
  'x-ai': 'xai',
  deepseek: 'deepseek',
  qwen: 'qwen',
};

/** A bare id, by its name. Anthropic's Bedrock ids carry `anthropic.` with a region in front. */
const NAMES: [RegExp, SourceKey][] = [
  [/^claude|anthropic/, 'claude'],
  [/^gpt-|^o[134](?:$|-)/, 'openai'],
  [/^gemini/, 'google'],
  [/^llama/, 'meta'],
  [/^mistral/, 'mistral'],
  [/^grok/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^qwen/, 'qwen'],
];

function makerOf(model: string): SourceKey | null {
  const id = model.trim().toLowerCase();
  const slash = id.indexOf('/');
  if (slash > 0) return PREFIXES[id.slice(0, slash)] ?? null;
  return NAMES.find(([re]) => re.test(id))?.[1] ?? null;
}

/** The engine's own mark, for a model none of the rules knows. */
function engineKey(provider: string): SourceKey {
  return provider === CLAUDE || provider === 'copilot' || provider === 'openrouter' ? provider : 'other';
}

export function sourceOf(agent: Pick<Agent, 'provider' | 'model'>): Source {
  const provider = providerOf(agent);
  const key = makerOf(agent.model) ?? engineKey(provider);
  const engine = providerLabel(provider);
  return { key, mark: MAKERS[key].mark, label: key === 'other' ? engine : MAKERS[key].label, engine };
}

/**
 * The square's title: "OpenAI gpt-5 · via Copilot", "Claude opus-5-5". The engine is left out
 * when it says nothing new: Claude's own agents, and a mark that is already the engine's.
 */
export function sourceTitle(agent: Pick<Agent, 'provider' | 'model'>): string {
  const s = sourceOf(agent);
  const model = shortModel(agent.model.replace(/^[^/]+\//, ''));
  const same = s.label === s.engine || (s.key === 'claude' && providerOf(agent) === CLAUDE);
  return `${s.label} ${model}${same ? '' : ` · via ${s.engine}`}`;
}
