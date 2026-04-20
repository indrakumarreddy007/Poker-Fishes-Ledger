-- ============================================================
-- Multi-tenancy migration -- Phase 3: Row-Level Security
-- ------------------------------------------------------------
-- Prerequisites:
--   Phase 1 (tenancy-phase1-create-tenants-and-backfill.sql)
--   Phase 2 (tenancy-phase2-enforce-not-null-and-unique.sql)
--   have been applied. Every row in the 9 tenant-scoped tables
--   must carry a non-NULL tenant_id and the composite UNIQUE
--   indexes must already exist.
--
-- What this script does:
--   For each of the 9 tenant-scoped tables:
--     1. ENABLE ROW LEVEL SECURITY
--     2. Drop any pre-existing tenant_isolation policy (so the
--        script is idempotent and safe to re-run).
--     3. CREATE POLICY tenant_isolation using the session-level
--        GUC app.current_tenant to restrict visible rows to the
--        caller's tenant.
--
-- The application is responsible for executing
--
--     SET LOCAL app.current_tenant = '<uuid>'
--
-- at the start of every transaction that touches tenant-scoped
-- tables. A connection without that GUC set will see zero rows
-- (the policy predicate compares to NULL::uuid which is never
-- equal) -- this is the defense-in-depth property we want.
--
-- NOTE: the policy uses current_setting(..., true) so a missing
-- GUC returns NULL rather than raising. This keeps connection
-- startup (e.g. pg_dump, migration tools, admin sessions) from
-- blowing up; it just means those sessions will see an empty
-- database until they opt in by setting the GUC or by using a
-- role that bypasses RLS (see "Superuser / BYPASSRLS" below).
--
-- Superuser / BYPASSRLS:
--   Table owners and superusers bypass RLS by default. If the
--   application role is the table owner, RLS will NOT be
--   enforced against it. In that case use FORCE ROW LEVEL
--   SECURITY or run the app under a non-owner role. This script
--   intentionally does NOT apply FORCE; the deploy checklist
--   documents how to flip it when the app role is owner.
--
-- Safety:
--   - Wrapped in a single transaction.
--   - DROP POLICY IF EXISTS is used so re-running is a no-op.
--   - No data is modified; DDL only.
-- ============================================================

BEGIN;

-- players ----------------------------------------------------
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON players;
CREATE POLICY tenant_isolation ON players
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- sessions ---------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- session_results --------------------------------------------
ALTER TABLE session_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON session_results;
CREATE POLICY tenant_isolation ON session_results
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- settlements ------------------------------------------------
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settlements;
CREATE POLICY tenant_isolation ON settlements
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- player_aliases ---------------------------------------------
ALTER TABLE player_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON player_aliases;
CREATE POLICY tenant_isolation ON player_aliases
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- live_users -------------------------------------------------
ALTER TABLE live_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_users;
CREATE POLICY tenant_isolation ON live_users
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- live_sessions ----------------------------------------------
ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_sessions;
CREATE POLICY tenant_isolation ON live_sessions
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- live_session_players ---------------------------------------
ALTER TABLE live_session_players ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_session_players;
CREATE POLICY tenant_isolation ON live_session_players
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- live_buy_ins -----------------------------------------------
ALTER TABLE live_buy_ins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_buy_ins;
CREATE POLICY tenant_isolation ON live_buy_ins
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Validation -------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
  bad TEXT := '';
  rls_enabled BOOLEAN;
  has_policy  BOOLEAN;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'players',
    'sessions',
    'session_results',
    'settlements',
    'player_aliases',
    'live_users',
    'live_sessions',
    'live_session_players',
    'live_buy_ins'
  ]
  LOOP
    SELECT c.relrowsecurity
      INTO rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = tbl;

    SELECT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename  = tbl
         AND policyname = 'tenant_isolation'
    ) INTO has_policy;

    IF rls_enabled IS NULL THEN
      bad := bad || tbl || '(missing) ';
    ELSIF NOT rls_enabled THEN
      bad := bad || tbl || '(rls-off) ';
    ELSIF NOT has_policy THEN
      bad := bad || tbl || '(no-policy) ';
    END IF;
  END LOOP;

  IF bad <> '' THEN
    RAISE EXCEPTION 'tenancy-phase3 validation FAILED -- %', bad;
  END IF;

  RAISE NOTICE 'tenancy-phase3 complete. RLS enabled + tenant_isolation policy on all 9 tables.';
END
$$;

COMMIT;
