-- ============================================================
-- Multi-tenancy migration — Phase 1 ROLLBACK
-- ------------------------------------------------------------
-- Reverses scripts/tenancy-phase1-create-tenants-and-backfill.sql:
--   1. Drops `tenant_id` column from the 9 affected tables
--   2. Drops the `tenants` table
--
-- Safe to run even if phase 1 was only partially applied —
-- every statement uses IF EXISTS. Wrapped in a transaction so
-- the database cannot end up half-rolled-back.
--
-- NOTE: Only use this while Phase 1 is the latest applied
-- migration. Do NOT run after Phase 2 has been applied —
-- Phase 2 adds NOT NULL + composite indexes that depend on
-- tenant_id, and a separate Phase 2 rollback will be needed.
-- ============================================================

BEGIN;

-- 1. Drop tenant_id from every table (reverse order is not
-- strictly required since FKs only point to tenants, but
-- keeping it symmetric with the forward script).
ALTER TABLE live_buy_ins         DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE live_session_players DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE live_sessions        DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE live_users           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE player_aliases       DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE settlements          DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE session_results      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE sessions             DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE players              DROP COLUMN IF EXISTS tenant_id;

-- 2. Drop the tenants table itself.
DROP TABLE IF EXISTS tenants;

COMMIT;
