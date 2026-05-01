-- ============================================================
-- Multi-tenancy migration — Phase 1 (of 6)
-- ------------------------------------------------------------
-- Non-destructive schema additions:
--   1. Create `tenants` table
--   2. Seed default tenant row (OGFISH / "The Original Group")
--   3. Add NULLABLE `tenant_id UUID REFERENCES tenants(id)` to 9 tables
--   4. Backfill every existing row to OGFISH's tenant_id
--   5. Validate that zero rows remain with NULL tenant_id
--
-- This script does NOT:
--   - Set NOT NULL on tenant_id  (Phase 2)
--   - Add composite unique indexes on (tenant_id, <natural key>)  (Phase 2)
--   - DROP / RENAME / TRUNCATE anything
--
-- Safety:
--   - All statements wrapped in a single transaction.
--   - Idempotency guard at the top refuses to run if `tenants`
--     already exists — re-running is a hard error, not a silent no-op.
--   - Every ADD COLUMN uses IF NOT EXISTS so partial prior runs on
--     individual tables won't blow up (but the tenants guard means
--     a clean re-run is impossible without rollback first).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Idempotency guard — refuse to run if tenants already exists
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'tenants'
  ) THEN
    RAISE EXCEPTION
      'tenancy-phase1 migration has already been applied: `tenants` table exists. '
      'Run scripts/tenancy-phase1-rollback.sql first if you truly want to re-apply.';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 2. Create tenants table
--    NOTE: `name` is intentionally NOT UNIQUE — duplicate group
--    display names are allowed; `code` is the real identifier.
-- ------------------------------------------------------------
CREATE TABLE tenants (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT        UNIQUE NOT NULL,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 3. Seed default tenant
-- ------------------------------------------------------------
INSERT INTO tenants (code, name) VALUES ('OGFISH', 'The Original Group');

-- ------------------------------------------------------------
-- 4. Add nullable tenant_id to every table that needs it
-- ------------------------------------------------------------
ALTER TABLE players              ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE sessions             ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE session_results      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE settlements          ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE player_aliases       ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE live_users           ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE live_sessions        ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE live_session_players ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE live_buy_ins         ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

-- ------------------------------------------------------------
-- 5. Backfill every row to OGFISH
-- ------------------------------------------------------------
UPDATE players              SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE sessions             SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE session_results      SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE settlements          SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE player_aliases       SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE live_users           SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE live_sessions        SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE live_session_players SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;
UPDATE live_buy_ins         SET tenant_id = (SELECT id FROM tenants WHERE code = 'OGFISH') WHERE tenant_id IS NULL;

-- ------------------------------------------------------------
-- 6. Validation — assert zero NULL tenant_ids and summarise
-- ------------------------------------------------------------
DO $$
DECLARE
  c_players              BIGINT;
  c_sessions             BIGINT;
  c_session_results      BIGINT;
  c_settlements          BIGINT;
  c_player_aliases       BIGINT;
  c_live_users           BIGINT;
  c_live_sessions        BIGINT;
  c_live_session_players BIGINT;
  c_live_buy_ins         BIGINT;

  n_players              BIGINT;
  n_sessions             BIGINT;
  n_session_results      BIGINT;
  n_settlements          BIGINT;
  n_player_aliases       BIGINT;
  n_live_users           BIGINT;
  n_live_sessions        BIGINT;
  n_live_session_players BIGINT;
  n_live_buy_ins         BIGINT;
BEGIN
  -- Total rows per table
  SELECT COUNT(*) INTO c_players              FROM players;
  SELECT COUNT(*) INTO c_sessions             FROM sessions;
  SELECT COUNT(*) INTO c_session_results      FROM session_results;
  SELECT COUNT(*) INTO c_settlements          FROM settlements;
  SELECT COUNT(*) INTO c_player_aliases       FROM player_aliases;
  SELECT COUNT(*) INTO c_live_users           FROM live_users;
  SELECT COUNT(*) INTO c_live_sessions        FROM live_sessions;
  SELECT COUNT(*) INTO c_live_session_players FROM live_session_players;
  SELECT COUNT(*) INTO c_live_buy_ins         FROM live_buy_ins;

  -- Remaining NULL tenant_id rows per table (must all be 0)
  SELECT COUNT(*) INTO n_players              FROM players              WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_sessions             FROM sessions             WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_session_results      FROM session_results      WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_settlements          FROM settlements          WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_player_aliases       FROM player_aliases       WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_live_users           FROM live_users           WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_live_sessions        FROM live_sessions        WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_live_session_players FROM live_session_players WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO n_live_buy_ins         FROM live_buy_ins         WHERE tenant_id IS NULL;

  IF   n_players              > 0
    OR n_sessions             > 0
    OR n_session_results      > 0
    OR n_settlements          > 0
    OR n_player_aliases       > 0
    OR n_live_users           > 0
    OR n_live_sessions        > 0
    OR n_live_session_players > 0
    OR n_live_buy_ins         > 0
  THEN
    RAISE EXCEPTION
      'tenancy-phase1 validation FAILED — NULL tenant_id still present. '
      'players=%, sessions=%, session_results=%, settlements=%, player_aliases=%, '
      'live_users=%, live_sessions=%, live_session_players=%, live_buy_ins=%',
      n_players, n_sessions, n_session_results, n_settlements, n_player_aliases,
      n_live_users, n_live_sessions, n_live_session_players, n_live_buy_ins;
  END IF;

  RAISE NOTICE 'tenancy-phase1 backfill complete. Rows updated to OGFISH per table:';
  RAISE NOTICE '  players              : %', c_players;
  RAISE NOTICE '  sessions             : %', c_sessions;
  RAISE NOTICE '  session_results      : %', c_session_results;
  RAISE NOTICE '  settlements          : %', c_settlements;
  RAISE NOTICE '  player_aliases       : %', c_player_aliases;
  RAISE NOTICE '  live_users           : %', c_live_users;
  RAISE NOTICE '  live_sessions        : %', c_live_sessions;
  RAISE NOTICE '  live_session_players : %', c_live_session_players;
  RAISE NOTICE '  live_buy_ins         : %', c_live_buy_ins;
  RAISE NOTICE 'All tenant_id columns nullable; NOT NULL + composite unique indexes land in Phase 2.';
END
$$;

COMMIT;
