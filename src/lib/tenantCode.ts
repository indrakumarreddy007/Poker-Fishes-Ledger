// Single source of truth for the browser-side group/tenant code.
//
// The tenancy model (Phase 3) requires every API request to carry a
// short human-readable group code. The code is persisted in
// localStorage so a returning user lands directly in their group.
// The landing page (`GroupLanding`), the App shell, and the fetch
// helpers all go through this module so the storage key is never
// hard-coded in more than one place.
//
// The helpers are defensive: any environment without a functioning
// localStorage (SSR, private-mode Safari edge cases, tests without
// jsdom) degrades to a no-op rather than throwing.

export const TENANT_CODE_KEY = 'tenantCode';

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * Normalise a user-entered group code: trim + uppercase. Returns the
 * normalised code or an empty string for nullish input. We do not
 * reject short/long codes here; the server is authoritative on
 * length and character set.
 */
export function normalizeTenantCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().toUpperCase();
}

/**
 * Read the current tenant code from localStorage. Returns null when
 * nothing is stored or storage is unavailable.
 */
export function getTenantCode(): string | null {
  if (!hasStorage()) return null;
  try {
    const v = window.localStorage.getItem(TENANT_CODE_KEY);
    if (!v) return null;
    const norm = normalizeTenantCode(v);
    return norm || null;
  } catch {
    return null;
  }
}

/**
 * Persist a tenant code. Input is normalised before writing so
 * callers don't have to remember to uppercase. An empty/nullish code
 * is treated as a clear.
 */
export function setTenantCode(code: string | null | undefined): void {
  if (!hasStorage()) return;
  const norm = normalizeTenantCode(code ?? '');
  try {
    if (!norm) {
      window.localStorage.removeItem(TENANT_CODE_KEY);
      return;
    }
    window.localStorage.setItem(TENANT_CODE_KEY, norm);
  } catch {
    // swallow: storage quota / disabled storage should not crash UI.
  }
}

/**
 * Remove the stored tenant code. Safe to call when nothing is set.
 */
export function clearTenantCode(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(TENANT_CODE_KEY);
  } catch {
    // swallow.
  }
}
