// ---------------------------------------------------------------------------
// Tenancy filter safety-net
//
// This test exists because ~30 handlers in api/index.ts each had to be
// hand-edited to add `AND tenant_id = $N` to every SELECT/UPDATE/DELETE
// and `tenant_id` to every INSERT against the nine tenant-scoped tables.
// A future maintainer adding a new query to any of those tables is very
// likely to forget — and forgetting leaks rows across tenants, which is
// the single worst bug this feature can have.
//
// The test is deliberately dumb: it text-scans api/index.ts and asserts
// that every statement touching a tenant-scoped table has a tenant_id
// reference within a few lines. It will occasionally need to be adjusted
// when legitimate exceptions appear (e.g. a subquery nested inside a
// JOIN where the outer WHERE already filters tenant_id). The exception
// list at the bottom documents each accepted exemption.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The nine tables that PR A added `tenant_id UUID` to. Keep in sync with
// scripts/tenancy-phase1-create-tenants-and-backfill.sql.
const TENANT_SCOPED_TABLES = [
  'players',
  'sessions',
  'session_results',
  'settlements',
  'player_aliases',
  'live_users',
  'live_sessions',
  'live_session_players',
  'live_buy_ins',
];

// Statements allowed to lack a tenant_id filter. Listed as substrings
// matched against the context window. Every exemption needs a comment.
const KNOWN_EXEMPTIONS: { reason: string; containsAll: string[] }[] = [
  // The initDB CREATE TABLE + ALTER block runs once at boot and pre-dates
  // the migration that adds tenant_id. It's allowed.
  {
    reason: 'initDB DDL (CREATE TABLE / ALTER TABLE / CREATE INDEX)',
    containsAll: ['CREATE TABLE IF NOT EXISTS'],
  },
  {
    reason: 'initDB ALTER TABLE for live_sessions publish columns',
    containsAll: ['ALTER TABLE live_sessions', 'ADD COLUMN IF NOT EXISTS published_to_ledger'],
  },
];

function readApi(): string {
  const p = resolve(__dirname, '..', 'api', 'index.ts');
  return readFileSync(p, 'utf8');
}

// Find all offsets where a pattern matches. Used so we can grab a context
// window around each match.
function findOffsets(src: string, pattern: RegExp): number[] {
  const offsets: number[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    offsets.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return offsets;
}

// Grab ~6 lines before and ~6 after the match so we catch multi-line
// queries whose WHERE clause is a couple of lines below the FROM.
function contextWindow(src: string, offset: number, radius = 6): string {
  const before = src.lastIndexOf('\n', Math.max(0, offset - 1));
  const start = Math.max(0, src.lastIndexOf('\n', Math.max(0, before - radius * 120)) + 1);
  let end = offset;
  for (let i = 0; i < radius + 2; i++) {
    const next = src.indexOf('\n', end + 1);
    if (next === -1) { end = src.length; break; }
    end = next;
  }
  return src.slice(start, end);
}

function isExempted(window: string): boolean {
  for (const ex of KNOWN_EXEMPTIONS) {
    if (ex.containsAll.every(tok => window.includes(tok))) return true;
  }
  return false;
}

describe('tenancy filter safety-net', () => {
  const src = readApi();

  describe('every SELECT/UPDATE/DELETE touching a tenant-scoped table references tenant_id', () => {
    for (const table of TENANT_SCOPED_TABLES) {
      it(`${table}: FROM|UPDATE|DELETE FROM usages include tenant_id`, () => {
        const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
          `(?:FROM|JOIN|UPDATE|DELETE\\s+FROM)\\s+${esc}\\b`,
          'gi'
        );
        const offsets = findOffsets(src, pattern);
        expect(offsets.length, `expected at least one reference to ${table}`).toBeGreaterThan(0);

        const bad: string[] = [];
        for (const off of offsets) {
          const win = contextWindow(src, off, 7);
          if (isExempted(win)) continue;
          // The window must reference tenant_id. If it doesn't, the query
          // is either cross-tenant (bug) or belongs in KNOWN_EXEMPTIONS.
          if (!/tenant_id/.test(win)) {
            bad.push(`${table} at offset ${off}:\n${win}\n`);
          }
        }
        expect(bad, `missing tenant_id filter near:\n${bad.join('\n---\n')}`).toEqual([]);
      });
    }
  });

  describe('every INSERT INTO tenant-scoped table lists tenant_id as a column', () => {
    for (const table of TENANT_SCOPED_TABLES) {
      it(`${table}: INSERT statements include tenant_id column`, () => {
        const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`INSERT\\s+INTO\\s+${esc}\\s*\\(`, 'gi');
        const offsets = findOffsets(src, pattern);
        const bad: string[] = [];
        for (const off of offsets) {
          // INSERT column list can spill across lines; 4 lines is usually
          // enough, bump if some future INSERT ever gets wider.
          const win = contextWindow(src, off, 4);
          if (isExempted(win)) continue;
          if (!/tenant_id/.test(win)) {
            bad.push(`${table} INSERT at offset ${off}:\n${win}\n`);
          }
        }
        expect(bad, `INSERT missing tenant_id column near:\n${bad.join('\n---\n')}`).toEqual([]);
      });
    }
  });

  describe('middleware wiring', () => {
    it('declares /api/health before resolveTenant so it stays exempt', () => {
      const healthIdx = src.indexOf('app.get("/api/health"');
      const mwIdx = src.indexOf('app.use("/api", resolveTenant)');
      expect(healthIdx, '/api/health route must exist').toBeGreaterThan(-1);
      expect(mwIdx, 'resolveTenant must be mounted').toBeGreaterThan(-1);
      expect(healthIdx).toBeLessThan(mwIdx);
    });

    it('EXEMPT_PATHS covers the health and tenant-resolve endpoints', () => {
      // The middleware mounts on "/api" so Express strips that prefix;
      // EXEMPT_PATHS stores the post-strip form.
      expect(src).toMatch(/EXEMPT_PATHS\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/);
      const m = src.match(/EXEMPT_PATHS\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/);
      expect(m).toBeTruthy();
      const body = m![1];
      expect(body).toContain('/health');
      expect(body).toContain('/tenants/resolve');
    });

    it('POST /api/tenants is exempted by method+path check', () => {
      expect(src).toMatch(/req\.path\s*===\s*"\/tenants"\s*&&\s*req\.method\s*===\s*"POST"/);
    });

    it('resolveTenant reads X-Tenant-Code header', () => {
      expect(src).toMatch(/req\.header\(\s*"X-Tenant-Code"\s*\)/);
    });

    it('resolveTenant returns 401 missing_tenant_code on absent header', () => {
      expect(src).toMatch(/missing_tenant_code/);
      expect(src).toMatch(/invalid_tenant_code/);
    });
  });
});
