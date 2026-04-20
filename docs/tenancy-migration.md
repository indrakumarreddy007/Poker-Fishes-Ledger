# Multi-tenancy migration

## Summary

PR #1 of 6 — adds `tenants` table and nullable `tenant_id` columns; data-preserving.

This phase only adds schema and backfills data. No existing columns are modified,
no data is dropped, and the application continues to work unchanged because every
new `tenant_id` column is nullable. Later phases will:

- Phase 2: flip `tenant_id` to `NOT NULL` and add composite unique indexes
  (e.g. `UNIQUE (tenant_id, name)` on `players`).
- Phases 3 through 6: application wiring (auth -> tenant scoping, API filters,
  admin UI for creating tenants, and finally removing any legacy single-tenant
  assumptions).

### What Phase 1 touches

- Creates table: `tenants (id UUID PK, code TEXT UNIQUE, name TEXT, created_at)`.
  - `name` is intentionally **not** unique — duplicate group display names are
    allowed; `code` is the real identifier.
- Seeds one row: `('OGFISH', 'The Original Group')`.
- Adds nullable `tenant_id UUID REFERENCES tenants(id)` to 9 tables:
  `players`, `sessions`, `session_results`, `settlements`, `player_aliases`,
  `live_users`, `live_sessions`, `live_session_players`, `live_buy_ins`.
- Backfills every existing row in those 9 tables to the `OGFISH` tenant.
- Validates: the final step raises an exception if any `tenant_id` is still
  `NULL` after the backfill.

### Safety properties

- Entire script runs inside `BEGIN; ... COMMIT;` — any failure rolls back.
- Idempotency guard at the top raises if `tenants` already exists, so
  accidental re-runs are a loud error rather than a silent partial apply.
- No `DROP`, `RENAME`, or `TRUNCATE` anywhere in Phase 1.

## How to run

Team-lead executes these steps. Do not run during peak usage.

1. **Snapshot**: in the Neon console, create a branch `pre-tenancy-phase1`
   off the current prod branch. This is the rollback-of-last-resort.

2. **Dry-run** on a Neon preview branch:

   ```sh
   psql $PREVIEW_DATABASE_URL -f scripts/tenancy-phase1-create-tenants-and-backfill.sql
   ```

3. **Verify** the `NOTICE` output from the validation block — it prints the
   row count per table that got backfilled. Confirm those match your
   expected totals (e.g. `SELECT COUNT(*) FROM players;` on the prod
   snapshot should equal the `players` line in the notice).

4. **Run on prod**:

   ```sh
   psql $DATABASE_URL -f scripts/tenancy-phase1-create-tenants-and-backfill.sql
   ```

5. **If anything goes wrong**, roll back:

   ```sh
   psql $DATABASE_URL -f scripts/tenancy-phase1-rollback.sql
   ```

   If prod has already moved past Phase 1 (Phase 2+ applied), do **not**
   use this rollback — restore from the `pre-tenancy-phase1` Neon branch
   instead.

## Files

- `scripts/tenancy-phase1-create-tenants-and-backfill.sql` — forward migration.
- `scripts/tenancy-phase1-rollback.sql` — reverse migration (Phase 1 only).
