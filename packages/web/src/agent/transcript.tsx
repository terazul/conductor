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
 *     screen, which is the thing you were reading. And a turn's whole ACTIVITY, its
 *     tool calls and what it said between them, folds to its latest step, with the
 *     rest a click away (Amendment 193). What it says after its last tool call, once
 *     the turn is over, is its REPLY (`splitTurn`): that stays open, with a **Read it**
 *     box, until you tick it, and then folds to one line (Amendments 18, 33, 193) —
 *     mechanics hide themselves, output waits for you to say you've read it. A turn
 *     Conductor sent ("auto") folds too, and in an orchestrator's transcript starts
 *     folded: its helpers' report is theirs, and its own reply is what you read
 *     (Amendment 164).
 *
 *  3. A BLOCKED ASK STAYS IN THE TRANSCRIPT after it is answered. The pending
 *     queue clears, but "it asked, I chose this" is the most valuable line in
 *     the history and must not vanish with the request.
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { HANDOFF_BY_USER_NOTE, HANDOFF_HELD_NOTE } from '@conductor/shared';
import type {
  BlockMode,
  DecisionSummary,
  Event,
} from '@conductor/shared';
import { counts, countingSource, pickString } from '../shell/describe.js';
import { OUTSIDE, linkablePath, type FileLinks } from './links.js';
import {
  foldLine,
  isFolded,
  lastLine,
  setFold,
  shownFolded,
  toggleFold,
  updateActivityOpen,
  updateFoldState,
  useActivityOpen,
  useFolds,
  useUnfolds,
} from './folds.js';
import { canUntick, isRead, markReply, useReplyAcks, type ReplyAcks } from '../lib/replies.js';
import { lineCount, renderMarkdown } from './markdown.js';
import { fmtStamp, fullStamp } from '../lib/when.js';
import { Chevron, ChevronSpace } from '../shell/chevron.js';
import { cleanHtml, copyRich } from '../lib/clipboard.js';

// ── model ───────────────────────────────────────────────────────────────────

interface ProseBlock {
  kind: 'prose';
  key: string;
  text: string;
  /** When it was said: the reply's time is its last prose's (Amendment 195). */
  ts: string;
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
  /** Its first event's time: when you sent it, or when the agent started on it (Amendment 195). */
  ts: string;
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

  const agentTurn = (seq: number, ts: string): Turn => {
    const last = turns.at(-1);
    if (last && last.who === 'agent') return last;
    const t: Turn = { key: `a${seq}`, who: 'agent', text: '', synthetic: false, blocks: [], ts };
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
          ts: e.ts,
        });
        break;

      case 'text':
        agentTurn(e.seq, e.ts).blocks.push({ kind: 'prose', key: `p${e.seq}`, text: p.text, ts: e.ts });
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
        agentTurn(e.seq, e.ts).blocks.push(block);
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
        agentTurn(e.seq, e.ts).blocks.push(block);
        break;
      }

      case 'resolved': {
        const block = asks.get(p.requestId);
        if (block) block.answered = p.decision;
        break;
      }

      case 'status': {
        const note = statusNote(p.status, prevStatus, p.blockMode, p.error, p.detail);
        if (note) agentTurn(e.seq, e.ts).blocks.push({ ...note, key: `s${e.seq}` });
        prevStatus = p.status;
        break;
      }

      case 'helpers_removed':
        // Your new task cleared the last one's helpers (Amendment 177, of 167).
        agentTurn(e.seq, e.ts).blocks.push({ kind: 'note', key: `h${e.seq}`, text: helpersRemovedNote(p.count, p.names), tone: 'idle' });
        break;

      // usage / todo drive the inspector; worktree, dev_server and console are
      // job-scoped and never reach an agent's stream.
      default:
        break;
    }
  }

  // Drop an agent turn that ended up with nothing to show.
  return turns.filter((t) => t.who === 'you' || t.blocks.length > 0);
}

/** `2 finished helpers removed: developer-api, reviewer-api`. */
export function helpersRemovedNote(count: number, names: readonly string[]): string {
  const what = `${count} finished ${count === 1 ? 'helper' : 'helpers'} removed`;
  return names.length > 0 ? `${what}: ${names.join(', ')}` : what;
}

/** A turn, split into what it did and what it said at the end of it (Amendment 193). */
export interface SplitTurn {
  /** Its tool calls and asks, and what it said and noted up to the last of them. */
  activity: Block[];
  /** What came after its last tool call or ask: its reply, notes included. Empty when it has none. */
  reply: Block[];
  /** The seq of the reply's last prose, which is what ticking it read marks; null without one. */
  replySeq: number | null;
}

/**
 * Where a turn's activity ends and its reply begins. The reply is what follows its last tool
 * call or ask, once the turn is over (`live` false) and only if some of that is prose: a turn
 * that ended on a tool, or that only noted how it ended, has no reply, and everything in a
 * turn still going is activity. Status notes don't end the activity, since every run that
 * finishes notes so after what it said; the daemon's `replySeq` (session/store.ts
 * `markReply`) follows the same rule, so the two name the same reply.
 */
export function splitTurn(turn: Turn, live: boolean): SplitTurn {
  let cut = -1;
  turn.blocks.forEach((b, i) => {
    if (b.kind === 'tool' || b.kind === 'ask') cut = i;
  });
  const tail = turn.blocks.slice(cut + 1);
  const last = live ? undefined : tail.filter((b) => b.kind === 'prose').at(-1);
  if (!last) return { activity: turn.blocks, reply: [], replySeq: null };
  return { activity: turn.blocks.slice(0, cut + 1), reply: tail, replySeq: Number(last.key.slice(1)) };
}

/**
 * The reply turns, by key, that you have ticked read and that you haven't. `streaming` is
 * whether the last turn is still going, as the transcript's cursor says. "Fold all" leaves the
 * unread ones open, and a read one starts folded.
 */
export function replyStates(
  turns: readonly Turn[],
  streaming: boolean,
  agentId: string,
  acks: ReplyAcks,
): { read: string[]; unread: string[] } {
  const read: string[] = [];
  const unread: string[] = [];
  // Not kept yet (no settings, or a daemon before them): replies are as they were, open and foldable.
  if (acks.sinceSeq === null) return { read, unread };
  turns.forEach((t, i) => {
    if (t.who !== 'agent') return;
    const seq = splitTurn(t, streaming && i === turns.length - 1).replySeq;
    if (seq !== null) (isRead(acks, agentId, seq) ? read : unread).push(t.key);
  });
  return { read, unread };
}

/** What folded activity keeps showing besides its latest step: an ask still open, and a need or a failure. */
function pinned(b: Block): boolean {
  return (b.kind === 'ask' && b.answered === null) || (b.kind === 'note' && (b.tone === 'need' || b.tone === 'fail'));
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
    return { kind: 'note', text: `paused — ${error}`, tone: /^(job )?budget/.test(error) ? 'need' : 'idle' };
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
  // `task` is what `start_helper` was asked to do (Amendment 164), rather than its JSON.
  const s = pickString(input, 'command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'task');
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
          {canOpen ? <Chevron open={open} /> : <ChevronSpace />}
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

/**
 * When a turn was said (Amendment 195), at the right of its first line, folded or open: short
 * (`fmtStamp`), with the full time to the second in its title and `dateTime`.
 */
function Stamp({ ts }: { ts: string | null }) {
  if (!ts || !fmtStamp(ts)) return null;
  return (
    <time className="ag-when" dateTime={ts} title={fullStamp(ts)}>
      {fmtStamp(ts)}
    </time>
  );
}

/** When a reply was said: its last prose's time, the one ticking it read marks. */
function replyTs(split: SplitTurn): string | null {
  return split.reply.find((b): b is ProseBlock => b.kind === 'prose' && b.key === `p${split.replySeq}`)?.ts ?? null;
}

/** Prose, as the agent wrote it — what a folded reply summarises. */
function proseOf(blocks: readonly Block[]): string {
  return blocks
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
 * A reply's ⧉ copy (Amendment 201): its prose and nothing of its activity, as the markdown the
 * agent wrote and as HTML with no colour, so it pastes into a black or a white window in that
 * window's colours (agent/replycopy.tsx). Beside its time, outside the body, so it is there
 * folded or open and never beside the Read it box. It says "copied" for a moment, or that it
 * couldn't, as a code block's does (CodeBlock.tsx).
 */
function ReplyCopy({ reply }: { reply: Block[] }) {
  const [said, setSaid] = useState<{ ok: boolean; why?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const say = (next: { ok: boolean; why?: string }): void => {
    setSaid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), next.ok ? 2000 : 4000);
  };
  const copy = (): void => {
    const html = import('./replycopy.js').then((m) => m.replyClipboard(reply).html);
    void copyRich(proseOf(reply), html).then(
      () => say({ ok: true }),
      (err: unknown) => say({ ok: false, why: err instanceof Error ? err.message : String(err) }),
    );
  };
  return (
    <button
      type="button"
      className={`ag-reply-copy${said && !said.ok ? ' is-failed' : ''}`}
      aria-label="Copy this reply"
      title={said && !said.ok ? `Couldn't copy: ${said.why}` : 'Copy the reply, without its colours, to paste anywhere'}
      onClick={copy}
    >
      {said ? (said.ok ? '✓ copied' : "couldn't copy") : '⧉ copy'}
    </button>
  );
}

/**
 * Cmd-C in the transcript (Amendment 201): the selection, `cleanHtml`'d, so what you paste takes
 * the target's colours rather than the theme's that the browser would have inlined. Anything
 * going wrong leaves the browser's own copy to it: this never stops a copy.
 */
function copySelection(e: ClipboardEvent<HTMLDivElement>): void {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    const html = cleanHtml(box.innerHTML);
    const text = sel.toString();
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  } catch {
    // The browser's own copy, colours and all, is better than none.
  }
}

/**
 * A turn's activity (Amendment 193): FOLDED to its latest step, with a toggle for the steps
 * before it. A long run is a screenful of tool rows and asides, and what you look for is where
 * it has got to. Prose that is the latest step shows its last line, which is where it is now.
 *
 * Folded, it still shows an ask waiting for you and a need or a failure, wherever they are:
 * hiding the thing that is stuck on you, under a count, is how it gets missed. Opening it is
 * kept per agent and turn (folds.ts), as a fold is.
 */
function Activity({
  blocks,
  agentId,
  turnKey,
  since,
  links,
}: {
  blocks: Block[];
  agentId: string;
  turnKey: string;
  /** When the turn started, which the toggle's title says: the activity has no time of its own. */
  since: string;
  links: FileLinks | null;
}) {
  const opened = useActivityOpen();
  if (blocks.length < 2) return <Blocks blocks={blocks} links={links} />;
  const open = isFolded(opened, agentId, turnKey);
  const toggle = (): void => updateActivityOpen((f) => setFold(f, agentId, turnKey, !open));
  const earlier = blocks.length - 1;
  const latest = blocks[blocks.length - 1]!;
  const kept = blocks.slice(0, -1).filter(pinned);

  return (
    <div className={`ag-act${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ag-act-tog"
        aria-expanded={open}
        title={`${open ? 'Fold these steps to the latest' : 'Show every step'}${fmtStamp(since) ? `, from ${fmtStamp(since)}` : ''}`}
        onClick={toggle}
      >
        <Chevron open={open} />
        {open ? `hide ${earlier} earlier step${earlier === 1 ? '' : 's'}` : `${earlier} earlier step${earlier === 1 ? '' : 's'}`}
      </button>
      {open ? (
        <Blocks blocks={blocks} links={links} />
      ) : (
        <>
          <Blocks blocks={kept} links={links} />
          {latest.kind === 'prose' ? (
            <div className="ag-act-last">{lastLine(latest.text)}</div>
          ) : (
            <Blocks blocks={[latest]} links={links} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * One agent turn. Its role label folds it to one line, as a tool call's row does
 * (Amendment 33).
 *
 * A REPLY YOU HAVEN'T READ STAYS OPEN (Amendment 193). A transcript that hides output you have
 * not read is worse than one you have to scroll, and people missed what an agent said: so a
 * reply carries a **Read it** box, its label can't fold it until you tick it, and "fold all"
 * leaves it open. Ticked, it folds to one line marked read; it opens again from that line, and
 * unticking it makes it unread again. Only the box marks it: answering it doesn't, since an
 * answer can leave half of what it said unread. A turn without a reply, still going or ended
 * on a tool, starts open and folds as every reply did (Amendment 18); a fold is kept
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
  const unfolds = useUnfolds();
  const acks = useReplyAcks();
  const split = useMemo(() => splitTurn(turn, cursor), [turn, cursor]);
  // Until the acks are kept, a reply is as it was before them: open, foldable, and no box.
  const seq = acks.sinceSeq === null ? null : split.replySeq;
  const unread = seq !== null && !isRead(acks, agentId, seq);
  // A reply you ticked starts folded; one you haven't can't fold.
  const read = seq !== null && !unread;
  const folded = !unread && shownFolded({ folds, unfolds }, agentId, turn.key, read);
  const toggle = (): void => {
    if (!unread) updateFoldState((s) => toggleFold(s, agentId, turn.key, read));
  };
  const tick = (on: boolean): void => {
    if (seq === null) return;
    markReply(agentId, seq, on);
    // Ticked, it folds: back to its default, should you have opened it before.
    if (on) updateFoldState((s) => (isFolded(s.unfolds, agentId, turn.key) ? { ...s, unfolds: setFold(s.unfolds, agentId, turn.key, false) } : s));
  };
  const prose = useMemo(() => proseOf(split.reply.length > 0 ? split.reply : turn.blocks), [split, turn]);
  const lines = prose.length > 0 ? lineCount(prose) : 0;
  const extra = carried(turn);

  return (
    <div className={`ag-msg${folded ? ' is-folded' : ''}${unread ? ' is-unread' : ''}`} id={`t-${turn.key}`}>
      <button
        type="button"
        className="ag-who ag-who-fold"
        aria-expanded={!folded}
        aria-disabled={unread}
        title={unread ? 'Tick Read it first: a reply you haven\'t read stays open' : folded ? 'Unfold this reply' : 'Fold this reply to one line'}
        onClick={toggle}
      >
        <Chevron open={!folded} />
        {role}
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
            {read && <span className="ag-folded-read">✓ read</span>}
            {cursor && <span className="ag-cursor" />}
          </button>
        ) : (
          <>
            <Activity blocks={split.activity} agentId={agentId} turnKey={turn.key} since={turn.ts} links={links} />
            {split.reply.length > 0 && (
              <div className="ag-reply">
                <Blocks blocks={split.reply} links={links} />
              </div>
            )}
            {seq !== null && (
              <label
                className={`ag-ack${read ? ' is-read' : ''}`}
                title={
                  read && !canUntick(acks, seq)
                    ? 'From before replies were ticked, so it counts as read'
                    : read
                      ? 'Untick to mark it unread again'
                      : 'Tick once you have read it: it folds, and its agent stops saying to read'
                }
              >
                <input
                  type="checkbox"
                  checked={read}
                  disabled={read && !canUntick(acks, seq)}
                  onChange={(e) => tick(e.target.checked)}
                />
                {read ? 'read' : 'Read it'}
              </label>
            )}
            {cursor && <span className="ag-cursor" />}
          </>
        )}
      </div>
      {split.replySeq !== null && <ReplyCopy reply={split.reply} />}
      <Stamp ts={replyTs(split)} />
    </div>
  );
}

/**
 * A turn sent to the agent: one you typed, or one Conductor sent ("auto"), such as a helpers'
 * report, a resume nudge or a merge note. Each folds from its label as a reply does (Amendment
 * 164; yours since Amendment 195), to its first line and a count. `startFolded` is whether it
 * starts folded: an auto turn in an orchestrator's transcript, where the helpers' report is long
 * and its own reply to it is what you came for, and a message of yours longer than
 * `YOU_FOLD_LINES`, which you wrote and needn't read again. Anything else starts open, as every
 * reply does (Amendment 18). Its time is when it was sent.
 */
function SentTurn({ turn, agentId, startFolded }: { turn: Turn; agentId: string; startFolded: boolean }) {
  const folds = useFolds();
  const unfolds = useUnfolds();
  const folded = shownFolded({ folds, unfolds }, agentId, turn.key, startFolded);
  const toggle = (): void => updateFoldState((s) => toggleFold(s, agentId, turn.key, startFolded));
  const lines = turn.text.length > 0 ? lineCount(turn.text) : 0;
  const auto = turn.synthetic;
  const what = auto ? 'this turn' : 'your message';

  return (
    <div className={`ag-msg is-you${auto ? ' is-auto' : ''}${folded ? ' is-folded' : ''}`} id={`t-${turn.key}`}>
      <button
        type="button"
        className="ag-who ag-who-fold"
        aria-expanded={!folded}
        title={folded ? `Unfold ${what}` : `Fold ${what} to one line`}
        onClick={toggle}
      >
        <Chevron open={!folded} />
        {auto ? 'auto' : 'you'}
      </button>
      {folded ? (
        <div className="ag-body">
          <button type="button" className="ag-folded" onClick={toggle}>
            <span className="ag-folded-line">{foldLine(turn.text) || 'no text'}</span>
            <span className="ag-folded-n">{lines > 0 ? `${lines} line${lines === 1 ? '' : 's'}` : ''}</span>
          </button>
        </div>
      ) : (
        <div className="ag-body">{turn.text}</div>
      )}
      <Stamp ts={turn.ts} />
    </div>
  );
}

/**
 * The turns that fold, by key — what "fold all" folds: the replies, the turns Conductor sent,
 * and since Amendment 195 your own messages. Every turn, then.
 */
export function replyKeys(turns: readonly Turn[]): string[] {
  return turns.map((t) => t.key);
}

/** A message of yours longer than this starts folded (Amendment 195): you wrote it. */
export const YOU_FOLD_LINES = 3;

/**
 * The turns that start folded (Amendment 164): in an orchestrator's transcript, the ones
 * Conductor sent it. `orchestrator` is whether the agent may start helpers (`helperCap` above
 * 0), which is what a helpers' report is sent to. And in any transcript, a message you typed
 * longer than `YOU_FOLD_LINES` (Amendment 195): what you said is in your head, and what it
 * answered is what you came to read.
 */
export function startFoldedKeys(turns: readonly Turn[], orchestrator: boolean): string[] {
  return turns
    .filter((t) => t.who === 'you' && (t.synthetic ? orchestrator : lineCount(t.text) > YOU_FOLD_LINES))
    .map((t) => t.key);
}

export function Transcript({
  turns,
  agentId,
  role,
  streaming,
  links,
  startFolded = [],
}: {
  /** `buildTranscript`'s answer. The screen builds it, because "fold all" needs the keys too. */
  turns: readonly Turn[];
  agentId: string;
  role: string;
  streaming: boolean;
  /** `startFoldedKeys`: the turns that start folded, which "fold all" needs too. */
  startFolded?: readonly string[];
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
    <div className="ag-trans" onCopy={copySelection}>
      {turns.map((t, i) =>
        t.who === 'you' ? (
          <SentTurn key={t.key} turn={t} agentId={agentId} startFolded={startFolded.includes(t.key)} />
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
