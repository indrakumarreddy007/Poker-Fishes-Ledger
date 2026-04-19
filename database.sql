-- ============================================================
-- POKER LEDGER MERGED - DATABASE SCHEMA
-- ============================================================
-- Fishes tables  : players, player_aliases, sessions,
--                  session_results, settlements
-- Live (Thor) tables : live_users, live_sessions,
--                      live_session_players, live_buy_ins
--
-- Run this once against your Postgres database.
-- Existing data is NOT affected — all Fishes tables use
-- CREATE TABLE IF NOT EXISTS and the live_ tables are new.
-- ============================================================

-- ============================================================
-- FISHES TABLES (existing — untouched)
-- ============================================================

CREATE TABLE IF NOT EXISTS players (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id   SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS session_results (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
  amount     REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id       SERIAL PRIMARY KEY,
  payer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  payee_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount   REAL    NOT NULL,
  date     TEXT    NOT NULL,
  status   TEXT    DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS player_aliases (
  id        SERIAL  PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias     TEXT    UNIQUE NOT NULL
);

-- Back-fill status column for existing deployments
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';

-- ============================================================
-- LIVE (THOR) TABLES — new, prefixed with live_
-- ============================================================

CREATE TABLE IF NOT EXISTS live_users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  username   TEXT        NOT NULL UNIQUE,
  password   TEXT        NOT NULL,
  mobile     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  session_code TEXT        NOT NULL UNIQUE,
  blind_value  TEXT        DEFAULT '10/20',
  created_by   UUID        REFERENCES live_users(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'closed')),
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_session_players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES live_users(id)    ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'player'
                CHECK (role IN ('admin', 'player')),
  final_winnings NUMERIC
);

CREATE TABLE IF NOT EXISTS live_buy_ins (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID        REFERENCES live_sessions(id)       ON DELETE CASCADE,
  user_id    UUID        REFERENCES live_users(id)          ON DELETE CASCADE,
  amount     NUMERIC     NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'rejected')),
  timestamp  TIMESTAMPTZ DEFAULT NOW()
);

-- Publish-to-Fishes flags on live_sessions (back-filled for existing rows via
-- ADD COLUMN IF NOT EXISTS so this is safe to re-run).
ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS published_to_ledger   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS published_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_sessions_code      ON live_sessions(session_code);
CREATE INDEX IF NOT EXISTS idx_live_buy_ins_session    ON live_buy_ins(session_id);
CREATE INDEX IF NOT EXISTS idx_live_sp_session         ON live_session_players(session_id);
CREATE INDEX IF NOT EXISTS idx_live_sp_user            ON live_session_players(user_id);
