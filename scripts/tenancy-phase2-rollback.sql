-- ============================================================
-- Multi-tenancy migration — Phase 2 ROLLBACK
-- ------------------------------------------------------------
-- Reverses scripts/tenancy-phase2-enforce-not-null-and-unique.sql:
--   1. Drops the composite unique indexes added by phase 2
--   2. Re-adds the original single-column UNIQUE constraints
--      (players.name, player_aliases.alias, live_users.username,
--       live_sessions.session_code)
--   3. Re-allows NULL on every tenant_id via DROP NOT NULL
--
-- After this script runs the schema is back to the state left by
-- phase 1 (nullable tenant_id, single-column uniques). Phase 1
-- data and the tenants table are NOT touched here — run
-- scripts/tenancy-phase1-rollback.sql afterwards to go all the
-- way back to the pre-tenancy schema.
--
-- Safety:
--   - Wrapped in a single transaction.
--   - Uses IF EXISTS / IF NOT EXISTS guards where possible.
--   - Re-adding a UNIQUE constraint will fail if per-tenant data
--     introduced cross-tenant duplicates on the natural key
--     (e.g. two tenants both have a player named 'Alice'). That
--     failure is intentional — dedupe before rolling back.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Drop composite unique indexes added in phase 2
-- ------------------------------------------------------------
DROP INDEX IF EXISTS players_tenant_name_key;
DROP INDEX IF EXISTS player_aliases_tenant_alias_key;
DROP INDEX IF EXISTS live_users_tenant_lower_username_key;
DROP INDEX IF EXISTS live_sessions_tenant_session_code_key;

-- ------------------------------------------------------------
-- 2. Re-add original single-column UNIQUE constraints
--    (original names restored so downstream tooling referring
--    to them by default name keeps working).
-- ------------------------------------------------------------
ALTER TABLE players
  ADD CONSTRAINT players_name_key UNIQUE (name);

ALTER TABLE player_aliases
  ADD CONSTRAINT player_aliases_alias_key UNIQUE (alias);

ALTER TABLE live_users
  ADD CONSTRAINT live_users_username_key UNIQUE (username);

ALTER TABLE live_sessions
  ADD CONSTRAINT live_sessions_session_code_key UNIQUE (session_code);

-- ------------------------------------------------------------
-- 3. Re-allow NULL on every tenant_id column
-- ------------------------------------------------------------
ALTER TABLE players              ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE sessions             ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE session_results      ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE settlements          ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE player_aliases       ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE live_users           ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE live_sessions        ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE live_session_players ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE live_buy_ins         ALTER COLUMN tenant_id DROP NOT NULL;

COMMIT;
