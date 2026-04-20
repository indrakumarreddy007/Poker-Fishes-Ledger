<!--
  NOTE FOR MERGE
  --------------
  PR A (tenancy-phase1-migration) is expected to land first and
  populate the top of this file with the Phase 1 + Phase 2 runbook.
  This PR (feat/tenancy-landing-ux) adds only the "Phase 3 — Row-Level
  Security" section below. At merge time, drop this HTML comment and
  concatenate: PR A's Phases 1-2 content, then this Phase 3 section.
-->

# Phase 3 — Row-Level Security

Phase 3 is the defense-in-depth layer on top of Phase 2. Phases 1 and 2
make `tenant_id` mandatory and add composite uniques; Phase 3 asks
Postgres itself to enforce tenant isolation so that even a buggy or
unsafe query written at the application layer cannot leak cross-tenant
rows.

## What RLS guarantees

For every request that executes

```
SET LOCAL app.current_tenant = '<uuid>'
```

at the start of its transaction, Postgres restricts all reads and
writes against the 9 tenant-scoped tables to rows whose `tenant_id`
equals that UUID. A bare `SELECT * FROM players` on such a connection
will only ever return the caller's players — no `WHERE tenant_id = $1`
clause needed.

Guarantees:

- **Defense in depth.** Tenant isolation no longer depends solely on
  every SQL query in the app remembering to filter by `tenant_id`. If
  a new endpoint forgets the filter, RLS still blocks cross-tenant
  rows.
- **Uniform enforcement.** The same policy applies to reads, writes,
  updates, and deletes — including ad-hoc queries via `psql` run under
  a role that does not bypass RLS.
- **Fail-closed.** A connection that never sets `app.current_tenant`
  has `current_setting('app.current_tenant', true)` return `NULL`.
  Comparisons against `NULL::uuid` are never true, so the connection
  sees zero tenant rows. Forgetting to set the GUC does not leak data;
  it just returns an empty result.

Limitations:

- RLS does **not** protect the application-code path that chooses
  which `tenantId` to set on the connection. The middleware that
  resolves `?code=XXX` → `tenant.id` is still the authoritative
  admission control.
- RLS is bypassed by superusers and by table owners (unless the
  tables are set to `FORCE ROW LEVEL SECURITY`). See "Role check"
  below.

## How it is wired on the app side

`api/lib/withTenant.ts` exposes a helper

```ts
await withTenant(pool, req.tenantId, async (client) => {
  // All client.query(...) calls inside this block see only the
  // caller's tenant rows.
});
```

The helper checks out a client, opens an explicit transaction, runs
`SET LOCAL app.current_tenant = $1`, calls the provided function,
commits on success, rolls back on error, and always releases the
client. Engineer B's request-scoped middleware is expected to adopt
this helper (or the equivalent `SET LOCAL` + transaction pattern) at
every point that queries tenant-scoped tables.

## How to run on prod

Run **after** the new application build that sets
`app.current_tenant` on every query has been deployed. Running the
policies before the app is RLS-aware will make every request return
zero rows.

1. **Snapshot:** create a Neon branch `pre-tenancy-phase3` off prod.

2. **Dry-run on a Neon preview branch:**

   ```sh
   psql $PREVIEW_DATABASE_URL -f scripts/tenancy-phase3-rls-policies.sql
   ```

   Confirm the notice `tenancy-phase3 complete. RLS enabled +
   tenant_isolation policy on all 9 tables.`

3. **Role check:** confirm the application role that connects to prod
   is **not** the owner of the tenant-scoped tables (and is not a
   superuser). If it is the owner, either:

   - Reassign ownership to a dedicated `schema_owner` role and run
     the app under a less-privileged role, OR
   - Apply `ALTER TABLE ... FORCE ROW LEVEL SECURITY` to each of the
     9 tables so the policy is enforced even against the owner.

   Run the check with:

   ```sql
   SELECT relname, relrowsecurity, relforcerowsecurity, relowner::regrole
     FROM pg_class
    WHERE relname IN (
      'players', 'sessions', 'session_results', 'settlements',
      'player_aliases', 'live_users', 'live_sessions',
      'live_session_players', 'live_buy_ins'
    );
   ```

4. **Apply the policies on prod:**

   ```sh
   psql $DATABASE_URL -f scripts/tenancy-phase3-rls-policies.sql
   ```

5. **Smoke-test the app under two different tenants** back-to-back.
   Confirm that leaderboards, sessions, live sessions, and settlements
   for tenant A do not show up when the browser has tenant B's code
   set (and vice versa). A leak here indicates the middleware is
   not calling `SET LOCAL app.current_tenant` on the same client as
   the subsequent queries.

6. **Post-deploy spot check:**

   ```sql
   -- Should return 9 rows, all with rowsecurity = t:
   SELECT schemaname, tablename, rowsecurity
     FROM pg_tables
    WHERE tablename IN (
      'players', 'sessions', 'session_results', 'settlements',
      'player_aliases', 'live_users', 'live_sessions',
      'live_session_players', 'live_buy_ins'
    );

   -- Should return 9 rows, all policyname = 'tenant_isolation':
   SELECT tablename, policyname, cmd
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'players', 'sessions', 'session_results', 'settlements',
        'player_aliases', 'live_users', 'live_sessions',
        'live_session_players', 'live_buy_ins'
      );
   ```

## Rollback

RLS rollback is strictly additive — it never modifies data. Use it if
the app cannot reliably set `app.current_tenant` (e.g. a legacy batch
job connects without the middleware) and you need to fall back to
application-layer tenant filtering while the middleware is fixed.

```sh
psql $DATABASE_URL -f scripts/tenancy-phase3-rls-rollback.sql
```

This script drops the `tenant_isolation` policy on each of the 9
tables and disables RLS on each. It is safe to re-run.

After rolling back, Phases 1 and 2 remain in place — `tenant_id` is
still `NOT NULL` and composite uniques still hold. Only the
defense-in-depth layer is removed. The application continues to do
its own `WHERE tenant_id = $1` filtering.

## Landing page + Switch group UX (shipped with Phase 3)

Alongside Phase 3 the app grew a user-visible tenant picker:

- `src/views/GroupLanding.tsx` is rendered at the app root when
  `localStorage.tenantCode` is absent. It has two sections: **Join a
  Group** (hits `GET /api/tenants/resolve?code=XXX`) and **Create a
  New Group** (hits `POST /api/tenants`). On success the code is
  stored in `localStorage` and the page reloads into the main app.
- `src/lib/tenantCode.ts` is the single source of truth for the
  storage key and normalisation (uppercase + trim). Both the App
  shell and future fetch helpers import from here — the string
  `'tenantCode'` lives in exactly one place.
- The App header has a small **Switch Group** link that clears
  `localStorage.tenantCode` and reloads, returning the user to the
  landing page.

These components never talk to Postgres directly; they only know
about the API endpoints owned by Engineer B. Swapping out the storage
mechanism (e.g. to a cookie) would only touch `src/lib/tenantCode.ts`.
