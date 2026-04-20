import type { Pool, PoolClient } from 'pg';

/**
 * withTenant
 * ----------
 * Run `fn` with a dedicated pool client that has the per-transaction GUC
 * `app.current_tenant` set to the caller's tenant UUID. This is the hook
 * the Row-Level Security policies added in
 * `scripts/tenancy-phase3-rls-policies.sql` read, i.e.
 *
 *     USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
 *
 * Usage (from Engineer B's request-scoped middleware):
 *
 *     await withTenant(pool, req.tenantId, async (client) => {
 *       const { rows } = await client.query('SELECT * FROM players');
 *       return rows;
 *     });
 *
 * Why a helper (not inline per-query):
 *   - `SET LOCAL` only persists for the current transaction. If we issue a
 *     bare `SET LOCAL` outside a BEGIN..COMMIT block, it applies to
 *     whatever implicit transaction the next statement opens -- fragile.
 *     This helper wraps fn in an explicit BEGIN..COMMIT so the scope of
 *     the GUC is unambiguous.
 *   - It guarantees a single client is used for the whole request-scoped
 *     unit of work, so every query sees the same GUC.
 *   - It guarantees the client is released even on error, and the tx is
 *     rolled back if fn throws.
 *
 * Validation of `tenantId`:
 *   - We interpolate the uuid via the parameterised query interface to
 *     avoid any risk of SQL injection -- never concatenated into the
 *     command text.
 *
 * Coordination note for Engineer B:
 *   The existing middleware added in PR B likely opens a bare
 *   `pool.query(...)`. That path needs to be updated to go through this
 *   helper (or at minimum to run `SET LOCAL app.current_tenant` on the
 *   same client inside the same transaction as the subsequent queries).
 *   A follow-up commit is expected to rewire the existing call sites.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw new Error('withTenant: tenantId is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised so uuid casting happens server-side and no
    // string-concat ever touches the SQL command.
    await client.query('SET LOCAL app.current_tenant = $1', [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort rollback; original error takes precedence.
    }
    throw err;
  } finally {
    client.release();
  }
}
