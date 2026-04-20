# Multi-tenancy migration — Phases 1 + 2

## Summary

First PR of the multi-tenancy rollout. Combines the original two-step schema
migration into a single deliverable: phase 1 adds the `tenants` table and
nullable `tenant_id` columns with a full backfill; phase 2 flips those
columns to `NOT NULL` and swaps the legacy single-column `UNIQUE`
constraints for composite `(tenant_id, <natural key>)` uniques.

The two phases are shipped as separate scripts — you run phase 1, verify,
then run phase 2 — so the migration is safely interruptible. Later PRs
handle the application wiring (auth → tenant scoping, API filters, admin
UI for tenant creation, removal of remaining single-tenant assumptions).

### Phase 1 — what it touches

- Creates table `tenants (id UUID PK, code TEXT UNIQUE, name TEXT, created_at)`.
  - `name` is intentionally **not** unique — duplicate group display names
    are allowed; `code` is the real identifier.
- Seeds one row: `('OGFISH', 'The Original Group')`.
- Adds nullable `tenant_id UUID REFERENCES tenants(id)` to 9 tables:
  `players`, `sessions`, `session_results`, `settlements`, `player_aliases`,
  `live_users`, `live_sessions`, `live_session_players`, `live_buy_ins`.
- Backfills every existing row in those 9 tables to the `OGFISH` tenant.
- Validates: raises an exception if any `tenant_id` is still `NULL` after
  the backfill.

### Phase 2 — what it touches

Prerequisites: **phase 1 is fully applied and every row in the 9 tables
has a non-NULL `tenant_id`**. Phase 2 starts with a hard guard that
refuses to run if any row still has `tenant_id IS NULL` — the script
aborts loudly rather than failing halfway through.

- `ALTER COLUMN tenant_id SET NOT NULL` on all 9 tenant-scoped tables.
- Drops the legacy single-column `UNIQUE` constraints and adds composite
  uniques in their place:
  - `players.name` → `UNIQUE (tenant_id, name)`
  - `player_aliases.alias` → `UNIQUE (tenant_id, alias)`
  - `live_users.username` → `UNIQUE (tenant_id, LOWER(username))`
    (expression-based, so implemented as `CREATE UNIQUE INDEX`)
  - `live_sessions.session_code` → `UNIQUE (tenant_id, session_code)`
- Uses `DROP CONSTRAINT IF EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS`
  so a partial prior run or a schema with renamed constraints does not
  blow up.
- Validation block emits `RAISE NOTICE` confirming `tenant_id` is
  `NOT NULL` on all 9 tables and lists the new composite unique indexes.

### Safety properties

- Each script runs inside its own `BEGIN; ... COMMIT;` — any failure
  rolls the whole phase back cleanly.
- Phase 1 has an idempotency guard that refuses to re-run once the
  `tenants` table exists.
- Phase 2 has a **hard data-safety guard** that aborts if any
  `tenant_id` is still `NULL`. That guard is independent of idempotency:
  once phase 2 has set all `tenant_id` columns to `NOT NULL`, the guard
  trivially passes and the remaining DDL is idempotent via `IF EXISTS` /
  `IF NOT EXISTS` clauses.
- No `DROP TABLE`, `RENAME`, or `TRUNCATE` anywhere in either phase.

## How to run

Team-lead executes these steps. Do not run during peak usage. Run phase 1,
verify, then run phase 2.

1. **Snapshot**: in the Neon console, create a branch `pre-tenancy-phase1`
   off the current prod branch. This is the rollback-of-last-resort.

2. **Phase 1 dry-run** on a Neon preview branch:

   ```sh
   psql $PREVIEW_DATABASE_URL -f scripts/tenancy-phase1-create-tenants-and-backfill.sql
   ```

3. **Verify** the `NOTICE` output from phase 1's validation block — it
   prints the row count per table that got backfilled. Confirm those
   match your expected totals (e.g. `SELECT COUNT(*) FROM players;` on
   the prod snapshot should equal the `players` line in the notice).

4. **Phase 2 dry-run** on the same preview branch:

   ```sh
   psql $PREVIEW_DATABASE_URL -f scripts/tenancy-phase2-enforce-not-null-and-unique.sql
   ```

   Confirm the `NOTICE` output lists all 9 tables as `NOT NULL` and
   names the four new composite unique indexes. If the script aborts
   with "NULL tenant_id rows still exist", stop and triage — do not
   attempt to bypass the guard.

5. **Phase 1 on prod**:

   ```sh
   psql $DATABASE_URL -f scripts/tenancy-phase1-create-tenants-and-backfill.sql
   ```

6. **Verify prod**: re-check phase 1's notice output and optionally run
   a spot check, e.g.

   ```sql
   SELECT COUNT(*) FROM players              WHERE tenant_id IS NULL;
   SELECT COUNT(*) FROM live_buy_ins         WHERE tenant_id IS NULL;
   ```

   Both must return `0` before proceeding.

7. **Phase 2 on prod**:

   ```sh
   psql $DATABASE_URL -f scripts/tenancy-phase2-enforce-not-null-and-unique.sql
   ```

8. **Smoke test the app**: leaderboard, session history, Live login,
   Live session creation, and publish-to-Fishes all still work.

## Rollback

The two phases have independent rollback scripts. Roll back in reverse
order: phase 2 first, then phase 1.

### Only phase 1 applied

```sh
psql $DATABASE_URL -f scripts/tenancy-phase1-rollback.sql
```

### Both phase 1 and phase 2 applied

```sh
psql $DATABASE_URL -f scripts/tenancy-phase2-rollback.sql
psql $DATABASE_URL -f scripts/tenancy-phase1-rollback.sql
```

The phase 2 rollback drops the composite unique indexes, re-adds the
original single-column `UNIQUE` constraints, and re-allows `NULL` on
every `tenant_id` column — leaving the schema in the state phase 1
left it. The phase 1 rollback then drops every `tenant_id` column and
the `tenants` table.

If the phase 2 rollback fails while re-adding a single-column `UNIQUE`
constraint, the cause is almost always cross-tenant duplicates on the
natural key (e.g. two tenants each have a player named `Alice`).
Dedupe before rolling back, or use the Neon `pre-tenancy-phase1` branch.

If prod has moved past phase 2 into later PRs that depend on
`tenant_id` being `NOT NULL`, do **not** use these rollback scripts —
restore from the `pre-tenancy-phase1` Neon branch instead.

## Files

- `scripts/tenancy-phase1-create-tenants-and-backfill.sql` — phase 1 forward.
- `scripts/tenancy-phase1-rollback.sql` — phase 1 reverse.
- `scripts/tenancy-phase2-enforce-not-null-and-unique.sql` — phase 2 forward.
- `scripts/tenancy-phase2-rollback.sql` — phase 2 reverse.
