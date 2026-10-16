-- ─────────────────────────────────────────────────────────────────────────────
-- 285_bash_by_default — Wave 12, B1. Every agent already launched runs shell unattended (Amendment 175).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- Spawn's "run shell unattended" pill is on by default since Amendment 175, so a new launch has
-- `Bash` in `allowedTools`. This gives it, once, to the agents launched before: it appends `Bash`
-- to `autonomy.allowedTools`, and to `autonomy.allowedTools` of each role in an orchestrator's
-- `helper_roles` (what its helpers will be started with). After this the row is the truth: Bash
-- turned off later stays off, as "ask me", and nothing adds it again.
--
-- A row is touched only when all of these hold:
--   • its JSON is valid and `allowedTools` is an array (a broken row reads as DEFAULT_AUTONOMY,
--     which stays without Bash);
--   • it is not a reading row, as `helperReads` and Spawn's `reads` tell one: its role is not one of
--     READ_ONLY_ROLES (reviewer, debugger, analyst, auditor; for a helper, nor is the listed role it
--     was started as, `helper_role`), and its rope does not deny all four write tools (Edit, Write,
--     MultiEdit, NotebookEdit), which is how a reading persona's row and a helper like
--     `reviewer-q1` are pinned. A reading row keeps its read-only commands (Amendment 148);
--   • `Bash` is not already in `allowedTools`, so nothing is listed twice;
--   • `Bash` is not in `disallowedTools`: a shell denied outright stays denied.
-- `Bash(git push:*)` in `disallowedTools` is left as it is: a deny goes before an allow, so push
-- stays denied wherever "allow git push" was off.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE agents
SET autonomy = json_insert(autonomy, '$.allowedTools[#]', 'Bash')
WHERE json_valid(autonomy)
  AND json_type(autonomy, '$.allowedTools') = 'array'
  AND role NOT IN ('reviewer', 'debugger', 'analyst', 'auditor')
  AND COALESCE(helper_role, '') NOT IN ('reviewer', 'debugger', 'analyst', 'auditor')
  AND (SELECT COUNT(DISTINCT d.value) FROM json_each(autonomy, '$.disallowedTools') d
       WHERE d.value IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')) < 4
  AND NOT EXISTS (SELECT 1 FROM json_each(autonomy, '$.allowedTools') t WHERE t.value = 'Bash')
  AND NOT EXISTS (SELECT 1 FROM json_each(autonomy, '$.disallowedTools') t WHERE t.value = 'Bash');

-- The same rule for each listed role, `r` one element of `helper_roles`, its rope at `$.autonomy`.
-- Every orchestrator's list is written back, in its order; a role the rule doesn't pick is copied
-- as it was.
UPDATE agents
SET helper_roles = (
  SELECT json_group_array(json(
    CASE
      WHEN json_type(r.value, '$.autonomy.allowedTools') = 'array'
        AND COALESCE(json_extract(r.value, '$.id'), '') NOT IN ('reviewer', 'debugger', 'analyst', 'auditor')
        AND (SELECT COUNT(DISTINCT d.value) FROM json_each(r.value, '$.autonomy.disallowedTools') d
             WHERE d.value IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')) < 4
        AND NOT EXISTS (SELECT 1 FROM json_each(r.value, '$.autonomy.allowedTools') t WHERE t.value = 'Bash')
        AND NOT EXISTS (SELECT 1 FROM json_each(r.value, '$.autonomy.disallowedTools') t WHERE t.value = 'Bash')
      THEN json_insert(r.value, '$.autonomy.allowedTools[#]', 'Bash')
      ELSE r.value
    END))
  FROM (SELECT value FROM json_each(agents.helper_roles) ORDER BY key) r
)
WHERE helper_roles IS NOT NULL
  AND json_valid(helper_roles)
  AND json_type(helper_roles) = 'array'
  AND json_array_length(helper_roles) > 0;
