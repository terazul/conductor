# Plan: all notes, the reply box's project / agent bar, and easier repeating (Amendments 214-216)

**Status:** planned 12 Nov 2026 against `main` at `e25c86d`, on branch `notes-repeat`. Asked 12 Nov:

> 1) provide a way to view all the notes that were typed on various agents
> 2) above the text window for my reply, add the "project/agent" at the top in the menu bar
> 3) make it easier to schedule recurring tasks, and also provide a way to view the recurring tasks
>    without having to go into each project

Answers (AskUserQuestion, 12 Nov):
- **Notes:** tag new notes with the agent whose screen they were typed on; filter by project or agent.
- **Where:** two new top-bar screens, **Notes** and **Repeating**.
- **Easier scheduling:** all of these:
  - **Repeat a job you ran**;
  - a **quick form** on Repeating;
  - **▶ run now** and **edit** on each schedule;
  - and, in the user's words, *"for an existing agent, like the SCHEDULE button, but REPEATING, and
    that text gets repeated to that agent as requested"*.
- **Reply box:** a bar across the top of the box reading **project / agent**.

## 0. Rules (as every lane before)

- Write the amendments at the top of `CONTRACT.md`: 214 notes, 215 the reply bar, 216 repeating.
  Also write them up in `docs/MANUAL.md` and tick an entry under TODO.md "Right now" for each.
- Checks:
  - daemon: `packages/daemon/src/session/verify.ts`, new sections after the top one (§40 today);
  - web: `packages/web/src/lib/verify.ts`, new sections after §59.
- `make test` must be green: all 31 lines.
- Migrations: **370** is lane 1's and **380** is lane 3's. They are append-only; never edit 360 or
  earlier.
- Colours come only from the tokens in `packages/shared/src/tokens.css`. Text must clear 4.5:1 in both
  themes, using the contrast helper the web checks already use.
- Commit on `notes-repeat`, with the message ending
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The orchestrator merges.
- Don't touch `~/.conductor`, the daemon on 7777 or the web on 5173, and never restart them.

## 1. Lane 1, all notes (Amendment 214, migration 370)

**Today:**
- A note is a project's: the `project_notes` table (`packages/daemon/src/db/migrations/080_notes.sql`),
  `ProjectNote` (`packages/shared/src/wire.ts:66`), and `Project.notes` (`wire.ts:43`), so every page
  already has every project's notes.
- The routes are POST, PATCH and DELETE `/api/projects/:projectId/notes[/:noteId]`
  (`packages/daemon/src/routes/session.ts:634-662`).
- `NotesPanel({ project })` (`packages/web/src/fleet/Notes.tsx:242`) shows them in three places:
  - the Fleet card (`fleet/card.tsx:848`);
  - the Project screen (`fleet/project.tsx:439`);
  - the Agent inspector (`agent/inspector.tsx:138`).

**Build:**
1. **Migration `370_note_agent.sql`.** Add `ALTER TABLE project_notes ADD COLUMN agent_id TEXT` and
   `agent_label TEXT`. There is no foreign key: a note outlives its agent, so `agent_label` keeps the
   agent's role as it read when the note was made (e.g. `developer`), so it still reads after the
   agent is removed. Existing notes get NULL, meaning no agent.
2. **Wire.** `ProjectNote` gains `agentId?: string` and `agentLabel?: string`. POST notes takes an
   optional `agentId`. The daemon refuses it with 400 unless that agent belongs to that project, and
   fills `agent_label` from the agent's role. PATCH never changes either field.
3. **Web.** `NotesPanel` gains an optional `agentId` prop:
   - the inspector passes its agent's id; the Fleet card and the Project screen pass none;
   - `addNote` (`fleet/endpoints.ts:75`) sends it;
   - a note row with an agent shows a small tag, **developer**, that opens that agent (or reads
     *removed* when the agent is gone).
4. **The Notes screen.** New directory `packages/web/src/notes/` with `route.tsx` exporting
   `screen: { id: 'notes', label: 'Notes', order: 82, ... }`. Give it the hotkey `n` only if no other
   key handler uses `n`; grep for it, and say what you found. Add the row to the reserved table in
   `lib/screens.ts`'s comment.
   - **What it lists:** every project's notes, read from the store's projects, grouped by project.
     Each group header carries the project's colour bar (`useProjectColor` / `projClass`,
     `lib/projectColor.ts`) and opens the project.
   - **Filters:** a project picker, an agent picker (agents that have notes), *open / done / all*
     (open by default), and a text search.
   - **Order:** late first, then due today, then newest.
   - **Rows:** the same row as `NotesPanel`'s, with copy, edit, tick done, delete and the due badge.
     Factor the row out of `Notes.tsx`; don't copy it.
   - **Elsewhere:** the navigator's or the header's existing links are not required. The tab is
     enough.
5. **Checks** (web verify, new section; daemon verify, new section):
   - migration 370 on an old database: old notes have no agent;
   - POST with an agent of another project is refused;
   - the label survives removing the agent;
   - the screen's grouping, filtering and order are pure functions, so test them as such;
   - the inspector passes `agentId`.

## 2. Lane 2, project / agent above the reply box (Amendment 215)

**Today:**
- The message box is `.ag-cbox` in `packages/web/src/agent/composer.tsx:541`. It holds the textarea,
  then the `.ag-crow` row (the **agent** fold, guardrails, ⏎ new line, ⏲ later, send).
- Amendment 212 edged it in the project's colour (`boxColor`, `.ag-cbox.has-proj` in
  `agent/agent.css`).

**Build:**
- Put a header strip inside `.ag-cbox`, above the textarea, reading **project name / agent role**.
  - Add the job name, if the job has one, in the quieter ink: `conductor / developer · Nightly tests`.
  - The strip is tinted with the project's colour, e.g.
    `color-mix(in srgb, var(--proj) 18%, var(--panel))` or whatever panel token the box uses, and its
    text is `--ink`.
  - Check every `--proj-*` in both themes for 4.5:1, and pick a tint that passes them all.
  - With no project colour, use a plain strip in the box's own colours.
- The project name opens the project, and the agent role is plain text.
- The strip doesn't scroll away; it is part of the box.
- **Checks:** a web verify section covering the strip's words, the tint passing 4.5:1 for all eight
  colours in both themes, and the no-colour case.

## 3. Lane 3, easier repeating (Amendment 216, migration 380)

**Today (Amendment 211):**
- The table `recurring_jobs` (`packages/daemon/src/db/migrations/360_recurring_jobs.sql`) holds a saved
  `CreateJobRequest` in `request` plus a rule (`Every`, `packages/shared/src/wire.ts:1056`, rules in
  `packages/shared/src/recurring.ts`).
- The Scheduler's tick (`packages/daemon/src/session/schedule.ts:318`) calls `runDueRecurring`
  (`packages/daemon/src/session/recurring.ts`). That claims the run, re-checks the request with
  `parseCreateJob`, and launches a new job, skipping while the last run's job is still going.
- Routes are GET, POST, PATCH and DELETE `/api/recurring` (`packages/daemon/src/routes/recurring.ts`).
  PATCH today changes `paused` and `nextAt`, the latter for "edit time".
- In the web:
  - Spawn's **repeat…** (`packages/web/src/spawn/repeat.tsx`) saves one;
  - each project's **Repeating** list (`packages/web/src/fleet/repeating.tsx`, under the Project
    screen's notes) lists them;
  - `shell/RuleFields.tsx` is the rule editor.
- One-off scheduled messages (Amendment 111, ⏲ later) live in `scheduled_messages` and are sent by
  the same tick through `Supervisor.sendMessage` (`schedule.ts:302-314`). They are shown above the box
  by `ScheduledList` (`packages/web/src/agent/scheduled.tsx`).
- **A job does not keep its launch request.** `jobs` has prompt, isolation, branch, name and
  recurring_id (`session/store.ts:404`), not the `CreateJobRequest`.

**Decision:** one idea, **Repeating**, with two kinds of schedule, in the one table, so the screen,
pause, run now, edit and last result are shared:
- **a new job**, as now;
- **a message to an agent**: the text sent to an existing agent on the rule, exactly as if you had
  pressed send then (`sendMessage`). It goes into a live run, or resumes a finished one, as ⏲ later
  does.

**Build:**
1. **Migration `380_recurring_more.sql`:**
   - `ALTER TABLE recurring_jobs ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`
     (default NULL, so the ALTER is allowed). Removing the agent removes its repeating messages.
   - `ALTER TABLE recurring_jobs ADD COLUMN text TEXT`.
   - A message row has `agent_id` and `text` set, `request = ''`, and `project_id` = the agent's
     project.
   - `ALTER TABLE jobs ADD COLUMN request TEXT`: the single-stack `CreateJobRequest` a job was
     launched from, as `parseCreateJob` normalised it. It is written at job creation from now on, for
     Spawn launches and recurring runs alike. Old jobs have NULL.
   - Say in the file's header what each means.
2. **Shared.**
   - `RecurringJob` gains `kind: 'job' | 'message'`. `request` becomes present only for `'job'`.
     `agentId` and `text` are present only for `'message'`.
   - `CreateRecurringRequest` takes one of:
     - `{ name, every, request }`, as now;
     - `{ name, every, fromJobId, prompt? }`: copy that job's stored request, its prompt replaced if
       given;
     - `{ name, every, agentId, text }`.
   - `PatchRecurringRequest` adds `name`, `every`, `text` (a message), and `prompt` (a job, which
     replaces `request.prompt` and is re-checked by `parseCreateJob`).
   - `Job` (wire) gains `repeatable?: true` when it has a stored request.
3. **Daemon.**
   - `runDueRecurring` branches on kind. A message calls `sup.sendMessage(agentId, text)` and records
     `last_result` as `sent`, or `failed: <why>`. "cannot receive messages yet" is retried at the next
     tick, as `schedule.ts:310` does. There is no skip rule for messages.
   - Missed times while the daemon was down send once, as jobs do.
   - Nothing is sent while everything is paused: it stays due.
   - Add `POST /api/recurring/:id/run`: run it once now, either kind. It sets `last_*` and leaves
     `next_at` alone. A job still skips while its last run goes, and says so.
   - The POST and PATCH checks:
     - the agent exists, and its text isn't empty or longer than `SCHEDULED_TEXT_MAX`;
     - the job named by `fromJobId` has a stored request; if not, refuse with 400 and *"this job
       was launched before Conductor kept its setup; set it up in Spawn and use repeat…"*;
     - the existing waitForInstructions and empty-prompt refusals still apply.
   - Broadcast the recurring frame as today.
4. **Web.**
   - **The Repeating screen.** New directory `packages/web/src/repeating/` with `route.tsx`:
     `{ id: 'repeating', label: 'Repeating', order: 84 }`, with the hotkey `r` only if free (say what
     you found). Add it to the reserved table.
     - It lists every schedule across projects, grouped by project with its colour bar.
     - Each row shows:
       - its name;
       - its kind (**⟳ job** or **⟳ message to developer**);
       - the rule in words, and the next time;
       - the last result, with a link to its job or agent;
       - **▶ run now**, **❚❚ pause / ▶ resume**, **edit** and **✕ cancel**.
     - **edit** opens the name, the rule (`RuleFields`), and the prompt or the text in place.
     - Reuse `fleet/repeating.tsx`'s row: extend it, don't copy it. The Project screen's list keeps
       working, with the new buttons too.
   - **+ new** on the Repeating screen offers two kinds:
     - **A message to an agent:** pick a project, then an agent, write the text, set the rule.
     - **A job like one you ran:** pick a project, then one of its repeatable jobs, newest first.
       The prompt is prefilled and editable; set the rule.
     - It also links **set up a new launch in Spawn** (opens Spawn; its **repeat…** is there).
   - **⟳ repeat… beside ⏲ later** in the composer (`agent/composer.tsx`). It reads the box's text and
     opens the name and rule (the name defaults to the text's first line) and saves a message
     schedule for this agent. The text box clears once it is saved, as ⏲ later's does.
     `ScheduledList` above the box also shows this agent's repeating messages, as one line each with
     **⟳ every weekday at 09:00**, a pause and a cancel.
   - **⟳ repeat… on a job.** Put it on the job's group header on the Project screen and in the Fleet
     card's job menu, wherever the job's other actions are. Enabled when `job.repeatable`; otherwise
     disabled, with the refusal above as its title. It saves `fromJobId`.
5. **Checks:**
   - daemon:
     - migration 380 on a 360 database;
     - a message schedule sends on its rule, and records sent or failed;
     - it is removed with its agent;
     - run now, for either kind;
     - `fromJobId` copies the stored request, with the prompt replaced, and an old job is refused;
     - PATCH of text, prompt, name and every, re-checked;
     - a new job stores its request;
   - web: the screen's grouping, row words, **+ new**'s two forms, the composer's ⟳ repeat…, the job
     button's enabled and disabled states, and tokens only.

## 4. Order

The developer does lanes 1 and 2, the reviewer reviews them, and fixes follow. Then the developer
does lane 3, then review and fixes again. Then `make test`, the merge, and the user's `make restart`.
