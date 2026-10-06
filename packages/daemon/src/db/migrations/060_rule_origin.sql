-- 060_rule_origin — Track A. Which agent earned an "allow always" rule (Amendment 48).
--
-- The Settings tab lists rules with who asked. Rows from before this have no agent,
-- and say so. No foreign key: removing the agent keeps the rule, as it always has —
-- the rule belongs to the project.
ALTER TABLE session_rules ADD COLUMN agent_id TEXT;
