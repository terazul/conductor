/**
 * Track A's endpoints — /api/projects, /api/jobs, /api/agents, /api/requests.
 *
 * Route files are auto-globbed by index.ts, so adding endpoints means adding
 * THIS file and never editing a shared route table (CONTRACT.md §3).
 *
 * This is also where Track A initialises, because index.ts is W0-owned and
 * read-only: the plugin body runs once, after openDb/initEventLog/initHub, which
 * is exactly the window the Arbiter and Supervisor need.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  Agent,
  AgentSpec,
  Autonomy,
  CreateJobRequest,
  CreateProjectRequest,
  DecideRequest,
  Decision,
  EffortLevel,
  Isolation,
  PendingRequest,
  Project,
  SendMessageRequest,
  SetAutonomyRequest,
  SetModelRequest,
  SetModelResponse,
} from '@conductor/shared';
import { HELPERS_MAX, NOTE_MAX, type ProviderInfo } from '@conductor/shared';
import { PROVIDERS, isProvider, type ProviderId } from '../session/backend.js';
import { backendFor, providerRefusal } from '../session/backends/index.js';
import { arbiter, initArbiter } from '../arbiter/index.js';
import { openDb } from '../db/index.js';
import { eventLog } from '../eventlog.js';
import { hub } from '../hub.js';
import { alerts, initAlerts } from '../session/alerts.js';
import { budgetUnitRefusal } from '../session/budget.js';
import { catalog, providerModelRefusal, providerModels, refusal } from '../session/models.js';
import {
  getAgent,
  getAgentProvider,
  getJob,
  getProject,
  listAgents,
  listJobs,
  listProjects,
} from '../session/store.js';
import { deleteNote, deleteRule, getNote, getRule, insertNote, rulesForProject, updateNote } from '../session/store.js';
import { describeRule } from '../session/rules.js';
import {
  BudgetReachedError,
  initSupervisor,
  ProjectBusyError,
  supervisor,
} from '../session/supervisor.js';

const ISOLATIONS: Isolation[] = ['worktree', 'branch', 'in_place'];
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: Autonomy['mode'][] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
  'auto',
];

function fail(reply: FastifyReply, code: number, error: string, detail?: string): FastifyReply {
  return reply.code(code).send(detail ? { error, detail } : { error });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Autonomy arrives from a browser form, so every field is checked. A token cap that isn't
 * a whole positive number is refused rather than dropped, since dropping it would launch
 * an agent with no cap at all (Amendment 77).
 */
function parseAutonomy(raw: unknown): Autonomy {
  const a = asRecord(raw);
  const mode = MODES.includes(a['mode'] as Autonomy['mode'])
    ? (a['mode'] as Autonomy['mode'])
    : 'default';
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const budget = a['budgetUsd'];
  const capTokens = a['budgetTokens'] ?? null;
  if (capTokens !== null && !(typeof capTokens === 'number' && Number.isSafeInteger(capTokens) && capTokens > 0)) {
    throw new Error('budgetTokens is a whole number of tokens, more than 0, or null for no cap');
  }

  // An unknown effort is DROPPED rather than defaulted, so the SDK applies its own
  // default instead of us inventing one that might drift from it.
  const effort = EFFORTS.includes(a['effort'] as EffortLevel)
    ? (a['effort'] as EffortLevel)
    : undefined;

  return {
    mode,
    allowedTools: list(a['allowedTools']),
    disallowedTools: list(a['disallowedTools']),
    budgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : null,
    // Absent when uncapped, so a Claude agent's autonomy is the shape it always was.
    ...(capTokens !== null ? { budgetTokens: capTokens } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Autonomy for an agent on `provider`: parsed, and with its cap in the unit that engine
 * reports — dollars for Claude, tokens for one that can't say what a run cost.
 */
function autonomyFor(provider: ProviderId, raw: unknown): Autonomy {
  const autonomy = parseAutonomy(raw);
  const costUsd = backendFor(provider)?.capabilities.costUsd ?? provider === 'claude';
  const wrongUnit = budgetUnitRefusal(provider, costUsd, autonomy);
  if (wrongUnit) throw new Error(wrongUnit);
  return autonomy;
}

/** Limits on what a persona puts in a spec (Amendment 68). */
const PERSONA_ID = /^[a-z0-9-]{1,60}$/;
const SYSTEM_PROMPT_MAX = 20_000;
const SKILL_MAX = 100;
const SKILLS_MAX = 50;

/**
 * A persona's fields on one spec: refused, not trimmed into shape, since a system prompt
 * cut short or a skill list half-dropped would launch an agent that isn't what was asked
 * for. Empty values are left out, so the agent runs with Claude Code's defaults.
 */
function parsePersona(role: string, e: Record<string, unknown>): Pick<AgentSpec, 'persona' | 'systemPrompt' | 'skills'> {
  const out: Pick<AgentSpec, 'persona' | 'systemPrompt' | 'skills'> = {};
  const persona = e['persona'];
  if (persona !== undefined && persona !== null && persona !== '') {
    if (typeof persona !== 'string' || !PERSONA_ID.test(persona)) {
      throw new Error(`agent ${role}: persona is an id of at most 60 lowercase letters, digits and dashes`);
    }
    out.persona = persona;
  }
  const prompt = e['systemPrompt'];
  if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== 'string') throw new Error(`agent ${role}: systemPrompt must be a string`);
    if (prompt.length > SYSTEM_PROMPT_MAX) {
      throw new Error(`agent ${role}: systemPrompt is at most ${SYSTEM_PROMPT_MAX} characters`);
    }
    if (prompt.trim()) out.systemPrompt = prompt.trim();
  }
  const skills = e['skills'];
  if (skills !== undefined && skills !== null) {
    if (!Array.isArray(skills)) throw new Error(`agent ${role}: skills must be an array of skill names`);
    if (skills.length > SKILLS_MAX) throw new Error(`agent ${role}: at most ${SKILLS_MAX} skills`);
    const names: string[] = [];
    for (const s of skills) {
      if (typeof s !== 'string' || !s.trim() || s.length > SKILL_MAX) {
        throw new Error(`agent ${role}: every skill is a name of 1 to ${SKILL_MAX} characters`);
      }
      if (!names.includes(s.trim())) names.push(s.trim());
    }
    if (names.length > 0) out.skills = names;
  }
  return out;
}

function parseAgentSpecs(raw: unknown): AgentSpec[] {
  if (!Array.isArray(raw)) throw new Error('agents must be an array');
  const specs: AgentSpec[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const e = asRecord(entry);
    const role = typeof e['role'] === 'string' ? e['role'].trim() : '';
    const model = typeof e['model'] === 'string' ? e['model'].trim() : '';
    if (!role) throw new Error('every agent needs a role');
    if (!model) throw new Error(`agent ${role} needs a model`);
    // The engine (Amendment 74): absent is claude, as every spawn before this was.
    const provider = e['provider'] ?? 'claude';
    if (!isProvider(provider)) {
      throw new Error(`agent ${role}: unknown provider ${JSON.stringify(provider)} — one of ${PROVIDERS.join(', ')}`);
    }
    const unavailable = providerRefusal(provider);
    if (unavailable) throw new Error(`agent ${role}: ${unavailable}`);
    // Claude's model list checks Claude's models. Each other provider's is asked for, so it
    // is checked after these, in checkProviderModels (Amendment 78).
    const refused = provider === 'claude' ? refusal(model) : null;
    if (refused) throw new Error(`agent ${role}: ${refused}`);
    if (seen.has(role)) throw new Error(`duplicate role ${role} — roles resolve dependsOn`);
    seen.add(role);
    const helpers = e['helpers'] ?? 0;
    if (typeof helpers !== 'number' || !Number.isInteger(helpers) || helpers < 0 || helpers > HELPERS_MAX) {
      throw new Error(`agent ${role}: helpers is a whole number from 0 to ${HELPERS_MAX}`);
    }
    let autonomy: Autonomy;
    try {
      autonomy = autonomyFor(provider, e['autonomy']);
    } catch (err) {
      throw new Error(`agent ${role}: ${(err as Error).message}`);
    }

    specs.push({
      role,
      model,
      ...(typeof e['brief'] === 'string' && e['brief'].trim() ? { brief: e['brief'].trim() } : {}),
      dependsOnRoles: Array.isArray(e['dependsOnRoles'])
        ? e['dependsOnRoles'].filter((x): x is string => typeof x === 'string')
        : [],
      autonomy,
      ...(helpers > 0 ? { helpers } : {}),
      ...parsePersona(role, e),
      ...(provider !== 'claude' ? { provider } : {}),
    });
  }
  if (specs.length === 0) throw new Error('at least one agent is required');

  // dependsOnRoles must name a sibling, or the agent would never start.
  for (const spec of specs) {
    for (const dep of spec.dependsOnRoles ?? []) {
      if (!seen.has(dep)) throw new Error(`agent ${spec.role} depends on unknown role ${dep}`);
      if (dep === spec.role) throw new Error(`agent ${spec.role} cannot depend on itself`);
    }
  }
  return specs;
}

/**
 * A non-Claude spec's model, against what its provider says it offers (Amendment 78).
 * Apart from parseAgentSpecs because asking is async; run after it, so every other
 * refusal reads as it did. A provider that couldn't be asked refuses nothing.
 */
async function checkProviderModels(specs: AgentSpec[]): Promise<void> {
  for (const spec of specs) {
    if (!spec.provider || spec.provider === 'claude' || !isProvider(spec.provider)) continue;
    const refused = providerModelRefusal(await providerModels(spec.provider, backendFor(spec.provider)), spec.model);
    if (refused) throw new Error(`agent ${spec.role}: ${refused}`);
  }
}

/** Narrow the frozen Decision union coming off the wire. */
function parseDecision(raw: unknown): Decision {
  const d = asRecord(raw);
  switch (d['type']) {
    case 'allow_once':
      return { type: 'allow_once' };
    case 'allow_always':
      return {
        type: 'allow_always',
        suggestions: Array.isArray(d['suggestions'])
          ? (d['suggestions'] as Decision extends { suggestions: infer S } ? S : never)
          : ([] as never),
      };
    case 'allow_edited':
      return { type: 'allow_edited', updatedInput: d['updatedInput'] ?? {} };
    case 'deny':
      return { type: 'deny', message: typeof d['message'] === 'string' ? d['message'] : 'denied' };
    case 'answer': {
      const answers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(asRecord(d['answers']))) {
        if (typeof v === 'string') answers[k] = v;
        else if (Array.isArray(v)) answers[k] = v.filter((x): x is string => typeof x === 'string');
      }
      return {
        type: 'answer',
        answers,
        ...(typeof d['response'] === 'string' ? { response: d['response'] } : {}),
      };
    }
    default:
      throw new Error(`unknown decision type ${String(d['type'])}`);
  }
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // ── Track A init. Runs once, after the W0 bootstrap. ─────────────────────
  const db = openDb();
  initArbiter(db);
  const sup = initSupervisor(db);
  sup.register();
  arbiter().attach(sup);
  // What needs you besides a tool call: failures, budget stops, outages (F10, F13).
  const alertsNow = initAlerts(db);

  // A daemon killed while agents were blocked comes back with requests that
  // claim to be held by a process that no longer exists (PLAN.md §7 I5).
  arbiter().recoverOrphans();
  // Then the agents no request covers: ones left `working` by a hard stop. Order matters —
  // see Supervisor.reconcile.
  sup.reconcile();
  sup.pump();

  app.addHook('onClose', async () => {
    await sup.shutdown();
    alertsNow.stop();
  });

  // ── projects ────────────────────────────────────────────────────────────

  app.get('/api/projects', async (): Promise<{ projects: Project[] }> => ({
    projects: listProjects(db),
  }));

  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as CreateProjectRequest;
    if (!body.path || typeof body.path !== 'string') {
      return fail(reply, 400, 'path is required');
    }
    try {
      if (body.dirs !== undefined && (!Array.isArray(body.dirs) || body.dirs.some((d) => typeof d !== 'string'))) {
        return fail(reply, 400, 'dirs must be a list of paths');
      }
      const { project, existing } = await sup.createProject(body.path, body.name, body.dirs ?? []);
      // 200 for "you already had this", 201 for "made you one" — the status is what
      // lets the UI say which, instead of showing a row the user did not ask for.
      return reply.code(existing ? 200 : 201).send({ project, existing });
    } catch (err) {
      return fail(reply, 400, 'could not add project', String(err));
    }
  });

  /**
   * Edit a project's name and/or path. Bookkeeping only — nothing on disk moves.
   *
   * PATCH rather than PUT: the body is a partial, and a PUT that silently reset
   * the field you left out would be the wrong verb for a two-field form where
   * either can be edited alone.
   *
   * The request body is NOT in `wire.ts`. Per Amendment 2, a body for one form is
   * not a contract between tracks — `Project` itself is unchanged, and freezing a
   * patch shape would mean a W0 edit for every field the form grows.
   */
  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
    const patch: { name?: string; path?: string } = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.path === 'string') patch.path = body.path;
    if (patch.name === undefined && patch.path === undefined) {
      return fail(reply, 400, 'nothing to change', 'send a name, a path, or both');
    }
    try {
      const project = await sup.editProject(req.params.projectId, patch);
      if (!project) return fail(reply, 404, 'no such project');
      return reply.send({ project });
    } catch (err) {
      return fail(reply, 400, 'could not update the project', String(err));
    }
  });

  /**
   * A project's other directories (Amendment 39). Bookkeeping only, both ways: adding
   * one creates nothing, and removing one forgets it without touching a file. Bodies
   * are per-form, so not in wire.ts (Amendment 2); `Project.extraDirs` is the contract.
   */
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/dirs', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return fail(reply, 400, 'path is required');
    }
    try {
      const added = sup.addProjectDir(req.params.projectId, body.path);
      if (!added) return fail(reply, 404, 'no such project');
      return reply.code(added.existing ? 200 : 201).send(added);
    } catch (err) {
      return fail(reply, 400, 'could not add the directory', String(err));
    }
  });

  app.delete<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/projects/:projectId/dirs',
    async (req, reply) => {
      const path = req.query.path;
      if (!path) return fail(reply, 400, 'path is required');
      try {
        const project = sup.removeProjectDir(req.params.projectId, path);
        if (!project) return fail(reply, 404, 'no such project');
        return reply.send({ project });
      } catch (err) {
        return fail(reply, 400, 'could not remove the directory', String(err));
      }
    },
  );

  /**
   * Remove a project from Conductor. Bookkeeping only — no file is touched, and
   * `removed.keptOnDisk` lists the worktrees deliberately left behind so the UI
   * can say so rather than leaving the human to hope.
   *
   * 409, not 400, when an agent is still running: the request is well-formed and
   * will succeed once the conflicting state is gone. The confirmation lives in
   * the UI, and DELETE is the confirmation as far as the daemon is concerned —
   * an endpoint that asked twice would just be a state machine to get wrong.
   */
  /**
   * Your notes on a project (Amendment 55): create, change, delete. Every change sends the
   * project again, notes and all, so every browser's Fleet card shows it.
   */
  const noteText = (raw: unknown): string | null => {
    const t = typeof raw === 'string' ? raw.trim() : '';
    return t && t.length <= NOTE_MAX ? t : null;
  };
  const sendProject = (projectId: string) => {
    const project = getProject(db, projectId)!;
    hub().broadcast({ type: 'entities', projects: [project] });
    // A due note is an alert too (Amendment 63): a change may add or clear one.
    alerts().refresh();
    return project;
  };
  /**
   * A due date: `YYYY-MM-DD`, a real calendar day, or null to clear it. Undefined when the
   * body didn't say, and an Error when it said something that isn't one.
   */
  const noteDue = (raw: unknown): string | null | undefined | Error => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Error('a due date is YYYY-MM-DD');
    const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return new Error(`${raw} is not a day`);
    return raw;
  };
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/notes', async (req, reply) => {
    if (!getProject(db, req.params.projectId)) return fail(reply, 404, 'no such project');
    const body = (req.body ?? {}) as { text?: unknown; due?: unknown };
    const text = noteText(body.text);
    if (!text) return fail(reply, 400, 'a note needs text', `up to ${NOTE_MAX} characters`);
    const due = noteDue(body.due);
    if (due instanceof Error) return fail(reply, 400, 'not a due date', due.message);
    const note = insertNote(db, req.params.projectId, text, due ?? null);
    return reply.code(201).send({ note, project: sendProject(req.params.projectId) });
  });
  app.patch<{ Params: { projectId: string; noteId: string } }>('/api/projects/:projectId/notes/:noteId', async (req, reply) => {
    const note = getNote(db, req.params.noteId);
    if (!note || note.projectId !== req.params.projectId) return fail(reply, 404, 'no such note');
    const body = (req.body ?? {}) as { text?: unknown; due?: unknown; done?: unknown };
    // Each field is changed only when it's sent: a tick sends `done` alone.
    const text = body.text === undefined ? undefined : noteText(body.text);
    if (text === null) return fail(reply, 400, 'a note needs text', `up to ${NOTE_MAX} characters; delete it to remove it`);
    const due = noteDue(body.due);
    if (due instanceof Error) return fail(reply, 400, 'not a due date', due.message);
    if (body.done !== undefined && typeof body.done !== 'boolean') return fail(reply, 400, 'done is true or false');
    if (text === undefined && due === undefined && body.done === undefined) return fail(reply, 400, 'nothing to change', 'send text, due or done');
    const updated = updateNote(db, note.id, {
      ...(text !== undefined ? { text } : {}),
      ...(due !== undefined ? { due } : {}),
      ...(body.done !== undefined ? { done: body.done as boolean } : {}),
    });
    return { note: updated, project: sendProject(note.projectId) };
  });
  app.delete<{ Params: { projectId: string; noteId: string } }>('/api/projects/:projectId/notes/:noteId', async (req, reply) => {
    const note = getNote(db, req.params.noteId);
    if (!note || note.projectId !== req.params.projectId) return fail(reply, 404, 'no such note');
    deleteNote(db, note.id);
    return { project: sendProject(note.projectId) };
  });

  /**
   * A project's "allow always" rules, with who asked and where Claude Code keeps its own
   * copy (Amendment 48).
   */
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/rules', async (req, reply) => {
    if (!getProject(db, req.params.projectId)) return fail(reply, 404, 'no such project');
    return { rules: rulesForProject(db, req.params.projectId).map((r) => describeRule(db, r)) };
  });

  /**
   * Revoke one. Conductor stops allowing it from the next request; a running agent keeps
   * what its session was already given until its next run. Claude Code's copy is only
   * reported — the reply says which file and entry — never edited.
   */
  app.delete<{ Params: { ruleId: string } }>('/api/rules/:ruleId', async (req, reply) => {
    const rule = getRule(db, req.params.ruleId);
    if (!rule) return fail(reply, 404, 'no such rule');
    const view = describeRule(db, rule);
    deleteRule(db, rule.id);
    return { removed: view };
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (req, reply) => {
    const project = getProject(db, req.params.projectId);
    if (!project) return fail(reply, 404, 'no such project');
    try {
      return reply.send({ removed: await sup.deleteProject(project.id) });
    } catch (err) {
      if (err instanceof ProjectBusyError) {
        return fail(reply, 409, 'the project still has agents running', err.message);
      }
      return fail(reply, 500, 'could not remove the project', String(err));
    }
  });

  // ── jobs ────────────────────────────────────────────────────────────────

  app.get('/api/jobs', async () => ({ jobs: listJobs(db) }));

  app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (req, reply) => {
    const job = getJob(db, req.params.jobId);
    if (!job) return fail(reply, 404, 'no such job');
    return reply.send({
      job,
      agents: listAgents(db).filter((a) => a.jobId === job.id),
      events: eventLog().forJob(job.id),
    });
  });

  app.post('/api/jobs', async (req, reply) => {
    const body = asRecord(req.body);
    const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : '';
    const isolation = ISOLATIONS.includes(body['isolation'] as Isolation)
      ? (body['isolation'] as Isolation)
      : 'in_place';

    if (!projectId) return fail(reply, 400, 'projectId is required');
    if (!prompt.trim()) return fail(reply, 400, 'prompt is required');

    let agents: AgentSpec[];
    try {
      agents = parseAgentSpecs(body['agents']);
      await checkProviderModels(agents);
    } catch (err) {
      return fail(reply, 400, 'invalid agents', String(err));
    }

    const budget = body['budgetUsd'];
    const request: CreateJobRequest = {
      projectId,
      prompt,
      isolation,
      agents,
      ...(typeof body['preset'] === 'string' ? { preset: body['preset'] } : {}),
      budgetUsd: typeof budget === 'number' && budget > 0 ? budget : null,
    };

    try {
      return reply.code(201).send(await sup.createJob(request));
    } catch (err) {
      return fail(reply, 400, 'could not create job', String(err));
    }
  });

  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/stop', async (req, reply) => {
    if (!getJob(db, req.params.jobId)) return fail(reply, 404, 'no such job');
    await sup.stopJob(req.params.jobId);
    return reply.send({ ok: true });
  });

  // ── agents ──────────────────────────────────────────────────────────────

  app.get('/api/agents', async (): Promise<{ agents: Agent[] }> => ({ agents: listAgents(db) }));

  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId', async (req, reply) => {
    const agent = getAgent(db, req.params.agentId);
    if (!agent) return fail(reply, 404, 'no such agent');
    return reply.send({
      agent,
      autonomy: agent.autonomy,
      events: eventLog().forAgent(agent.id),
    });
  });

  /** Transcript backfill for a deep link, before the feed takes over. */
  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/events', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    return reply.send({ events: eventLog().forAgent(req.params.agentId) });
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/message', async (req, reply) => {
    const body = (req.body ?? {}) as SendMessageRequest;
    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
      return fail(reply, 400, 'text is required');
    }
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    try {
      const result = sup.sendMessage(req.params.agentId, body.text.trim(), body.synthetic === true);
      return reply.send({ ok: true, delivery: result });
    } catch (err) {
      // A budget refusal's message is the sentence to show, so it goes out bare.
      const detail = err instanceof BudgetReachedError ? err.message : String(err);
      return fail(reply, 409, 'could not deliver message', detail);
    }
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/interrupt', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    await sup.interrupt(req.params.agentId);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/pause', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    await sup.pauseAgent(req.params.agentId);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/resume', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    try {
      sup.resumeAgent(req.params.agentId);
    } catch (err) {
      if (err instanceof BudgetReachedError) return fail(reply, 409, 'at its budget', err.message);
      throw err;
    }
    return reply.send({ ok: true });
  });

  /*
   * Terminate. Deliberately a sibling of interrupt and pause rather than a DELETE:
   * nothing is deleted. The agent, its transcript and its spend all stay, and so does
   * every file it wrote — the agent just stops, permanently.
   */
  app.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/terminate',
    async (req, reply) => {
      if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
      try {
        return reply.send({ agent: await sup.terminateAgent(req.params.agentId) });
      } catch (err) {
        return fail(reply, 500, 'could not terminate the agent', String(err));
      }
    },
  );

  /*
   * Remove, as opposed to terminate. A DELETE this time, because something really is
   * deleted: the agent row and — via ON DELETE CASCADE — its requests and run history.
   * The event log and the day's spend survive, and so does every file it wrote.
   */
  app.delete<{ Params: { agentId: string } }>('/api/agents/:agentId', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');
    try {
      await sup.deleteAgent(req.params.agentId);
      return reply.send({ removed: req.params.agentId });
    } catch (err) {
      return fail(reply, 500, 'could not remove the agent', String(err));
    }
  });

  app.delete<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (req, reply) => {
    if (!getJob(db, req.params.jobId)) return fail(reply, 404, 'no such job');
    try {
      await sup.deleteJob(req.params.jobId);
      return reply.send({ removed: req.params.jobId });
    } catch (err) {
      return fail(reply, 500, 'could not remove the job', String(err));
    }
  });

  /** Terminate every agent in a job that has not already ended. */
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/terminate', async (req, reply) => {
    if (!getJob(db, req.params.jobId)) return fail(reply, 404, 'no such job');
    try {
      return reply.send({ agents: await sup.terminateJob(req.params.jobId) });
    } catch (err) {
      return fail(reply, 500, 'could not terminate the job', String(err));
    }
  });

  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/autonomy', async (req, reply) => {
    const agent = getAgent(db, req.params.agentId);
    if (!agent) return fail(reply, 404, 'no such agent');

    const body = (req.body ?? {}) as SetAutonomyRequest;
    let next: Autonomy;
    try {
      next = autonomyFor(getAgentProvider(db, agent.id), { ...agent.autonomy, ...asRecord(body.autonomy) });
    } catch (err) {
      return fail(reply, 400, 'invalid autonomy', (err as Error).message);
    }
    // Through the supervisor, which broadcasts it. Writing the row alone left every
    // other tab — and this tab's inspector — showing the old budget and pills.
    sup.setAutonomy(agent.id, next);

    // Takes effect on the agent's next run: permissionMode and the tool lists
    // are query() options, fixed for the life of one query.
    return reply.send({ autonomy: next, appliesTo: 'next run' });
  });

  /*
   * What an agent can be given (Amendment 40): the gateway's served models, named the
   * way Claude Code names them. `?fresh=1` asks again instead of using the ten-minute
   * cache — the picker's refresh, for when a model has just been added or retired.
   */
  /** Every engine, whether it can launch agents now, and what it can do (Amendment 74). */
  app.get('/api/providers', async (): Promise<{ providers: ProviderInfo[] }> => ({
    providers: PROVIDERS.map((id) => {
      const f = backendFor(id);
      return {
        id,
        unavailable: providerRefusal(id),
        capabilities: f?.capabilities ?? { defer: false, resume: false, costUsd: false, effort: false, planMode: false, helperTools: false },
      };
    }),
  }));

  /*
   * `?provider=` (Amendment 78): none, or `claude`, is the catalog exactly as it was. Any
   * other provider answers a ProviderModelList — empty with a note, never a 500, when it
   * isn't built or couldn't be asked.
   */
  app.get<{ Querystring: { fresh?: string; provider?: string } }>('/api/models', async (req, reply) => {
    const fresh = req.query.fresh === '1';
    const provider = req.query.provider || 'claude';
    if (!isProvider(provider)) {
      return fail(reply, 400, 'unknown provider', `${JSON.stringify(provider)} — one of ${PROVIDERS.join(', ')}`);
    }
    return provider === 'claude' ? catalog(fresh) : providerModels(provider, backendFor(provider), fresh);
  });

  /*
   * Unlike autonomy, a model change can reach a LIVE run: streaming input makes
   * `Query.setModel()` available, so `appliesTo` is 'now' when there is one to change.
   * Only an exact id is accepted, and when the gateway has said what it serves, only
   * one of those — so a typo or a retired model cannot become a run that fails on its
   * first turn.
   */
  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/model', async (req, reply) => {
    if (!getAgent(db, req.params.agentId)) return fail(reply, 404, 'no such agent');

    // Checked against the list of the engine it runs on, which never changes (Amendment 78).
    const provider = getAgentProvider(db, req.params.agentId);
    const raw = asRecord(req.body as SetModelRequest | undefined)['model'];
    const model = typeof raw === 'string' ? raw.trim() : '';
    if (!model) {
      const from = provider === 'claude' ? 'GET /api/models' : `GET /api/models?provider=${provider}`;
      return fail(reply, 400, 'unknown model', `no model was given — pick one from ${from}.`);
    }
    const refused = provider === 'claude'
      ? refusal(model)
      : providerModelRefusal(await providerModels(provider, backendFor(provider)), model);
    if (refused) return fail(reply, 400, 'unknown model', refused);

    try {
      const appliesTo = await sup.setModel(req.params.agentId, model);
      const res: SetModelResponse = { model, appliesTo };
      return reply.send(res);
    } catch (err) {
      return fail(reply, 409, 'could not switch the model', String(err));
    }
  });

  // ── requests (the attention queue) ──────────────────────────────────────

  /**
   * Put an alert away (F13). Stored, so it stays away after a reload and a restart; an
   * alert's id names one occurrence, so the next failure of the same agent still shows.
   */
  app.post<{ Params: { id: string } }>('/api/alerts/:id/dismiss', async (req, reply) => {
    if (!alerts().dismiss(req.params.id)) {
      return fail(reply, 404, 'no such alert', 'it may have cleared on its own');
    }
    return reply.code(204).send();
  });

  app.get('/api/requests', async (): Promise<{ pending: PendingRequest[] }> => ({
    pending: arbiter().pending(),
  }));

  app.post<{ Params: { requestId: string } }>(
    '/api/requests/:requestId/decide',
    async (req, reply) => {
      const body = (req.body ?? {}) as DecideRequest;

      let decision: Decision;
      try {
        decision = parseDecision(body.decision);
      } catch (err) {
        return fail(reply, 400, 'invalid decision', String(err));
      }

      // `defer` drops updatedInput, so "edit & run" is only honest on the held
      // path. Refusing here beats silently running the unedited command.
      const pending = arbiter()
        .pending()
        .find((p) => p.requestId === req.params.requestId);
      if (pending && pending.blockMode === 'parked' && decision.type === 'allow_edited') {
        return fail(
          reply,
          409,
          'allow_edited is not available for a parked request',
          'the SDK drops updatedInput on the resume path — deny it and reissue instead',
        );
      }

      try {
        arbiter().decide(req.params.requestId, decision);
        return reply.send({ ok: true });
      } catch (err) {
        return fail(reply, 409, 'could not apply decision', String(err));
      }
    },
  );

  app.log.info('Track A session engine ready');
}
