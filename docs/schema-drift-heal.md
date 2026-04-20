# Schema Drift Heal — `live_*` tables

## Background

The three tables that back the Live (in-session) feature —
`live_users`, `live_session_players`, and `live_buy_ins` —
were originally created under the "Thor" codename. When the
app was renamed to "Fishes", the tables were renamed in place
(`Thor_*` -> `live_*`). Some prod databases came out of that
rename with columns missing relative to the canonical
`CREATE TABLE` statements in `api/index.ts:101-139`.

The drift is silent because `initDB()` uses
`CREATE TABLE IF NOT EXISTS`, which does **not** add missing
columns to an already-existing table. Every cold start reports
"schema verified" while the table is in fact broken.

### How we found out

PR #10 (branch `hotfix/live-session-players-missing-id-column`)
was a SEV-1 hotfix: `POST /api/live/session/buyin` was 500ing
with

```
error: column "id" does not exist (42703)
```

at the presence-check query in the buy-in handler. The hotfix
swapped `SELECT id` for `SELECT 1 AS existing` to tolerate the
missing column. That unblocked users, but the underlying
schema drift remained — any other query that touches `id` (or
other drifted columns on the other two tables) would fail the
same way.

This runbook covers the additive heal migration that restores
the canonical schema.

## What the heal script does

File: [`scripts/heal-live-schema-drift.sql`](../scripts/heal-live-schema-drift.sql).

Wrapped in a single `BEGIN; ... COMMIT;`. For each of the
three tables:

1. **Diagnostic.** A `DO` block selects from
   `information_schema.columns` and `RAISE NOTICE`s the
   current column list, so the operator can see the "before"
   state in the psql output.
2. **Additive column adds.** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   for every canonical column listed in `api/index.ts`.
3. **`id` backfill.** For any pre-existing rows that
   predate the `id` column, `UPDATE ... SET id = gen_random_uuid()`.
4. **Defaults / NOT NULL.** `SET DEFAULT gen_random_uuid()` and
   `SET NOT NULL` on `id`, plus `SET DEFAULT` on `created_at`
   / `timestamp` / `role` / `status`. Each step is individually
   wrapped in `BEGIN ... EXCEPTION WHEN others THEN RAISE NOTICE`
   so a step that is already applied doesn't abort the
   transaction.
5. **Primary key (guarded).** If
   `information_schema.table_constraints` shows no PK on the
   table, `ADD PRIMARY KEY (id)`. If a PK already exists on
   some other column, skip (we don't want to fail the whole
   migration because someone's already dropped-and-recreated
   a different PK).
6. **`CHECK` constraints (guarded).** `role IN ('admin','player')`
   on `live_session_players`, `status IN ('pending','approved','rejected')`
   on `live_buy_ins`, added only if an equivalent check is not
   already present.
7. **`UNIQUE(username)` on `live_users`.** Added only if no
   equivalent unique index is present.
8. **Final validation.** A `DO` block iterates over every
   (table, column) in the canonical set and `RAISE EXCEPTION`
   if any are still missing (this rolls back the whole
   transaction). Then `RAISE NOTICE` with a `count(*)` per
   table so the operator sees no rows were lost.

`pgcrypto` is `CREATE EXTENSION IF NOT EXISTS`'d at the top so
`gen_random_uuid()` is guaranteed available.

## How to run

The script is additive and idempotent. Follow this order:

### 1. Take a Neon snapshot

Before any DDL on prod, take a Neon snapshot / branch of the
prod database. This is the rollback plan; see below.

### 2. Dry-run on a Neon preview branch

Create a branch off prod in Neon, point `psql` at its
connection string, and run the script:

```
psql "$NEON_PREVIEW_URL" -v ON_ERROR_STOP=1 -f scripts/heal-live-schema-drift.sql
```

You should see output like:

```
NOTICE:  [heal] live_users BEFORE: id:uuid, name:text, username:text, ...
NOTICE:  [heal] live_session_players BEFORE: session_id:uuid, user_id:uuid, role:text, final_winnings:numeric
NOTICE:  [heal] live_session_players PRIMARY KEY (id) added
NOTICE:  [heal] live_session_players role CHECK already present, skipping
NOTICE:  [heal] live_buy_ins BEFORE: ...
NOTICE:  [heal] VALIDATION OK: all canonical columns present
NOTICE:  [heal] row counts: live_users=<n>, live_session_players=<n>, live_buy_ins=<n>
COMMIT
```

The two signals that the script succeeded:

- The final `VALIDATION OK` notice.
- `COMMIT` at the end (not `ROLLBACK`).

If validation fails, the whole transaction rolls back. The
`RAISE EXCEPTION` message will list the still-missing columns.
Investigate the specific table and re-run.

Exercise the app against the preview branch: hit
`POST /api/live/session/buyin`, create a live session, add a
player. Everything should work with the canonical query paths.

### 3. Run on prod

Same command, prod connection string:

```
psql "$NEON_PROD_URL" -v ON_ERROR_STOP=1 -f scripts/heal-live-schema-drift.sql
```

Confirm the same `VALIDATION OK` notice and `COMMIT`.

### 4. Smoke-test prod

Hit the buy-in endpoint at least once. The `SELECT 1 AS existing`
workaround from PR #10 is still in place, so the handler will
continue to work — but with the schema healed, `SELECT id`
would also work. That is the point of the next step.

### 5. Revert PR #10's workaround

Once prod has been verified, file a follow-up PR that reverts
`SELECT 1 AS existing` back to `SELECT id` in the buy-in
handler. That restores the canonical code path and removes
the comment that pointed at this drift. (Do not revert before
prod is healed — the workaround is belt-and-suspenders while
the script is rolled out.)

## Expected validation output

Healthy run, prod:

```
NOTICE:  [heal] live_users BEFORE: <existing columns>
NOTICE:  [heal] live_session_players BEFORE: session_id:uuid, user_id:uuid, role:text, final_winnings:numeric
NOTICE:  [heal] live_session_players PRIMARY KEY (id) added
NOTICE:  [heal] live_buy_ins BEFORE: <existing columns>
NOTICE:  [heal] VALIDATION OK: all canonical columns present
NOTICE:  [heal] row counts: live_users=<n>, live_session_players=<n>, live_buy_ins=<n>
COMMIT
```

Re-run on an already-healed DB:

```
NOTICE:  [heal] live_users BEFORE: <all canonical columns>
NOTICE:  [heal] live_session_players BEFORE: <all canonical columns>
NOTICE:  [heal] live_session_players already has a PRIMARY KEY, skipping
NOTICE:  [heal] live_session_players role CHECK already present, skipping
NOTICE:  [heal] live_buy_ins BEFORE: <all canonical columns>
NOTICE:  [heal] live_buy_ins already has a PRIMARY KEY, skipping
NOTICE:  [heal] live_buy_ins status CHECK already present, skipping
NOTICE:  [heal] VALIDATION OK: all canonical columns present
NOTICE:  [heal] row counts: ...
COMMIT
```

## Rollback

The script is purely additive:

- `ADD COLUMN IF NOT EXISTS` — never drops a column.
- `SET DEFAULT`, `SET NOT NULL`, `ADD PRIMARY KEY`,
  `ADD CONSTRAINT` — each individually guarded; any that
  fail raise a `NOTICE` but do not roll back.
- The only data write is
  `UPDATE ... SET id = gen_random_uuid() WHERE id IS NULL`,
  which affects only rows that had no `id` to begin with.
  Those rows are unreachable by the app anyway (it queries
  by `id`), so the backfill is safe.

Because every step is idempotent and gated on "does this
already exist?", re-running the script is a no-op. There is
no explicit rollback needed for the heal itself.

If something nevertheless goes sideways on prod — corruption,
unexpected constraint interaction, performance regression —
the Neon snapshot taken in step 1 is the rollback. Restore
from snapshot; no data is lost (the Live tables only hold
in-session state that replays from the app on reconnect).

## Related

- PR #10 (`hotfix/live-session-players-missing-id-column`) —
  the SEV-1 workaround this heal script completes.
- `api/index.ts:101-139` — canonical schema source of truth.
- `scripts/heal-live-schema-drift.sql` — the script itself.
