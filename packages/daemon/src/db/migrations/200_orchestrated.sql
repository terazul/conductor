-- 200_orchestrated — Track A. Orchestrated stacks (Amendment 128).
--
-- APPEND-ONLY. Once applied, never edited (db/index.ts records it by name).
--
-- `helper_roles` is a JSON array of the roles an orchestrator may start, each as Spawn resolved
-- it at launch (its persona's prompt, its model, its rope: `HelperRole`). NULL for every agent
-- that is not the orchestrator of an orchestrated stack, which is every agent from before. Copied
-- in at launch, not looked up, as a persona's fields are: a stack that is running keeps what it
-- launched with when a persona or a tier changes. Off the wire except the ids (`pipelineRoles`).
--
-- `helper_role` is, on a helper, the listed role it was started as; NULL on any other agent and
-- on a helper started without a role. It is what counts how many times a role has been started,
-- so the limit on sending work back holds across a restart.
ALTER TABLE agents ADD COLUMN helper_roles TEXT;
ALTER TABLE agents ADD COLUMN helper_role TEXT;
