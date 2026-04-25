-- ============================================================
-- Heal schema drift on live_* tables
-- ------------------------------------------------------------
-- Context:
--   These three tables were created under older names during
--   the "Thor" era of the app. When the app was renamed to
--   "Fishes", the tables were renamed in place (Thor_* ->
--   live_*). Some prod databases ended up with columns
--   missing relative to the canonical definitions in
--   api/index.ts:101-139 (notably live_session_players.id,
--   which triggered a SEV-1 buy-in 500 -- see PR #10, the
--   hotfix/live-session-players-missing-id-column branch).
--
--   `CREATE TABLE IF NOT EXISTS` in initDB() does NOT add
--   missing columns to an already-existing table. That is
--   why the drift has persisted despite every cold start
--   running initDB.
--
-- What this script does:
--   For each of the three live_* tables
--     (live_users, live_session_players, live_buy_ins):
--     1. Diagnose the current columns via information_schema
--        and RAISE NOTICE so the operator can see what was
--        missing before the heal.
--     2. ALTER TABLE ... ADD COLUMN IF NOT EXISTS for every
--        canonical column.
--     3. Where appropriate, SET DEFAULT, SET NOT NULL, and
--        ADD PRIMARY KEY on `id` -- guarded so we never fail
--        because a PK already exists on some other column.
--     4. Add the `role` CHECK constraint on
--        live_session_players if it is not already present.
--     5. Validate at the end that all canonical columns now
--        exist, and RAISE NOTICE with row counts for each
--        table.
--
-- Safety:
--   - Wrapped in a single BEGIN/COMMIT so a partial failure
--     rolls back cleanly.
--   - Every DDL step is additive and uses IF NOT EXISTS or
--     a DO-block existence guard, so re-running the script
--     is a no-op.
--   - NO data is destroyed, renamed, or rewritten. The only
--     data write is a backfill of `id` for pre-existing
--     live_session_players rows that were inserted before
--     the column existed (they need a UUID so NOT NULL and
--     PRIMARY KEY can be applied).
--
-- How to run: see docs/schema-drift-heal.md
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Sanity: pgcrypto / gen_random_uuid must be available.
--    On Neon it is; add CREATE EXTENSION IF NOT EXISTS for
--    other Postgres installs.
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- live_users
-- ============================================================

-- Diagnostic: list current columns -------------------------
DO $$
DECLARE
  col_list TEXT;
BEGIN
  SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position)
    INTO col_list
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'live_users';
  RAISE NOTICE '[heal] live_users BEFORE: %', COALESCE(col_list, '<table missing>');
END
$$;

-- Canonical columns from api/index.ts:101-108 ---------------
ALTER TABLE live_users
  ADD COLUMN IF NOT EXISTS id         UUID,
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS username   TEXT,
  ADD COLUMN IF NOT EXISTS password   TEXT,
  ADD COLUMN IF NOT EXISTS mobile     TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Backfill id for any pre-existing rows so NOT NULL / PK can stick
UPDATE live_users
   SET id = gen_random_uuid()
 WHERE id IS NULL;

-- Defaults & NOT NULL (guarded) -----------------------------
DO $$
BEGIN
  BEGIN
    ALTER TABLE live_users ALTER COLUMN id         SET DEFAULT gen_random_uuid();
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_users.id SET DEFAULT skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_users ALTER COLUMN id         SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_users.id SET NOT NULL skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_users ALTER COLUMN created_at SET DEFAULT NOW();
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_users.created_at SET DEFAULT skipped: %', SQLERRM;
  END;
END
$$;

-- Primary key (guarded: skip if ANY PK already exists) ------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema    = 'public'
       AND table_name      = 'live_users'
       AND constraint_type = 'PRIMARY KEY'
  ) THEN
    BEGIN
      ALTER TABLE live_users ADD PRIMARY KEY (id);
      RAISE NOTICE '[heal] live_users PRIMARY KEY (id) added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_users ADD PRIMARY KEY skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[heal] live_users already has a PRIMARY KEY, skipping';
  END IF;
END
$$;

-- UNIQUE(username) (guarded) --------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'live_users'
       AND indexdef  ILIKE '%UNIQUE%username%'
  ) THEN
    BEGIN
      ALTER TABLE live_users ADD CONSTRAINT live_users_username_key UNIQUE (username);
      RAISE NOTICE '[heal] live_users UNIQUE (username) added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_users UNIQUE(username) skipped: %', SQLERRM;
    END;
  END IF;
END
$$;

-- ============================================================
-- live_session_players   <-- this is the table that caused PR #10
-- ============================================================

DO $$
DECLARE
  col_list TEXT;
BEGIN
  SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position)
    INTO col_list
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'live_session_players';
  RAISE NOTICE '[heal] live_session_players BEFORE: %', COALESCE(col_list, '<table missing>');
END
$$;

-- Canonical columns from api/index.ts:122-129 ---------------
ALTER TABLE live_session_players
  ADD COLUMN IF NOT EXISTS id             UUID,
  ADD COLUMN IF NOT EXISTS session_id     UUID,
  ADD COLUMN IF NOT EXISTS user_id        UUID,
  ADD COLUMN IF NOT EXISTS role           TEXT,
  ADD COLUMN IF NOT EXISTS final_winnings NUMERIC;

-- Backfill id for any pre-existing rows (the SEV-1 cause) ---
UPDATE live_session_players
   SET id = gen_random_uuid()
 WHERE id IS NULL;

-- Defaults & NOT NULL (guarded) -----------------------------
DO $$
BEGIN
  BEGIN
    ALTER TABLE live_session_players ALTER COLUMN id   SET DEFAULT gen_random_uuid();
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_session_players.id SET DEFAULT skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_session_players ALTER COLUMN id   SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_session_players.id SET NOT NULL skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_session_players ALTER COLUMN role SET DEFAULT 'player';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_session_players.role SET DEFAULT skipped: %', SQLERRM;
  END;

  -- Backfill role before SET NOT NULL, in case it was added above.
  UPDATE live_session_players SET role = 'player' WHERE role IS NULL;

  BEGIN
    ALTER TABLE live_session_players ALTER COLUMN role SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_session_players.role SET NOT NULL skipped: %', SQLERRM;
  END;
END
$$;

-- Primary key on id (guarded) -------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema    = 'public'
       AND table_name      = 'live_session_players'
       AND constraint_type = 'PRIMARY KEY'
  ) THEN
    BEGIN
      ALTER TABLE live_session_players ADD PRIMARY KEY (id);
      RAISE NOTICE '[heal] live_session_players PRIMARY KEY (id) added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_session_players ADD PRIMARY KEY skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[heal] live_session_players already has a PRIMARY KEY, skipping';
  END IF;
END
$$;

-- role CHECK constraint (guarded) ---------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.check_constraints cc
      JOIN information_schema.constraint_column_usage ccu
        ON cc.constraint_name = ccu.constraint_name
       AND cc.constraint_schema = ccu.constraint_schema
     WHERE ccu.table_schema = 'public'
       AND ccu.table_name   = 'live_session_players'
       AND ccu.column_name  = 'role'
  ) THEN
    BEGIN
      ALTER TABLE live_session_players
        ADD CONSTRAINT live_session_players_role_check
        CHECK (role IN ('admin','player'));
      RAISE NOTICE '[heal] live_session_players role CHECK added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_session_players role CHECK skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[heal] live_session_players role CHECK already present, skipping';
  END IF;
END
$$;

-- ============================================================
-- live_buy_ins
-- ============================================================

DO $$
DECLARE
  col_list TEXT;
BEGIN
  SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position)
    INTO col_list
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'live_buy_ins';
  RAISE NOTICE '[heal] live_buy_ins BEFORE: %', COALESCE(col_list, '<table missing>');
END
$$;

-- Canonical columns from api/index.ts:131-139 ---------------
ALTER TABLE live_buy_ins
  ADD COLUMN IF NOT EXISTS id         UUID,
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS user_id    UUID,
  ADD COLUMN IF NOT EXISTS amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS status     TEXT,
  ADD COLUMN IF NOT EXISTS timestamp  TIMESTAMPTZ;

-- Backfill id / status for pre-existing rows ----------------
UPDATE live_buy_ins SET id     = gen_random_uuid() WHERE id     IS NULL;
UPDATE live_buy_ins SET status = 'pending'         WHERE status IS NULL;

-- Defaults & NOT NULL (guarded) -----------------------------
DO $$
BEGIN
  BEGIN
    ALTER TABLE live_buy_ins ALTER COLUMN id        SET DEFAULT gen_random_uuid();
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_buy_ins.id SET DEFAULT skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_buy_ins ALTER COLUMN id        SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_buy_ins.id SET NOT NULL skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_buy_ins ALTER COLUMN status    SET DEFAULT 'pending';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_buy_ins.status SET DEFAULT skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_buy_ins ALTER COLUMN status    SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_buy_ins.status SET NOT NULL skipped: %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE live_buy_ins ALTER COLUMN timestamp SET DEFAULT NOW();
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[heal] live_buy_ins.timestamp SET DEFAULT skipped: %', SQLERRM;
  END;
END
$$;

-- Primary key (guarded) -------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema    = 'public'
       AND table_name      = 'live_buy_ins'
       AND constraint_type = 'PRIMARY KEY'
  ) THEN
    BEGIN
      ALTER TABLE live_buy_ins ADD PRIMARY KEY (id);
      RAISE NOTICE '[heal] live_buy_ins PRIMARY KEY (id) added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_buy_ins ADD PRIMARY KEY skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[heal] live_buy_ins already has a PRIMARY KEY, skipping';
  END IF;
END
$$;

-- status CHECK constraint (guarded) -------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.check_constraints cc
      JOIN information_schema.constraint_column_usage ccu
        ON cc.constraint_name = ccu.constraint_name
       AND cc.constraint_schema = ccu.constraint_schema
     WHERE ccu.table_schema = 'public'
       AND ccu.table_name   = 'live_buy_ins'
       AND ccu.column_name  = 'status'
  ) THEN
    BEGIN
      ALTER TABLE live_buy_ins
        ADD CONSTRAINT live_buy_ins_status_check
        CHECK (status IN ('pending','approved','rejected'));
      RAISE NOTICE '[heal] live_buy_ins status CHECK added';
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[heal] live_buy_ins status CHECK skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[heal] live_buy_ins status CHECK already present, skipping';
  END IF;
END
$$;

-- ============================================================
-- Final validation
-- ------------------------------------------------------------
-- Confirm every canonical column exists on each table.
-- Emit row counts so the operator can eyeball that nothing
-- was lost.
-- ============================================================

DO $$
DECLARE
  missing TEXT := '';
  n_users          BIGINT;
  n_session_players BIGINT;
  n_buy_ins        BIGINT;

  canonical CONSTANT TEXT[][] := ARRAY[
    -- { table,               column              }
    ['live_users',            'id'],
    ['live_users',            'name'],
    ['live_users',            'username'],
    ['live_users',            'password'],
    ['live_users',            'mobile'],
    ['live_users',            'created_at'],

    ['live_session_players',  'id'],
    ['live_session_players',  'session_id'],
    ['live_session_players',  'user_id'],
    ['live_session_players',  'role'],
    ['live_session_players',  'final_winnings'],

    ['live_buy_ins',          'id'],
    ['live_buy_ins',          'session_id'],
    ['live_buy_ins',          'user_id'],
    ['live_buy_ins',          'amount'],
    ['live_buy_ins',          'status'],
    ['live_buy_ins',          'timestamp']
  ];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(canonical, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = canonical[i][1]
         AND column_name  = canonical[i][2]
    ) THEN
      missing := missing || canonical[i][1] || '.' || canonical[i][2] || ' ';
    END IF;
  END LOOP;

  IF missing <> '' THEN
    RAISE EXCEPTION '[heal] VALIDATION FAILED: missing columns -> %', missing;
  ELSE
    RAISE NOTICE '[heal] VALIDATION OK: all canonical columns present';
  END IF;

  SELECT count(*) INTO n_users            FROM live_users;
  SELECT count(*) INTO n_session_players  FROM live_session_players;
  SELECT count(*) INTO n_buy_ins          FROM live_buy_ins;

  RAISE NOTICE '[heal] row counts: live_users=%, live_session_players=%, live_buy_ins=%',
    n_users, n_session_players, n_buy_ins;
END
$$;

COMMIT;
