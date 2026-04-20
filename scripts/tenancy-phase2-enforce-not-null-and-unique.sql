-- ============================================================
-- Multi-tenancy migration — Phase 2
-- ------------------------------------------------------------
-- Prerequisites:
--   Phase 1 (scripts/tenancy-phase1-create-tenants-and-backfill.sql)
--   has been applied AND every row in the 9 tenant-scoped tables
--   has a non-NULL tenant_id.
--
-- What this script does:
--   1. Hard-guard: refuse to run if ANY row in ANY of the 9
--      tenant-scoped tables still has tenant_id IS NULL.
--   2. ALTER COLUMN tenant_id SET NOT NULL on all 9 tables.
--   3. Drop the old single-column UNIQUE constraints and replace
--      them with composite (tenant_id, <natural key>) uniques:
--        - players.name                 -> (tenant_id, name)
--        - player_aliases.alias         -> (tenant_id, alias)
--        - live_users.username          -> (tenant_id, LOWER(username))
--        - live_sessions.session_code   -> (tenant_id, session_code)
--   4. Validation block emits RAISE NOTICE confirming all 9
--      tables have NOT NULL tenant_id and lists the new unique
--      indexes.
--
-- Safety:
--   - Wrapped in a single transaction.
--   - Uses DROP CONSTRAINT IF EXISTS so a partial prior run or a
--     schema where the old unique name differs will not blow up.
--   - Uses CREATE UNIQUE INDEX IF NOT EXISTS for the new composite
--     uniques so re-running against an already-migrated schema is
--     a no-op rather than an error.
--   - The hard guard at the top is NOT idempotency — it is a data
--     safety gate. It will still fire even after phase 2 has been
--     applied, because once tenant_id is NOT NULL the guard query
--     trivially returns zero and the script proceeds to the
--     idempotent DDL.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Hard guard: refuse to run if ANY tenant_id is still NULL
-- ------------------------------------------------------------
DO $$
DECLARE
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
      'tenancy-phase2 ABORTED — NULL tenant_id rows still exist. '
      'Re-run phase 1 backfill or triage before applying phase 2. '
      'players=%, sessions=%, session_results=%, settlements=%, player_aliases=%, '
      'live_users=%, live_sessions=%, live_session_players=%, live_buy_ins=%',
      n_players, n_sessions, n_session_results, n_settlements, n_player_aliases,
      n_live_users, n_live_sessions, n_live_session_players, n_live_buy_ins;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 2. Enforce NOT NULL on every tenant_id column
-- ------------------------------------------------------------
ALTER TABLE players              ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sessions             ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE session_results      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE settlements          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE player_aliases       ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_users           ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_sessions        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_session_players ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_buy_ins         ALTER COLUMN tenant_id SET NOT NULL;

-- ------------------------------------------------------------
-- 3. Swap single-column UNIQUE constraints for composite
--    (tenant_id, <natural key>) uniques.
--
--    Default constraint names generated by `column TEXT UNIQUE`
--    in the original CREATE TABLE are used as the drop targets.
--    IF EXISTS keeps the script safe if a schema was created
--    with custom names or already had the constraint removed.
-- ------------------------------------------------------------

-- players.name  ->  (tenant_id, name)
ALTER TABLE players       DROP CONSTRAINT IF EXISTS players_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS players_tenant_name_key
  ON players (tenant_id, name);

-- player_aliases.alias  ->  (tenant_id, alias)
ALTER TABLE player_aliases DROP CONSTRAINT IF EXISTS player_aliases_alias_key;
CREATE UNIQUE INDEX IF NOT EXISTS player_aliases_tenant_alias_key
  ON player_aliases (tenant_id, alias);

-- live_users.username  ->  (tenant_id, LOWER(username))
-- Expression-based uniqueness must use CREATE UNIQUE INDEX, not
-- a table constraint.
ALTER TABLE live_users    DROP CONSTRAINT IF EXISTS live_users_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS live_users_tenant_lower_username_key
  ON live_users (tenant_id, LOWER(username));

-- live_sessions.session_code  ->  (tenant_id, session_code)
ALTER TABLE live_sessions DROP CONSTRAINT IF EXISTS live_sessions_session_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_tenant_session_code_key
  ON live_sessions (tenant_id, session_code);

-- ------------------------------------------------------------
-- 4. Validation — confirm NOT NULL on all 9 tables and list the
--    new composite unique indexes.
-- ------------------------------------------------------------
DO $$
DECLARE
  tbl      TEXT;
  bad      TEXT := '';
  is_null  BOOLEAN;
  idx_name TEXT;
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
    SELECT c.is_nullable = 'YES'
      INTO is_null
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name   = tbl
       AND c.column_name  = 'tenant_id';

    IF is_null IS NULL THEN
      bad := bad || tbl || '(missing) ';
    ELSIF is_null THEN
      bad := bad || tbl || '(nullable) ';
    END IF;
  END LOOP;

  IF bad <> '' THEN
    RAISE EXCEPTION
      'tenancy-phase2 validation FAILED — tenant_id is not NOT NULL on: %',
      bad;
  END IF;

  RAISE NOTICE 'tenancy-phase2 complete. tenant_id is NOT NULL on all 9 tables:';
  RAISE NOTICE '  players, sessions, session_results, settlements, player_aliases,';
  RAISE NOTICE '  live_users, live_sessions, live_session_players, live_buy_ins';
  RAISE NOTICE 'New composite unique indexes:';

  FOR idx_name IN
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'players_tenant_name_key',
         'player_aliases_tenant_alias_key',
         'live_users_tenant_lower_username_key',
         'live_sessions_tenant_session_code_key'
       )
     ORDER BY indexname
  LOOP
    RAISE NOTICE '  %', idx_name;
  END LOOP;
END
$$;

COMMIT;
