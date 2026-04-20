-- ============================================================
-- Multi-tenancy migration -- Phase 3 ROLLBACK
-- ------------------------------------------------------------
-- Drops the tenant_isolation policy on every tenant-scoped
-- table and disables ROW LEVEL SECURITY on each of them.
--
-- Use this ONLY if you need to fully unwind the RLS layer --
-- e.g. because the application is not yet calling
-- SET LOCAL app.current_tenant consistently and the deploy
-- needs to fall back to application-layer tenant filtering.
--
-- Re-running is safe: DROP POLICY IF EXISTS and DISABLE are
-- no-ops when the policy/flag are already absent.
-- ============================================================

BEGIN;

-- Drop policies ----------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON players;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
DROP POLICY IF EXISTS tenant_isolation ON session_results;
DROP POLICY IF EXISTS tenant_isolation ON settlements;
DROP POLICY IF EXISTS tenant_isolation ON player_aliases;
DROP POLICY IF EXISTS tenant_isolation ON live_users;
DROP POLICY IF EXISTS tenant_isolation ON live_sessions;
DROP POLICY IF EXISTS tenant_isolation ON live_session_players;
DROP POLICY IF EXISTS tenant_isolation ON live_buy_ins;

-- Disable row-level security ---------------------------------
ALTER TABLE players              DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             DISABLE ROW LEVEL SECURITY;
ALTER TABLE session_results      DISABLE ROW LEVEL SECURITY;
ALTER TABLE settlements          DISABLE ROW LEVEL SECURITY;
ALTER TABLE player_aliases       DISABLE ROW LEVEL SECURITY;
ALTER TABLE live_users           DISABLE ROW LEVEL SECURITY;
ALTER TABLE live_sessions        DISABLE ROW LEVEL SECURITY;
ALTER TABLE live_session_players DISABLE ROW LEVEL SECURITY;
ALTER TABLE live_buy_ins         DISABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  RAISE NOTICE 'tenancy-phase3 rollback complete. RLS disabled and tenant_isolation policy removed from all 9 tables.';
END
$$;

COMMIT;
