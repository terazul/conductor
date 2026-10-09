/**
 * The transcript.  TRACK B.
 *
 * Turns a flat event stream into something a person can read and, more
 * importantly, *scan*. Three decisions carry most of the weight:
 *
 *  1. YOUR TURNS LOOK DIFFERENT.  A pale left bar and a lighter ink, so a long
 *     transcript can be skimmed for "what did I actually tell it" without
 *     reading the agent's replies. That question is asked constantly and is
 *     otherwise almost impossible to answer.
 *
 *  2. EVERY TOOL CALL COLLAPSES TO ONE LINE, diffs included (Amendment 25). A
 *     turn with a dozen edits otherwise pushes the agent's own prose off the
 *     screen, which is the thing you were reading. A reply folds to one line too,
 *     from its role label, but starts open (Amendment 18) — mechanics hide
 *     themselves, output waits for you to fold it (Amendment 33).
 *
 *  3. A BLOCKED ASK STAYS IN THE TRANSCRIPT after it is answered. The pending
 *     queue clears, but "it asked, I chose this" is the most valuable line in
 *     the history and must not vanish with the request.
 */

import { useMemo, useState } from 'react';
import { HANDOFF_BY_USER_NOTE, HANDOFF_HELD_NOTE } from '@conductor/shared';
import type {
  BlockMode,
  DecisionSummary,
  Event,
} from '@conductor/shared';
import { counts, countingSource, pickString } from '../shell/describe.js';
import { OUTSIDE, linkablePath, type FileLinks } from './links.js';
import { foldLine, isFolded, setFold, updateFolds, useFolds } from './folds.js';
import { lineCount, renderMarkdown } from './markdown.js';

// ── model ───────────────────────────────────────────────────────────────────

interface ProseBlock {
  kind: 'prose';
  key: string;
  text: string;
}

interface ToolBlock {
  kind: 'tool';
  key: string;
  tool: string;
  label: string;
  input: unknown;
  ok: boolean | null;
  summary: string | null;
  durationMs: number | null;
  added: number | null;
  removed: number | null;
  created: boolean;
}

interface AskBlock {
  kind: 'ask';
  key: string;
  label: string;
  requestKind: 'permission' | 'question';
  blockMode: BlockMode;
  answered: DecisionSummary | null;
}

interface NoteBlock {
  kind: 'note';
  key: string;
  text: string;
  tone: 'live' | 'need' | 'fail' | 'done' | 'idle';
}

type Block = ProseBlock | ToolBlock | AskBlock | NoteBlock;

export interface Turn {
  key: string;
  who: 'you' | 'agent';
  /** `you` turns only. */
  text: string;
  synthetic: boolean;
  blocks: Block[];
}

/**
 * Group the stream into turns. Pure; recomputed whenever events change.
 *
 * `worktreePath` is what a tool's absolute `file_path` is relative to. A `file_edit`
 * carries the worktree-relative path, so without it the two never match and an edit row
 * never gets its `+N −M`.
 */
export function buildTranscript(events: readonly Event[], worktreePath = ''): Turn[] {
  const turns: Turn[] = [];
  const tools = new Map<string, ToolBlock>();
  const asks = new Map<string, AskBlock>();
  let prevStatus: string | null = null;
  // Amendment 8: two channels report every write, and summing both double-counts.
  const editWinner = countingSource(events);

  const agentTurn = (seq: number): Turn => {
    const last = turns.at(-1);
    if (last && last.who === 'agent') return last;
    const t: Turn = { key: `a${seq}`, who: 'agent', text: '', synthetic: false, blocks: [] };
    turns.push(t);
    return t;
  };

  for (const e of events) {
    const p = e.payload;

    switch (p.kind) {
      case 'user_text':
        turns.push({
          key: `u${e.seq}`,
          who: 'you',
          text: p.text,
          synthetic: p.synthetic === true,
          blocks: [],
        });
        break;

      case 'text':
        agentTurn(e.seq).blocks.push({ kind: 'prose', key: `p${e.seq}`, text: p.text });
        break;

      case 'tool_start': {
        const block: ToolBlock = {
          kind: 'tool',
          key: `t${e.seq}`,
          tool: p.tool,
          label: p.label,
          input: p.input,
          ok: null,
          summary: null,
          durationMs: null,
          added: null,
          removed: null,
          created: false,
        };
        tools.set(p.toolUseId, block);
        agentTurn(e.seq).blocks.push(block);
        break;
      }

      case 'tool_end': {
        const block = tools.get(p.toolUseId);
        if (block) {
          block.ok = p.ok;
          block.summary = p.summary;
          block.durationMs = p.durationMs ?? null;
        }
        break;
      }

      case 'file_edit': {
        // Attach the real line counts to the most recent tool call that touched
        // this path — the diffstat is more trustworthy than a summary string.
        // Only the source that counts for this path contributes a number; the
        // other one still marks the file as created if it saw that.
        const keep = counts(p, editWinner);
        for (const block of [...tools.values()].reverse()) {
          const touched = pickString(block.input, 'file_path', 'path');
          if (touched !== null && linkablePath(touched, worktreePath) === p.path) {
            if (keep) {
              block.added = (block.added ?? 0) + p.added;
              block.removed = (block.removed ?? 0) + p.removed;
            }
            block.created = block.created || p.created === true;
            break;
          }
        }
        break;
      }

      case 'request': {
        const block: AskBlock = {
          kind: 'ask',
          key: `r${e.seq}`,
          label: p.label,
          requestKind: p.requestKind,
          blockMode: p.blockMode,
          answered: null,
        };
        asks.set(p.requestId, block);
        agentTurn(e.seq).blocks.push(block);
        break;
      }

      case 'resolved': {
        const block = asks.get(p.requestId);
        if (block) block.answered = p.decision;
        break;
      }

      case 'status': {
        const note = statusNote(p.status, prevStatus, p.blockMode, p.error, p.detail);
        if (note) agentTurn(e.seq).blocks.push({ ...note, key: `s${e.seq}` });
        prevStatus = p.status;
        break;
      }

      // usage / todo drive the inspector; worktree, dev_server and console are
      // job-scoped and never reach an agent's stream.
      default:
        break;
    }
  }

  // Drop an agent turn that ended up with nothing to show.
  return turns.filter((t) => t.who === 'you' || t.blocks.length > 0);
}

function statusNote(
  status: string,
  prev: string | null,
  blockMode: BlockMode | undefined,
  error: string | undefined,
  detail?: string,
): Omit<NoteBlock, 'key'> | null {
  if (status === 'blocked') {
    return {
      kind: 'note',
      text: blockMode === 'parked' ? 'parked — waiting for you' : 'held — waiting for you',
      tone: 'need',
    };
  }
  if (status === 'failed') {
    // The SDK's own words, when it gave any (F20): a bare "error" said nothing, and was
    // where Needs You sent you to find out why.
    const why = detail ? (!error || error === 'error' ? detail : `${error}: ${detail}`) : error;
    return { kind: 'note', text: why ? `failed — ${why}` : 'failed', tone: 'fail' };
  }
  if (status === 'paused') {
    // Not every pause is yours: a budget, the job's cap and a daemon restart pause too,
    // and saying "by you" for those sent people looking for a click they never made.
    if (!error || error === 'paused by the user') return { kind: 'note', text: 'paused by you', tone: 'idle' };
    return { kind: 'note', text: `paused — ${error}`, tone: error.startsWith('budget') ? 'need' : 'idle' };
  }
  if (status === 'stopped') {
    // Distinct from 'finished' on purpose. This agent did not reach an end of its own;
    // someone ended it, and a transcript that said "finished" would erase that.
    return { kind: 'note', text: 'terminated by you', tone: 'idle' };
  }
  // Interrupted by a restart and queued to resume on its own (Amendment 53).
  if (status === 'queued' && error) return { kind: 'note', text: error, tone: 'idle' };
  if (status === 'done') {
    // Done, but it never said it was ready, so the agents after it wait (Amendment 104); or a
    // person said it for it.
    if (error === HANDOFF_HELD_NOTE) return { kind: 'note', text: `finished — ${HANDOFF_HELD_NOTE}`, tone: 'need' };
    if (error === HANDOFF_BY_USER_NOTE) return { kind: 'note', text: 'finished — handed off by you', tone: 'done' };
    return { kind: 'note', text: 'finished', tone: 'done' };
  }
  if (status === 'working' && prev === 'blocked') {
    return { kind: 'note', text: 'resumed', tone: 'live' };
  }
  return null;
}

// ── diff rendering ──────────────────────────────────────────────────────────

interface DiffLine {
  sign: ' ' | '+' | '-';
  text: string;
}

/**
 * A diff from an Edit's own input. `old_string`/`new_string` are what the SDK
 * gives us, so this is the actual change rather than a re-read of the file.
 */
function diffFromInput(input: unknown): DiffLine[] | null {
  const before = pickString(input, 'old_string');
  const after = pickString(input, 'new_string');
  if (before === null && after === null) return null;

  const out: DiffLine[] = [];
  if (before !== null) {
    for (const line of before.split('\n')) out.push({ sign: '-', text: line });
  }
  if (after !== null) {
    for (const line of after.split('\n')) out.push({ sign: '+', text: line });
  }
  return out.length > 0 ? out : null;
}

/** A readable one-liner for whatever a tool was handed. */
function inputSummary(input: unknown): string | null {
  const s = pickString(input, 'command', 'file_path', 'path', 'pattern', 'url', 'prompt');
  if (s) return s;
  if (input === undefined || input === null) return null;
  try {
    const json = JSON.stringify(input);
    return json && json !== '{}' ? json : null;
  } catch {
    return null;
  }
}

// ── components ──────────────────────────────────────────────────────────────

function ToolCall({ block, links }: { block: ToolBlock; links: FileLinks | null }) {
  const diff = useMemo(() => diffFromInput(block.input), [block.input]);
  /*
   * Everything starts collapsed, diffs included (CONTRACT Amendment 25). Diffs used
   * to open themselves on the theory that the changed code is what you came for —
   * true when a turn carries one tool call, wrong on the runs that actually happen,
   * where a dozen edits push the agent's own prose off the screen. Prose stays
   * default-open (Amendment 18); the mechanics fold.
   */
  const [open, setOpen] = useState(false);

  const subject = block.label.slice(block.tool.length).trim() || inputSummary(block.input) || '';
  const body = diff ?? null;
  const detail = body === null ? inputSummary(block.input) : null;
  const canOpen = body !== null || (detail !== null && detail.length > 0);
  // The file this tool read or wrote. Grep and Glob's `path` is a directory to search,
  // not a file, so it isn't one of these.
  const file = pickString(block.input, 'file_path', 'notebook_path');
  const href = file !== null && links !== null ? links.touched(file) : null;

  /*
   * A div, not a button, because the file name is a link and a link can't sit inside a
   * button. The toggle's hit area is stretched over the whole row in CSS, so the row
   * still opens wherever you click it — except on the file name, which opens Files.
   */
  return (
    <div className="ag-tool">
      <div className="ag-tool-h">
        <button
          type="button"
          className="ag-tool-tog"
          onClick={() => canOpen && setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${block.tool} ${subject}`}
        >
          <b>{block.tool.toLowerCase()}</b>
        </button>
        {href !== null ? (
          <a className="ag-tool-subj" href={href} title="Open in Files">
            {subject}
          </a>
        ) : (
          <span className="ag-tool-subj" title={file !== null && links !== null ? OUTSIDE : undefined}>
            {subject}
          </span>
        )}
        {block.added !== null && (
          <span className="ag-tool-nums">
            <span className="ui-pos">+{block.added}</span>{' '}
            <span className="ui-neg">−{block.removed ?? 0}</span>
          </span>
        )}
        {block.created && <span className="ag-tool-new">new</span>}
        {block.summary && block.added === null && (
          <span className={block.ok === false ? 'ag-tool-bad' : 'ag-tool-ok'}>
            {block.summary}
          </span>
        )}
        {block.ok === null && <span className="ag-tool-running">running…</span>}
        <span className="ag-tool-ch">{canOpen ? (open ? '⌃' : '⌄') : ''}</span>
      </div>

      {open && body && (
        <pre className="ag-diff">
          {body.map((l, i) => (
            <span
              key={i}
              className={l.sign === '+' ? 'is-add' : l.sign === '-' ? 'is-del' : undefined}
            >
              {l.sign} {l.text}
            </span>
          ))}
        </pre>
      )}

      {open && !body && detail && <pre className="ag-diff">{detail}</pre>}
    </div>
  );
}

function Ask({ block }: { block: AskBlock }) {
  const answered = block.answered;
  return (
    <div className={`ag-ask${answered ? ' is-answered' : ''}`}>
      <div className="ag-ask-h">
        <span className="ui-lab">
          {block.requestKind === 'question' ? 'Asked you' : 'Permission required'}
        </span>
        <span className="ag-ask-mode">{block.blockMode}</span>
      </div>
      <div className="ag-ask-body">{block.label}</div>
      {answered ? (
        <div className="ag-ask-answer">
          → {DECISION_WORD[answered.type] ?? answered.type} · by {answered.by}
          {answered.note ? ` · ${answered.note}` : ''}
        </div>
      ) : (
        <div className="ag-ask-waiting">waiting for your decision</div>
      )}
    </div>
  );
}

const DECISION_WORD: Record<string, string> = {
  allow_once: 'allowed once',
  allow_always: 'allowed, rule saved',
  allow_edited: 'allowed with edits',
  deny: 'denied',
  answer: 'answered',
  expired: 'expired',
};

function Blocks({ blocks, links }: { blocks: Block[]; links: FileLinks | null }) {
  return (
    <>
      {blocks.map((b) => {
        if (b.kind === 'prose') {
          // Markdown, because that is what agents write. See markdown.tsx for why
          // rendering it here does not contradict the daemon's server-side renderer.
          return (
            <div key={b.key} className="ag-md">
              {renderMarkdown(b.text, links?.named)}
            </div>
          );
        }
        if (b.kind === 'tool') return <ToolCall key={b.key} block={b} links={links} />;
        if (b.kind === 'ask') return <Ask key={b.key} block={b} />;
        return (
          <div key={b.key} className={`ag-note t-${b.tone}`}>
            {b.text}
          </div>
        );
      })}
    </>
  );
}

/** A turn's prose, as the agent wrote it — what a folded reply summarises. */
function proseOf(turn: Turn): string {
  return turn.blocks
    .filter((b): b is ProseBlock => b.kind === 'prose')
    .map((b) => b.text)
    .join('\n\n');
}

/** What a folded reply is carrying besides its prose: `3 tool calls · 1 ask`. */
function carried(turn: Turn): string {
  const tools = turn.blocks.filter((b) => b.kind === 'tool').length;
  const asks = turn.blocks.filter((b) => b.kind === 'ask').length;
  return [
    tools > 0 ? `${tools} tool call${tools === 1 ? '' : 's'}` : '',
    asks > 0 ? `${asks} ask${asks === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One agent turn. Its role label folds it to one line, as a tool call's row does
 * (Amendment 33).
 *
 * DEFAULT OPEN, deliberately. A transcript that hides output you have not read yet is
 * worse than one you have to scroll: the report is the thing you asked for. Folding is
 * for after you have read it, when it is just occupying the screen — so a fold is kept
 * (folds.ts), per agent, and survives a reload.
 *
 * Folded, the turn is its first line of prose and a count; nothing is truncated inside
 * the rendered markdown, so a fold can never cut a code block in half.
 */
function AgentTurn({
  turn,
  agentId,
  role,
  cursor,
  links,
}: {
  turn: Turn;
  agentId: string;
  role: string;
  cursor: boolean;
  links: FileLinks | null;
}) {
  const folds = useFolds();
  const folded = isFolded(folds, agentId, turn.key);
  const prose = useMemo(() => proseOf(turn), [turn]);
  const toggle = (): void => updateFolds((f) => setFold(f, agentId, turn.key, !folded));
  const lines = prose.length > 0 ? lineCount(prose) : 0;
  const extra = carried(turn);

  return (
    <div className={`ag-msg${folded ? ' is-folded' : ''}`} id={`t-${turn.key}`}>
      <button
        type="button"
        className="ag-who ag-who-fold"
        aria-expanded={!folded}
        title={folded ? 'Unfold this reply' : 'Fold this reply to one line'}
        onClick={toggle}
      >
        {role}
        <span className="ag-fold-ch" aria-hidden="true">
          {folded ? '⌄' : '⌃'}
        </span>
      </button>
      <div className="ag-body">
        {folded ? (
          <button type="button" className="ag-folded" onClick={toggle}>
            <span className="ag-folded-line">{foldLine(prose) || extra || 'no text'}</span>
            <span className="ag-folded-n">
              {[lines > 0 ? `${lines} line${lines === 1 ? '' : 's'}` : '', extra]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {cursor && <span className="ag-cursor" />}
          </button>
        ) : (
          <>
            <Blocks blocks={turn.blocks} links={links} />
            {cursor && <span className="ag-cursor" />}
          </>
        )}
      </div>
    </div>
  );
}

/** The replies in a transcript, by key — what "fold all" folds. */
export function replyKeys(turns: readonly Turn[]): string[] {
  return turns.filter((t) => t.who === 'agent').map((t) => t.key);
}

export function Transcript({
  turns,
  agentId,
  role,
  streaming,
  links,
}: {
  /** `buildTranscript`'s answer. The screen builds it, because "fold all" needs the keys too. */
  turns: readonly Turn[];
  agentId: string;
  role: string;
  streaming: boolean;
  /** Where this job's file names link to (F16). Null when there's no job to link into. */
  links: FileLinks | null;
}) {
  if (turns.length === 0) {
    return (
      <div className="ag-trans">
        <p className="ag-none">Nothing in this transcript yet.</p>
      </div>
    );
  }

  return (
    <div className="ag-trans">
      {turns.map((t, i) =>
        t.who === 'you' ? (
          <div key={t.key} className={`ag-msg is-you${t.synthetic ? ' is-auto' : ''}`} id={`t-${t.key}`}>
            <span className="ag-who">{t.synthetic ? 'auto' : 'you'}</span>
            <div className="ag-body">{t.text}</div>
          </div>
        ) : (
          <AgentTurn
            key={t.key}
            turn={t}
            agentId={agentId}
            role={role}
            cursor={streaming && i === turns.length - 1}
            links={links}
          />
        ),
      )}
    </div>
  );
}
