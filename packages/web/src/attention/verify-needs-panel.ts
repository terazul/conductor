/**
 * Validator checks for Amendment 108 (answer an agent's requests in a side panel on its
 * own Agent screen; ADR 0007).
 *
 * The pure rules in ./needs.ts — what the panel shows for one agent, in what order, and
 * how each card's state is dropped when its request leaves — and source checks for the
 * wiring: the panel adds no keys, decides through useDecisions, takes the Inspector's
 * place on the Agent screen, and the alert card hides "open" for the agent you're on.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/attention/verify-needs-panel.ts
 */

import { readFileSync } from 'node:fs';
import { NO_COMPOSER } from './interaction.js';
import { freshCard, needsFor, pruneCards } from './needs.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const req = (requestId: string, agentId: string, m: number) => ({ requestId, agentId, createdAt: T(m) });
const alert = (id: string, agentIds: string[], m: number) => ({ id, agentIds, since: T(m) });
const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

console.log('\nA · needsFor: only that agent, oldest first');
{
  const pending = [req('r3', 'a', 30), req('r1', 'a', 10), req('rx', 'b', 5), req('r2', 'a', 20)];
  const alerts = [alert('al2', ['a', 'c'], 40), alert('alx', ['b'], 1), alert('al1', ['a'], 15), alert('aly', [], 2)];
  const got = needsFor('a', pending, alerts);
  check("only this agent's requests", got.requests.every((r) => r.agentId === 'a') && got.requests.length === 3);
  check('oldest request first', got.requests.map((r) => r.requestId).join() === 'r1,r2,r3', got.requests.map((r) => r.requestId).join());
  check('the alerts that name it, wherever it is in the list', got.alerts.map((a) => a.id).join() === 'al1,al2', got.alerts.map((a) => a.id).join());
  check("another agent's requests and alerts are not here", !got.requests.some((r) => r.agentId === 'b') && !got.alerts.some((a) => a.id === 'alx'));
  check('an alert naming nobody is nobody’s', !got.alerts.some((a) => a.id === 'aly'));
  const none = needsFor('z', pending, alerts);
  check('an agent with nothing waiting gets nothing', none.requests.length === 0 && none.alerts.length === 0);
  check('the inputs are not reordered', pending.map((r) => r.requestId).join() === 'r3,r1,rx,r2' && alerts.map((a) => a.id).join() === 'al2,alx,al1,aly');
  const tie = needsFor('a', [req('t1', 'a', 7), req('t2', 'a', 7), req('t3', 'a', 7)], []);
  check('two made at the same moment keep their order', tie.requests.map((r) => r.requestId).join() === 't1,t2,t3');
}

console.log('\nB · each card keeps its own state, and loses it when its request leaves');
{
  const fresh = freshCard();
  check('a card starts with nothing open, no draft and the cursor at the top', fresh.composer === NO_COMPOSER && Object.keys(fresh.draft.selected).length === 0 && Object.keys(fresh.draft.other).length === 0 && fresh.cursor.q === 0 && fresh.cursor.o === 0);
  check('two fresh cards share no draft', freshCard().draft !== freshCard().draft);
  const cards = new Map([
    ['r1', { ...fresh, composer: { kind: 'deny' as const, text: 'no' } }],
    ['r2', fresh],
  ]);
  const same = pruneCards(cards, ['r1', 'r2', 'r9']);
  check('nothing left: the same map back, so React sees no change', same === cards);
  const pruned = pruneCards(cards, ['r2']);
  check('a request that left takes its state with it', pruned !== cards && !pruned.has('r1') && pruned.has('r2') && pruned.size === 1);
  check('the rest keep theirs', pruned.get('r2') === fresh);
  check('the old map is not changed', cards.size === 2 && cards.has('r1'));
  check('nothing waiting: nothing kept', pruneCards(cards, []).size === 0);
}

console.log('\nC · the panel: no keys of its own, the same decide path, the same width rule');
{
  const panel = src('./NeedsPanel.tsx');
  check('it adds no keydown listener (the Needs you screen’s keys would fight the composer and i)', !/addEventListener\(\s*['"]keydown/.test(panel) && !/onKeyDown/.test(panel));
  check('it decides through useDecisions, scoped to this agent’s requests', /const decisions = useDecisions\(requests\);/.test(panel) && /decisions\.submit\(r\.requestId, d\)/.test(panel));
  check('its clock ticks only while something waits', /useNow\(requests\.length > 0\)/.test(panel));
  check('what it shows is needsFor, and needsFor is exported from it', /needsFor\(agent\.id, allPending, allAlerts\)/.test(panel) && /export \{ needsFor \} from '\.\/needs\.js';/.test(panel));
  check('each request keeps its own state, keyed by requestId, pruned when it leaves', /useState<ReadonlyMap<string, CardState>>/.test(panel) && /pruneCards\(prev,/.test(panel) && /cards\.get\(id\) \?\? freshCard\(\)/.test(panel));
  check('it reuses the three cards', /<PermissionCard/.test(panel) && /<QuestionCard/.test(panel) && /<AlertCard[^>]*onAgentScreen/.test(panel));
  check('empty, it says so for this agent, and can be closed', /Nothing is waiting on \{agent\.role\}\./.test(panel) && (panel.match(/onClick=\{onClose\}/g) ?? []).length >= 2);
  const at = panel.indexOf('<Splitter');
  check('sized like the details it stands in for: usePanel(AGENT_NEEDS) and a Splitter growing leftwards', /usePanel\(AGENT_NEEDS\)/.test(panel) && at >= 0 && panel.slice(at, panel.indexOf('/>', at)).includes('grow={-1}') && /className="atn-side" style=\{\{ width: `\$\{size\}px` \}\}/.test(panel));
  const css = src('./attention.css');
  const rule = css.slice(css.indexOf('.atn-side {'), css.indexOf('}', css.indexOf('.atn-side {')));
  check('.atn-side starts at AGENT_NEEDS.fallback, takes no flex, and draws no edge of its own', /\n\s*width: 340px;/.test(rule) && /flex: none;/.test(rule) && !/border-(left|right)/.test(rule));
  check('its body scrolls', /\.atn-side-body \{[^}]*overflow-y: auto;/.test(css));
  check('no colour of its own: tokens only', !/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(css.slice(css.indexOf('/* ── the Agent screen\'s Needs you panel'), css.indexOf('.atn-insp {'))));
}

console.log('\nD · the Agent screen opens it in the details\' place');
{
  const agent = src('../agent/agent.tsx');
  check('it renders <NeedsPanel> in the Inspector’s place while open', /\{needsOpen \? \(\s*<NeedsPanel agent=\{agent\} onClose=\{\(\) => setNeedsOpen\(false\)\} \/>\s*\) : \(\s*details && <Inspector /.test(agent));
  const banner = agent.slice(agent.indexOf('className="ag-blocked"'), agent.indexOf('</button>', agent.indexOf('className="ag-blocked"')));
  check('the blocked banner opens the panel, and no longer sends you to Needs you', /onClick=\{\(\) => setNeedsOpen\(true\)\}/.test(banner) && !/openAttention/.test(agent) && /answer →/.test(banner));
  check('a "needs you · N" header button toggles it, shown only when something waits', /\{needsHere > 0 && \(\s*<button[\s\S]*?onClick=\{\(\) => setNeedsOpen\(!needsOpen\)\}[\s\S]*?needs you · \{needsHere\}/.test(agent));
  const count = agent.slice(agent.indexOf('className="ag-tab-need"'), agent.indexOf('</span>', agent.indexOf('className="ag-tab-need"')));
  check("another tab's amber count opens that agent with its panel, without the tab's own click", /e\.stopPropagation\(\);/.test(count) && /openAgent\(target\);/.test(count) && /setNeedsOpen\(true\);/.test(count));
  check('the rest of the tab only switches agent, as before', /if \(target && t\.id !== agent\.id\) openAgent\(target\);\s*\}\}\s*>/.test(agent));
  check('`i` and the details button close it and show the details', /if \(needsRef\.current\) \{\s*setNeedsOpen\(false\);\s*setDetails\(true\);/.test(agent) && /onClick=\{toggleDetails\}/.test(agent) && /\n {6}toggleDetails\(\);\n/.test(agent));
  check('switching to an agent with nothing waiting closes it', /if \(needsHere === 0\) setNeedsOpen\(false\);\s*\}, \[active\]\);/.test(agent));
  const fn = agent.slice(agent.indexOf('export function AgentScreen'));
  check('its state and hooks sit before AgentScreen’s first return (rules of hooks)', fn.indexOf('useState(false)') > 0 && fn.indexOf('}, [active]);') > 0 && fn.indexOf('}, [active]);') < fn.indexOf('if (!agent) {'));
}

console.log('\nE · the alert card on its own agent\'s screen');
{
  const card = src('./AlertCard.tsx');
  check('onAgentScreen is an optional prop, off by default', /onAgentScreen\?: boolean;/.test(card) && /onAgentScreen = false \}: AlertCardProps/.test(card));
  check("under it, \"open\" for the alert's own agent is not offered; open for another agent still is", /\.filter\(\s*\(a\) => !\(onAgentScreen && a\.id === 'open' && alert\.agentIds\.includes\(a\.agentId\)\),?\s*\)/.test(card));
  check('the hand-off editor is unchanged', /<HandOffPanel agent=\{first\} editing=\{handingOff\}/.test(card));
}

console.log(failures === 0 ? '\nneeds-panel verify: PASS\n' : `\nneeds-panel verify: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
